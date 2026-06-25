import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  PLAN_CATALOG,
  REFERRAL_BONUS_MICRODOLLARS,
  REFERRAL_LINK_BASE,
  attachmentUploadSchema,
  autoReloadSettingsSchema,
  chatSendSchema,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  summarizeRecordingRequestSchema,
  tokenPackGrant,
  topupSchema,
  type ConversationSummary,
  type ReferralInfo,
  type RunStepResponse,
  type SubscriptionState
} from "@workcrew/contracts";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { ZodError } from "zod";
import { authenticate } from "./auth.js";
import {
  localAuthProvider,
  refreshInputSchema,
  resetConfirmInputSchema,
  resetInputSchema,
  signInInputSchema,
  signOutInputSchema,
  signUpInputSchema,
  verifyTokenSchema
} from "./auth-local.js";
import { simulatedBillingProvider } from "./billing-simulated.js";
import {
  actionSignature,
  actualCostMicrodollars,
  callModel,
  chooseModel,
  maximumReservationMicrodollars,
  modelRequestPayload,
  summarizeRecording
} from "./anthropic.js";
import { processAndStoreAttachment } from "./attachments.js";
import { changePlan, createCheckout, createPortal, createTopupCheckout, handleStripeWebhook } from "./billing.js";
import { landingPage } from "./landing.js";
import { creditReferralOnPayment, getBudgetUsage, getBudgetWindow, getTopupThisPeriod, grantTokenCredit, planBudget, planLimits, releaseBudget, reserveBudget, rollingUsage, settleBudget, tokenPackCharge } from "./budget.js";
import { DAY_MS, FIVE_HOUR_MS } from "@workcrew/contracts";
import { streamChat } from "./chat.js";
import { config } from "./config.js";
import {
  client,
  countReferrals,
  createRun,
  deleteConversation,
  ensureReferralCode,
  getConversation,
  getMessages,
  getRun,
  getSubscription,
  getUserById,
  initializeDatabase,
  listConversations,
  setAutoReloadConfig,
  updateRun,
  type SubscriptionRow
} from "./db.js";

/** Application version reported on /health for diagnostics. */
const APP_VERSION = "0.1.3";

/**
 * Maximum number of model planning steps a single run may consume. The desktop
 * client caps its own loop at 24, but a malicious or buggy client could bypass
 * that, so the server enforces the same ceiling authoritatively.
 */
const MAX_RUN_STEPS = 24;

/**
 * Number of consecutive identical assistant actions (same tool plus same
 * normalized input) that ends a run as a loop. The third identical action in a
 * row trips this and stops further budget spend.
 */
const MAX_REPEATED_ACTIONS = 3;

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: 256 * 1024,
  requestTimeout: 70_000,
  trustProxy: config.nodeEnv === "production"
});

await app.register(helmet, { global: true });
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  ban: 3,
  keyGenerator: (request) => request.headers.authorization?.slice(-24) ?? request.ip
});
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error("Origin is not allowed"), false);
  },
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["authorization", "content-type", "stripe-signature"],
  maxAge: 600
});
await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: false,
  runFirst: true
});

function requireActive(subscription: SubscriptionRow | null): SubscriptionRow {
  if (!subscription?.active || subscription.currentPeriodEndMs <= Date.now()) {
    throw Object.assign(new Error("An active paid subscription is required"), { statusCode: 402, code: "SUBSCRIPTION_REQUIRED" });
  }
  return subscription;
}

async function subscriptionState(userId: string): Promise<SubscriptionState> {
  const subscription = await getSubscription(userId);
  if (!subscription) {
    return {
      active: false,
      plan: null,
      interval: null,
      status: "none",
      currentPeriodEnd: null,
      budgetPeriodStart: null,
      budgetPeriodEnd: null,
      budgetMicrodollars: 0,
      usedMicrodollars: 0,
      reservedMicrodollars: 0,
      fiveHourLimitMicrodollars: 0,
      fiveHourUsedMicrodollars: 0,
      dailyLimitMicrodollars: 0,
      dailyUsedMicrodollars: 0,
      purchasedMicrodollars: 0,
      topupSpentMicrodollars: 0,
      monthlyTopupLimitMicrodollars: 0,
      autoReloadEnabled: false,
      autoReloadPack: "small",
      hasPaymentMethod: false
    };
  }
  const nowMs = Date.now();
  const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
  const limits = planLimits(subscription.plan);
  const [usage, topup, fiveHourUsed, dailyUsed] = await Promise.all([
    getBudgetUsage(userId, window),
    getTopupThisPeriod(userId, window),
    rollingUsage(userId, nowMs - FIVE_HOUR_MS),
    rollingUsage(userId, nowMs - DAY_MS)
  ]);
  // Purchased top-up tokens lower the period's used total (they are settled credit
  // rows). Add them back into the reported "used" so the user sees the real model
  // usage, with the purchased tokens shown separately as extra allowance.
  return {
    active: subscription.active && subscription.currentPeriodEndMs > Date.now(),
    plan: subscription.plan,
    interval: subscription.interval,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.currentPeriodEndMs).toISOString(),
    budgetPeriodStart: new Date(window.startMs).toISOString(),
    budgetPeriodEnd: new Date(window.endMs).toISOString(),
    budgetMicrodollars: planBudget(subscription.plan) + topup.purchased,
    usedMicrodollars: usage.used + topup.purchased,
    reservedMicrodollars: usage.reserved,
    fiveHourLimitMicrodollars: limits.fiveHour,
    fiveHourUsedMicrodollars: fiveHourUsed,
    dailyLimitMicrodollars: limits.daily,
    dailyUsedMicrodollars: dailyUsed,
    purchasedMicrodollars: topup.purchased,
    topupSpentMicrodollars: topup.autoReloaded,
    monthlyTopupLimitMicrodollars: subscription.monthlyTopupLimitMicro,
    autoReloadEnabled: subscription.autoReloadEnabled,
    autoReloadPack: (["small", "medium", "large"] as const).includes(subscription.autoReloadPack as "small") ? (subscription.autoReloadPack as "small" | "medium" | "large") : "small",
    hasPaymentMethod: Boolean(subscription.stripePaymentMethodId)
  };
}

app.get("/health", async () => ({
  ok: true,
  service: "workcrew-api",
  version: APP_VERSION,
  mode: config.mockAi ? "mock" : "live",
  authMode: config.authMode,
  billingMode: config.billingMode,
  // Whether real email sending is configured on this running instance. "resend"
  // means RESEND_API_KEY is live; "console" means it is not picked up yet and
  // emails are only logged, not sent.
  emailMode: config.resendApiKey ? "resend" : "console",
  emailFromDomain: config.emailFrom.replace(/^.*@/, "").replace(/>?\s*$/, "")
}));

// Public marketing and download page at the root. Inline style and script need a
// relaxed per-response CSP, distinct from the strict global one.
app.get("/", async (_request, reply) => {
  void reply
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:")
    .type("text/html")
    .send(landingPage(config.downloadUrl));
});

// Stripe redirects the browser here after checkout. Plain web pages (not a
// workcrew:// deep link), so there is no OS launch error. The desktop re-checks
// the subscription when the user switches back to it.
function billingResultPage(reply: import("fastify").FastifyReply, title: string, body: string): void {
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f1e1d;color:#e8e6e3;font-family:Segoe UI,Arial,sans-serif}
.card{width:min(440px,92vw);text-align:center;background:#262523;border:1px solid #3a3836;border-radius:16px;padding:32px}
.brand{color:#a78bfa;font-weight:700;margin-bottom:12px}h1{font-size:22px;margin:0 0 10px}p{color:#c9c6c2;line-height:1.6}</style></head>
<body><div class="card"><div class="brand">WorkCrew</div>${body}</div></body></html>`;
  void reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").type("text/html").send(page);
}

app.get("/billing/success", async (_request, reply) => {
  billingResultPage(reply, "Payment complete", "<h1>You're all set</h1><p>Your subscription is active. Switch back to the WorkCrew app to start, it updates automatically. You can close this tab.</p>");
});

app.get("/billing/cancel", async (_request, reply) => {
  billingResultPage(reply, "Checkout canceled", "<h1>Checkout canceled</h1><p>No charge was made. Switch back to the WorkCrew app to try again. You can close this tab.</p>");
});

// ---------------------------------------------------------------------------
// Authentication routes (public, pre-auth). These are never behind the
// entitlement guard. The local provider is real auth; a Supabase provider can
// be swapped in behind the same routes later.
// ---------------------------------------------------------------------------

// Tight per-route limits on the credential and email endpoints, keyed by IP
// (these requests carry no Authorization header, so the global keyGenerator
// falls back to request.ip). This is the brute-force and email-spam guard that
// the broad global limit is too loose to provide.
const authLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

app.post("/v1/auth/sign-up", authLimit(8), async (request) => {
  const body = signUpInputSchema.parse(request.body);
  return localAuthProvider.signUp(body.email, body.password, body.referralCode);
});

app.post("/v1/auth/sign-in", authLimit(10), async (request) => {
  const body = signInInputSchema.parse(request.body);
  return { session: await localAuthProvider.signIn(body.email, body.password) };
});

app.post("/v1/auth/refresh", async (request) => {
  const body = refreshInputSchema.parse(request.body);
  return { session: await localAuthProvider.refresh(body.refreshToken) };
});

app.post("/v1/auth/sign-out", async (request) => {
  const body = signOutInputSchema.parse(request.body);
  await localAuthProvider.signOut(body.refreshToken);
  return { ok: true };
});

app.post("/v1/auth/reset", authLimit(6), async (request) => {
  // Always returns ok so the response never reveals whether the email exists.
  const body = resetInputSchema.parse(request.body);
  await localAuthProvider.reset(body.email);
  return { ok: true };
});

app.post("/v1/auth/reset-confirm", authLimit(12), async (request) => {
  const body = resetConfirmInputSchema.parse(request.body);
  try {
    await localAuthProvider.confirmReset(body.token, body.password);
    return { ok: true };
  } catch (error) {
    console.error("[WorkCrew] /v1/auth/reset-confirm failed:", error instanceof Error ? error.message : String(error));
    throw error;
  }
});

// A small HTML page served by the backend (opened from an email link). Inline
// style and script are required, so a relaxed per-response CSP overrides the
// strict global one for just these pages.
function sendHtml(reply: import("fastify").FastifyReply, title: string, body: string): void {
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f1e1d;color:#e8e6e3;font-family:Segoe UI,Arial,sans-serif}
.card{width:min(420px,92vw);background:#262523;border:1px solid #3a3836;border-radius:16px;padding:28px}
.brand{color:#a78bfa;font-weight:700;margin-bottom:12px}h1{font-size:20px;margin:0 0 10px}
p{color:#c9c6c2;line-height:1.6;font-size:14px}
input{width:100%;box-sizing:border-box;margin:10px 0;padding:12px 14px;border:1px solid #3a3836;border-radius:10px;background:#1f1e1d;color:#e8e6e3;font-size:14px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.ok{color:#4caf7d}.err{color:#d98a93}</style></head><body><div class="card"><div class="brand">WorkCrew</div>${body}</div></body></html>`;
  void reply
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'")
    .type("text/html")
    .send(page);
}

app.get<{ Querystring: { token?: string } }>("/v1/auth/verify", authLimit(12), async (request, reply) => {
  const token = typeof request.query.token === "string" ? request.query.token : "";
  try {
    verifyTokenSchema.parse({ token });
    await localAuthProvider.verifyEmail(token);
    sendHtml(reply, "Email verified", `<h1>Email verified</h1><p class="ok">Your email is confirmed. Return to WorkCrew and sign in.</p>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "This link is invalid.";
    sendHtml(reply, "Verification failed", `<h1>Verification failed</h1><p class="err">${message.replace(/[<>&]/g, "")}</p>`);
  }
});

app.get<{ Querystring: { token?: string } }>("/reset", async (request, reply) => {
  const token = typeof request.query.token === "string" ? request.query.token : "";
  sendHtml(reply, "Reset password", `<h1>Choose a new password</h1>
<p>Enter a new password with at least 10 characters.</p>
<input id="pw" type="password" placeholder="New password" autocomplete="new-password">
<button id="go">Set new password</button>
<p id="msg"></p>
<script>
const token=${JSON.stringify(token)};
const pw=document.getElementById('pw'),go=document.getElementById('go'),msg=document.getElementById('msg');
async function submit(attempt){
  var r=await fetch('/v1/auth/reset-confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,password:pw.value})});
  if(r.ok){msg.textContent='✓ Your password is updated. Return to WorkCrew and sign in.';msg.className='ok';pw.disabled=true;go.style.display='none';return;}
  if(r.status>=500&&attempt<1){msg.textContent='Working on it...';msg.className='';return submit(attempt+1);}
  var d=await r.json().catch(function(){return {};});
  if(r.status>=500){msg.textContent='Something went wrong on our side. Please wait a minute and try again.';}
  else{msg.textContent=(d&&d.error)||'That link is invalid or has expired. Open the app and request a new one.';}
  msg.className='err';go.disabled=false;
}
go.onclick=async function(){
  if(pw.value.length<10){msg.textContent='Use a password with at least 10 characters.';msg.className='err';return;}
  go.disabled=true;msg.textContent='Saving...';msg.className='';
  try{await submit(0);}catch(e){msg.textContent='Could not reach the server. Check your connection and try again.';msg.className='err';go.disabled=false;}
};
</script>`);
});

app.get("/v1/entitlement", async (request) => subscriptionState(await authenticate(request)));

// A signed-in user's referral standing: their code, a shareable link, how many
// people they have invited, how many have paid, and the bonus earned so far.
// Available to any signed-in user (even before they subscribe) so they can start
// inviting; a legacy account without a code is assigned one on first read.
app.get("/v1/referral", async (request): Promise<ReferralInfo> => {
  const userId = await authenticate(request);
  const code = await ensureReferralCode(userId);
  const stats = await countReferrals(code);
  const user = await getUserById(userId);
  return {
    code,
    link: `${REFERRAL_LINK_BASE}/?ref=${code}`,
    invitedCount: stats.invited,
    creditedCount: stats.credited,
    bonusMicrodollars: user?.referralBonusMicrodollars ?? 0
  };
});

// Turn a click recording into one reusable, generalized task instruction. The
// desktop records a readable trace of what the user did (elements, typed text,
// pages/windows) and posts it here; the model writes a single instruction that
// the normal automation loop can run and adapt on every routine run. Requires a
// signed-in user; the call is a small one-shot summarization.
app.post("/v1/recordings/summarize", authLimit(20), async (request) => {
  // Gate like the other paid routes: a real (Haiku) model call happens here, so
  // only an active subscriber may use it, and a tight per-route limit bounds spend
  // beyond the loose global limit.
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = summarizeRecordingRequestSchema.parse(request.body);
  const task = await summarizeRecording(body.surface, body.events);
  return { task };
});

// Simulated checkout. Requires authentication, is allowed only when the
// simulated billing mode is selected, and never in production. It writes an
// active, Stripe-shaped entitlement through the same upsert path the real
// Stripe webhook uses, then returns the resulting entitlement state.
app.post("/v1/billing/simulate", async (request) => {
  const userId = await authenticate(request);
  if (config.billingMode !== "simulated" || config.nodeEnv === "production") {
    throw Object.assign(new Error("Simulated billing is disabled"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const body = createCheckoutSchema.parse(request.body);
  await simulatedBillingProvider.activate(userId, body.plan, body.interval);
  // First paid activation grants the inviter their one-time referral bonus (idempotent).
  await creditReferralOnPayment(userId, REFERRAL_BONUS_MICRODOLLARS);
  return subscriptionState(userId);
});

app.post("/v1/billing/checkout", async (request) => {
  const userId = await authenticate(request);
  const body = createCheckoutSchema.parse(request.body);
  return { url: await createCheckout(userId, body.plan, body.interval) };
});

// Change the plan of an existing active subscription in place (Pro to Ultra),
// rather than opening a second checkout. Returns the updated entitlement so the
// app reflects the new plan immediately.
app.post("/v1/billing/change-plan", async (request) => {
  const userId = await authenticate(request);
  const body = createCheckoutSchema.parse(request.body);
  await changePlan(userId, body.plan, body.interval);
  return subscriptionState(userId);
});

app.post("/v1/billing/portal", async (request) => ({ url: await createPortal(await authenticate(request)) }));

// Buy a one-time token pack. In live billing this returns a hosted Stripe
// Checkout URL the app opens; in simulated billing it grants the tokens with no
// charge and returns the refreshed entitlement, so the whole flow is testable.
app.post("/v1/billing/topup", async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = topupSchema.parse(request.body);
  if (config.billingMode === "stripe") {
    return { url: await createTopupCheckout(userId, body.pack) };
  }
  await grantTokenCredit({
    userId,
    grantedMicrodollars: tokenPackGrant(body.pack),
    chargedMicrodollars: tokenPackCharge(body.pack),
    source: "token_topup"
  });
  return subscriptionState(userId);
});

// Save auto-reload preferences (enable/disable, which pack, and the per-period
// token cap on automatic spending). Returns the refreshed entitlement.
app.post("/v1/billing/auto-reload", async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = autoReloadSettingsSchema.parse(request.body);
  await setAutoReloadConfig(userId, {
    enabled: body.enabled,
    pack: body.pack,
    monthlyLimitMicro: body.monthlyLimitMicrodollars
  });
  return subscriptionState(userId);
});

app.post("/v1/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
  const signature = request.headers["stripe-signature"];
  const body = (request as typeof request & { rawBody?: Buffer }).rawBody;
  if (typeof signature !== "string" || !body) return reply.code(400).send({ error: "Invalid webhook" });
  await handleStripeWebhook(body, signature);
  return { received: true };
});

app.post("/v1/runs", async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = createRunSchema.parse(request.body);
  const id = randomUUID();
  await createRun({
    id,
    userId,
    model: body.model,
    status: "ready",
    messages: [{ role: "user", content: body.task }],
    pendingToolUseId: null,
    stepCount: 0,
    lastActionSignature: null,
    repeatCount: 0,
    tokensInput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensOutput: 0
  });
  return { runId: id, status: "ready" };
});

app.post<{ Params: { runId: string } }>("/v1/runs/:runId/next", async (request): Promise<RunStepResponse> => {
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = nextRunStepSchema.parse(request.body ?? {});
  const run = await getRun(request.params.runId, userId);
  if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404, code: "RUN_NOT_FOUND" });
  if (run.status === "complete") return { runId: run.id, status: "complete", message: "This run is already complete." };
  if (run.status === "failed") {
    return { runId: run.id, status: "failed", message: "This run has already stopped and cannot continue." };
  }

  if (run.pendingToolUseId) {
    if (!body.result || body.result.toolUseId !== run.pendingToolUseId) {
      throw Object.assign(new Error("The expected tool result was not supplied"), { statusCode: 409, code: "TOOL_RESULT_REQUIRED" });
    }
    run.messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: body.result.toolUseId,
        is_error: !body.result.ok,
        content: body.result.output
      }]
    });
    run.pendingToolUseId = null;
  } else if (body.result) {
    throw Object.assign(new Error("This run is not waiting for a tool result"), { statusCode: 409, code: "UNEXPECTED_TOOL_RESULT" });
  }

  // Enforce the server side step ceiling before spending any budget. This is
  // authoritative even when a client ignores its own limit.
  if (run.stepCount >= MAX_RUN_STEPS) {
    run.status = "failed";
    await updateRun(run);
    return {
      runId: run.id,
      status: "failed",
      message: `This run stopped after reaching the safety limit of ${MAX_RUN_STEPS} steps.`
    };
  }
  run.stepCount += 1;

  const originalTask = String((run.messages[0] as { content?: unknown } | undefined)?.content ?? "");
  const tier = chooseModel(run.model, originalTask);
  const maxOutputTokens = 1_200;
  const payload = modelRequestPayload(run.messages, tier, maxOutputTokens);
  const reservationAmount = maximumReservationMicrodollars(tier, payload, maxOutputTokens);
  const reservation = await reserveBudget({
    subscription,
    runId: run.id,
    model: tier,
    amountMicrodollars: reservationAmount
  });

  try {
    const result = await callModel({ tier, messages: run.messages, maxOutputTokens });
    const actualCost = actualCostMicrodollars(tier, result.usage);
    if (actualCost > reservationAmount) {
      throw Object.assign(new Error("Provider usage exceeded the reserved maximum"), {
        code: "USAGE_RESERVATION_BREACH",
        actualCost,
        providerRequestId: result.providerRequestId
      });
    }
    await settleBudget(reservation.reservationId, actualCost, result.providerRequestId);
    run.messages.push({ role: "assistant", content: result.content });

    // Token instrumentation. Accumulate the raw token categories on the run and
    // log this step plus the running total, so prompt-cache effectiveness
    // (cacheRead growing while input stays small) and per-run usage are visible
    // without re-deriving them from the cost ledger.
    run.tokensInput += result.usage.input_tokens;
    run.tokensCacheRead += result.usage.cache_read_input_tokens;
    run.tokensCacheWrite += result.usage.cache_creation_input_tokens;
    run.tokensOutput += result.usage.output_tokens;
    request.log.info({
      runId: run.id,
      step: run.stepCount,
      tier,
      stepTokens: {
        input: result.usage.input_tokens,
        cacheRead: result.usage.cache_read_input_tokens,
        cacheWrite: result.usage.cache_creation_input_tokens,
        output: result.usage.output_tokens
      },
      runTokens: {
        input: run.tokensInput,
        cacheRead: run.tokensCacheRead,
        cacheWrite: run.tokensCacheWrite,
        output: run.tokensOutput
      }
    }, "automation step token usage");

    // Loop protection. A finish action ends the run and is never a loop. For
    // any other action, compare its normalized signature with the previous one
    // and stop the run when the same action repeats too many times in a row
    // instead of spending more budget on the next step.
    const signature = actionSignature(result.action);
    if (result.action.kind !== "finish") {
      run.repeatCount = signature === run.lastActionSignature ? run.repeatCount + 1 : 1;
      run.lastActionSignature = signature;
    }
    const usage = await getBudgetUsage(userId, reservation.window);
    const usagePayload = {
      usedMicrodollars: usage.used,
      budgetMicrodollars: PLAN_CATALOG[subscription.plan].monthlyApiBudgetMicrodollars
    };

    if (result.action.kind !== "finish" && run.repeatCount >= MAX_REPEATED_ACTIONS) {
      run.status = "failed";
      run.pendingToolUseId = null;
      await updateRun(run);
      return {
        runId: run.id,
        status: "failed",
        message: `This run stopped after repeating the same action ${MAX_REPEATED_ACTIONS} times in a row (loop detected).`,
        usage: usagePayload
      };
    }

    run.pendingToolUseId = result.action.kind === "finish" ? null : result.toolUseId ?? null;
    run.status = result.action.kind === "finish" ? "complete" : "awaiting_tool";
    if (run.status === "complete") {
      request.log.info({
        runId: run.id,
        steps: run.stepCount,
        runTokens: {
          input: run.tokensInput,
          cacheRead: run.tokensCacheRead,
          cacheWrite: run.tokensCacheWrite,
          output: run.tokensOutput
        }
      }, "automation run complete: total token usage");
    }
    await updateRun(run);
    return {
      runId: run.id,
      status: result.action.kind === "finish" ? "complete" : "awaiting_tool",
      action: result.action,
      toolUseId: result.toolUseId,
      message: result.action.kind === "finish" ? result.action.summary : undefined,
      usage: usagePayload
    };
  } catch (error) {
    if ((error as { code?: string }).code === "USAGE_RESERVATION_BREACH") {
      // The model finished but reported usage above the reserved maximum. Charge
      // the real cost (settleBudget clamps it to the reservation) so a genuine
      // overage is still billed at the ceiling.
      const actualCost = (error as { actualCost?: number }).actualCost ?? reservationAmount;
      await settleBudget(reservation.reservationId, actualCost, (error as { providerRequestId?: string }).providerRequestId);
    } else {
      // A genuine failure (model or network error) produced no trustworthy
      // usage. Release the hold so a failed turn is never billed and cannot eat
      // into the user's hard 5-hour, daily, or monthly caps.
      await releaseBudget(reservation.reservationId);
    }
    run.status = "failed";
    await updateRun(run);
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Attachment upload. The desktop reads a file locally and posts its bytes as
// base64; the backend validates, decodes, stores, and returns a reference the
// desktop attaches to its next chat turn. A larger body limit applies to this
// route only, since the global limit is sized for small JSON payloads.
// ---------------------------------------------------------------------------

app.post("/v1/attachments", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = attachmentUploadSchema.parse(request.body);
  return processAndStoreAttachment({
    userId,
    conversationId: body.conversationId,
    filename: body.filename,
    mimeType: body.mimeType,
    base64: body.base64
  });
});

// ---------------------------------------------------------------------------
// Chat routes. POST /v1/chat streams Server Sent Events, the conversation
// routes back the Recents list and reload.
// ---------------------------------------------------------------------------

app.post("/v1/chat", async (request, reply) => {
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = chatSendSchema.parse(request.body);

  // Set the SSE headers and take over the raw response. Each frame is written as
  // a single `data: <json>` line followed by a blank line, which is the shared
  // wire contract the desktop is built against.
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  // Stop iterating as soon as the client hangs up so we do not keep spending on
  // a stream nobody is reading. The abort signal tears down the upstream model
  // stream too, so token billing stops, not just the writes to this socket.
  let clientGone = false;
  const controller = new AbortController();
  const onClose = (): void => {
    clientGone = true;
    controller.abort();
  };
  reply.raw.on("close", onClose);

  try {
    for await (const frame of streamChat({ userId, subscription, body, signal: controller.signal })) {
      if (clientGone) break;
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  } catch (error) {
    // streamChat is contracted to yield an error frame rather than throw, but if
    // anything still escapes we emit a final error frame so the client is never
    // left hanging on an open stream.
    if (!clientGone) {
      const message = error instanceof Error ? error.message : "The chat request could not be completed";
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    }
    request.log.error({ err: error }, "Chat stream failed");
  } finally {
    reply.raw.off("close", onClose);
    if (!clientGone) reply.raw.end();
  }

  // Tell Fastify the reply has already been handled on the raw socket.
  return reply;
});

app.get("/v1/conversations", async (request) => {
  const userId = await authenticate(request);
  const conversations = await listConversations(userId);
  const summaries: ConversationSummary[] = conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    createdAtMs: conversation.createdAtMs,
    updatedAtMs: conversation.updatedAtMs,
    projectId: conversation.projectId
  }));
  return { conversations: summaries };
});

app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (request) => {
  const userId = await authenticate(request);
  const conversation = await getConversation(request.params.id, userId);
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  const stored = await getMessages(conversation.id);
  const messages = stored.map((message) => ({
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    contentJson: message.content,
    createdAtMs: message.createdAtMs
  }));
  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      createdAtMs: conversation.createdAtMs,
      updatedAtMs: conversation.updatedAtMs,
      projectId: conversation.projectId
    },
    messages
  };
});

app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request) => {
  const userId = await authenticate(request);
  const removed = await deleteConversation(request.params.id, userId);
  if (!removed) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  return { ok: true };
});

app.setErrorHandler((error, request, reply) => {
  const statusCode = error instanceof ZodError ? 400 : Number((error as { statusCode?: number }).statusCode ?? 500);
  const code = error instanceof ZodError ? "INVALID_REQUEST" : String((error as { code?: string }).code ?? "INTERNAL_ERROR");
  if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
  else request.log.info({ code, path: request.url }, "Request rejected");
  void reply.code(statusCode).send({
    error: statusCode >= 500 ? "The service could not complete the request" : error instanceof Error ? error.message : "The request was rejected",
    code,
    details: error instanceof ZodError ? error.issues : undefined
  });
});

await initializeDatabase();

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await app.listen({ port: config.port, host: config.host });
  // Keep a connection warm so an idle pooler does not leave the first real
  // request paying a reconnect. A light query every few minutes is enough.
  if (config.databaseUrl) {
    setInterval(() => {
      void client.execute("SELECT 1").catch((error) => {
        console.warn("[WorkCrew] keep-warm ping failed (will retry):", error instanceof Error ? error.message : error);
      });
    }, 4 * 60 * 1000).unref();
  }
}

export { app };
