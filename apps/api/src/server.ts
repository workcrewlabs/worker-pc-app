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
  chatSendSchema,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  summarizeRecordingRequestSchema,
  type ConversationSummary,
  type ReferralInfo,
  type RunStepResponse,
  type SubscriptionState
} from "@workcrew/contracts";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { z, ZodError } from "zod";
import { authenticate, resolveUserId } from "./auth.js";
import {
  localAuthProvider,
  refreshInputSchema,
  resendVerificationInputSchema,
  resetConfirmInputSchema,
  resetInputSchema,
  signInInputSchema,
  signOutInputSchema,
  signUpInputSchema,
  verifyTokenSchema
} from "./auth-local.js";
import { simulatedBillingProvider } from "./billing-simulated.js";
import {
  MODEL_PRICES,
  actionSignature,
  actualCostMicrodollars,
  budgetLimitedOutputTokens,
  callModel,
  chooseModel,
  estimatedInputMicrodollars,
  maximumReservationMicrodollars,
  modelRequestPayload,
  summarizeRecording
} from "./anthropic.js";
import { processAndStoreAttachment } from "./attachments.js";
import { cancelSubscriptionForDeletion, changePlan, createCheckout, createPortal, handleStripeWebhook } from "./billing.js";
import { landingPage } from "./landing.js";
import { budgetHeadroom, creditReferralOnPayment, getBudgetUsage, getBudgetWindow, planBudget, planLimits, releaseBudget, reserveBudget, rollingSettledUsage, settleBudget } from "./budget.js";
import { DAY_MS } from "@workcrew/contracts";
import { streamChat } from "./chat.js";
import { config } from "./config.js";
import { captureAnonymous, captureEvent, safeErrorCategory } from "./analytics.js";
import {
  client,
  countReferrals,
  createRun,
  deleteAccount,
  deleteConversation,
  ensureReferralCode,
  getConversation,
  getMessages,
  getRun,
  getSubscription,
  getUserById,
  initializeDatabase,
  listConversations,
  setUserName,
  updateRun,
  type SubscriptionRow
} from "./db.js";

/** Application version reported on /health for diagnostics. */
const APP_VERSION = "0.1.7";

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
  logger: {
    level: config.logLevel,
    // Redact secret-bearing query params from request logs. Password-reset and
    // email-verification links carry the raw token in the URL; Fastify's default
    // request logging would otherwise write that live bearer token into the logs
    // (and any log drain), where anyone with read access could complete a reset.
    serializers: {
      req(request: { method?: string; url?: string; ip?: string; host?: string; hostname?: string; socket?: { remotePort?: number } }) {
        const url = typeof request.url === "string"
          ? request.url.replace(/([?&](?:token|access_token|refresh_token)=)[^&]+/gi, "$1[REDACTED]")
          : request.url;
        return { method: request.method, url, host: request.host ?? request.hostname, remoteAddress: request.ip, remotePort: request.socket?.remotePort };
      }
    }
  },
  bodyLimit: 256 * 1024,
  requestTimeout: 70_000,
  // Trust a FIXED number of proxy hops in production (Render's load balancer),
  // not boolean true. With true, request.ip is taken from the leftmost,
  // client-supplied X-Forwarded-For entry and can be spoofed to mint fresh
  // rate-limit buckets. A hop count makes request.ip the real client address.
  // Configurable in case the proxy topology changes; defaults to one hop.
  trustProxy: config.nodeEnv === "production" ? config.trustedProxyHops : false
});

await app.register(helmet, { global: true });

// Resolve the authenticated user id BEFORE the rate limiter runs, so the limiter
// keys on the verified subject (which a user cannot rotate) rather than on the
// raw, client-controlled Authorization header. Registered before the rate-limit
// plugin so this onRequest hook runs first. It never rejects; route handlers do
// the authoritative auth check.
app.addHook("onRequest", async (request) => {
  try {
    request.authUserId = await resolveUserId(request);
  } catch {
    request.authUserId = null;
  }
});
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  ban: 3,
  // Authenticated requests are bucketed per verified user; everything else
  // (sign-in, sign-up, reset, and any request with a missing/invalid token)
  // falls back to the real client IP. A junk Authorization header therefore
  // cannot create a fresh bucket: it resolves to null and is keyed on IP.
  keyGenerator: (request) => (request.authUserId ? `u:${request.authUserId}` : request.ip)
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
      dailyLimitMicrodollars: 0,
      dailyUsedMicrodollars: 0,
      pendingPlan: null,
      pendingInterval: null,
      pendingEffective: null
    };
  }
  const nowMs = Date.now();
  const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
  const limits = planLimits(subscription.plan);
  const [usage, dailyUsed] = await Promise.all([
    getBudgetUsage(userId, window),
    // Display the settled (real) daily spend only, not in-flight reservations, so
    // the shown number moves as cost lands and never flickers between "low" and
    // "limit reached" while a turn's worst-case reservation is held then settled.
    rollingSettledUsage(userId, nowMs - DAY_MS)
  ]);
  return {
    active: subscription.active && subscription.currentPeriodEndMs > Date.now(),
    plan: subscription.plan,
    interval: subscription.interval,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.currentPeriodEndMs).toISOString(),
    budgetPeriodStart: new Date(window.startMs).toISOString(),
    budgetPeriodEnd: new Date(window.endMs).toISOString(),
    budgetMicrodollars: planBudget(subscription.plan),
    usedMicrodollars: usage.used,
    reservedMicrodollars: usage.reserved,
    dailyLimitMicrodollars: limits.daily,
    dailyUsedMicrodollars: dailyUsed,
    pendingPlan: subscription.pendingPlan,
    pendingInterval: subscription.pendingInterval,
    pendingEffective: subscription.pendingEffectiveMs ? new Date(subscription.pendingEffectiveMs).toISOString() : null
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
// A stricter per-route limit than the broad global 120/min. The global
// keyGenerator buckets pre-auth requests (sign-in/up/reset, which carry no valid
// token) by client IP, and authenticated requests by the verified user id, so
// these caps are the real brute-force, email-spam, and expensive-action guards.
const routeLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });
const authLimit = routeLimit;

// Request body for updating the signed-in user's display name. Empty clears it.
const updateProfileSchema = z.object({ name: z.string().trim().max(120) }).strict();

app.post("/v1/auth/sign-up", authLimit(8), async (request) => {
  const body = signUpInputSchema.parse(request.body);
  return localAuthProvider.signUp(body.email, body.password, body.referralCode, body.name);
});

// Update the signed-in user's display name (shown in the app's account area).
// Existing users who signed up before names were collected use this to set one.
app.post("/v1/profile", routeLimit(20), async (request) => {
  const userId = await authenticate(request);
  const body = updateProfileSchema.parse(request.body);
  const name = body.name.trim().length > 0 ? body.name.trim() : null;
  await setUserName(userId, name);
  return { name };
});

app.post("/v1/auth/sign-in", authLimit(10), async (request) => {
  const body = signInInputSchema.parse(request.body);
  try {
    const session = await localAuthProvider.signIn(body.email, body.password);
    captureEvent(session.userId, "login_succeeded", {});
    return { session };
  } catch (error) {
    // No identity yet on a failed login; record only a coarse, safe reason.
    captureAnonymous("login_failed", { reason: safeErrorCategory(error) });
    throw error;
  }
});

app.post("/v1/auth/refresh", authLimit(30), async (request) => {
  const body = refreshInputSchema.parse(request.body);
  return { session: await localAuthProvider.refresh(body.refreshToken) };
});

app.post("/v1/auth/sign-out", authLimit(30), async (request) => {
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

// Re-send the email-verification link (used when the first link expired). Always
// returns ok so the response never reveals whether the email exists or is already
// verified. Rate limited like the other email-sending auth routes.
app.post("/v1/auth/resend-verification", authLimit(6), async (request) => {
  const body = resendVerificationInputSchema.parse(request.body);
  await localAuthProvider.resendVerification(body.email);
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

app.get<{ Querystring: { token?: string } }>("/reset", authLimit(12), async (request, reply) => {
  // Validate the token to its known lowercase-hex shape before reflecting it into
  // the page. A hex-only value can never contain the characters ("<", ">", "/",
  // quotes) needed to break out of the inline <script>, so this closes a reflected
  // XSS hole. A malformed or malicious token collapses to "" and the reset simply
  // fails, which is the correct outcome for a garbage link.
  const raw = typeof request.query.token === "string" ? request.query.token : "";
  const token = z.string().max(512).regex(/^[a-f0-9]*$/).catch("").parse(raw);
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

app.get("/v1/entitlement", async (request) => {
  const userId = await authenticate(request);
  const state = await subscriptionState(userId);
  captureEvent(userId, "subscription_status_checked", { plan: state.plan ?? "none", active: state.active });
  return state;
});

// A signed-in user's referral standing: their code, a shareable link, how many
// people they have invited, how many have paid, and the bonus earned so far.
// Available to any signed-in user (even before they subscribe) so they can start
// inviting; a legacy account without a code is assigned one on first read.
app.get("/v1/referral", routeLimit(30), async (request): Promise<ReferralInfo> => {
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
  const subscription = requireActive(await getSubscription(userId));
  const body = summarizeRecordingRequestSchema.parse(request.body);
  // Count this small model call against the same hard caps as chat and automation,
  // and cap its output by the budget too so nothing keeps spending once the daily
  // or monthly limit is reached. It is a single bounded Haiku call.
  const headroom = await budgetHeadroom(userId, subscription);
  const summaryMaxTokens = Math.min(400, budgetLimitedOutputTokens("haiku", Math.min(headroom.daily, headroom.monthly)));
  if (summaryMaxTokens < 1) {
    if (headroom.daily <= headroom.monthly) {
      throw Object.assign(new Error("You have hit your usage limit for today. It will free up tomorrow."), { statusCode: 429, code: "RATE_LIMIT_DAY" });
    }
    throw Object.assign(new Error("You have used all your tokens for this period."), { statusCode: 402, code: "BUDGET_EXHAUSTED" });
  }
  const reservationAmount = maximumReservationMicrodollars("haiku", body, summaryMaxTokens);
  const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: reservationAmount });
  try {
    const task = await summarizeRecording(body.surface, body.events, summaryMaxTokens);
    await settleBudget(reservation.reservationId, reservationAmount);
    return { task };
  } catch (error) {
    await releaseBudget(reservation.reservationId);
    throw error;
  }
});

// Simulated checkout. Requires authentication, is allowed only when the
// simulated billing mode is selected, and never in production. It writes an
// active, Stripe-shaped entitlement through the same upsert path the real
// Stripe webhook uses, then returns the resulting entitlement state.
app.post("/v1/billing/simulate", routeLimit(15), async (request) => {
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

app.post("/v1/billing/checkout", routeLimit(15), async (request) => {
  const userId = await authenticate(request);
  const body = createCheckoutSchema.parse(request.body);
  return { url: await createCheckout(userId, body.plan, body.interval) };
});

// Change the plan of an existing active subscription (Pro to Ultra, or to a
// different interval). An UPGRADE charges the prorated difference immediately
// against the card on file and returns the refreshed entitlement once it clears;
// if the card needs extra authentication it returns a hosted invoice { url } to
// finish paying, and the higher tier is granted by the webhook, never for free. A
// DOWNGRADE is applied in place as a credit and the refreshed entitlement is
// returned immediately.
app.post("/v1/billing/change-plan", routeLimit(15), async (request) => {
  const userId = await authenticate(request);
  const body = createCheckoutSchema.parse(request.body);
  const result = await changePlan(userId, body.plan, body.interval);
  if ("url" in result) return { url: result.url };
  return subscriptionState(userId);
});

app.post("/v1/billing/portal", routeLimit(15), async (request) => ({ url: await createPortal(await authenticate(request)) }));

// Permanently delete the authenticated user's account: cancel the Stripe
// subscription first (so billing stops and we never orphan an active paid
// subscription), then remove every row the user owns. The desktop signs out
// afterward. This is irreversible; the client confirms before calling it.
app.delete("/v1/account", routeLimit(5), async (request) => {
  const userId = await authenticate(request);
  await cancelSubscriptionForDeletion(userId);
  await deleteAccount(userId);
  request.log.warn({ event: "account_deleted", userId }, "account deleted");
  return { ok: true };
});

app.post("/v1/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
  const signature = request.headers["stripe-signature"];
  const body = (request as typeof request & { rawBody?: Buffer }).rawBody;
  if (typeof signature !== "string" || !body) {
    request.log.warn({ event: "stripe_webhook_bad_request" }, "Stripe webhook missing signature or body");
    return reply.code(400).send({ error: "Invalid webhook" });
  }
  try {
    const result = await handleStripeWebhook(body, signature);
    // Audit trail for payment/credit events without logging any secret or payload.
    request.log.info({ event: "stripe_webhook_processed", type: result.type, duplicate: result.duplicate }, "Stripe webhook processed");
    return { received: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if ((error as { type?: string }).type === "StripeSignatureVerificationError" || /signature/i.test(message)) {
      // Forged or misdirected webhook: a distinct, greppable security event and a
      // 400 (not a 500), never logging the raw body or the signature value.
      request.log.warn({ event: "stripe_webhook_signature_failed" }, "Stripe webhook signature verification failed");
      return reply.code(400).send({ error: "Invalid signature" });
    }
    throw error; // a genuine processing error: 500 so Stripe retries
  }
});

app.post("/v1/runs", routeLimit(30), async (request) => {
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

app.post<{ Params: { runId: string } }>("/v1/runs/:runId/next", routeLimit(90), async (request): Promise<RunStepResponse> => {
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = nextRunStepSchema.parse(request.body ?? {});
  const runId = z.string().uuid().parse(request.params.runId);
  const run = await getRun(runId, userId);
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
  // Size this step so the whole step (input plus output) fits the money that is
  // left, and stop the run before spending if it does not. The input (the growing
  // accumulated context) is covered first, then output is truncated to whatever
  // budget remains, so the automation halts at the cap instead of running another
  // full step past it. A step needs a little room to emit one action.
  const MIN_STEP_OUTPUT_TOKENS = 64;
  const headroom = await budgetHeadroom(userId, subscription);
  const remaining = Math.min(headroom.daily, headroom.monthly);
  const inputEstimate = estimatedInputMicrodollars(tier, modelRequestPayload(run.messages, tier, 1_200));
  const outputPrice = MODEL_PRICES[tier].output;
  if (remaining - inputEstimate < MIN_STEP_OUTPUT_TOKENS * outputPrice) {
    if (headroom.daily <= headroom.monthly) {
      throw Object.assign(new Error("You have hit your usage limit for today. It will free up tomorrow."), { statusCode: 429, code: "RATE_LIMIT_DAY" });
    }
    throw Object.assign(new Error("You have used all your tokens for this period."), { statusCode: 402, code: "BUDGET_EXHAUSTED" });
  }
  let maxOutputTokens = Math.min(1_200, budgetLimitedOutputTokens(tier, remaining - inputEstimate));
  const payload = modelRequestPayload(run.messages, tier, maxOutputTokens);
  const reservationAmount = maximumReservationMicrodollars(tier, payload, maxOutputTokens);
  const reservation = await reserveBudget({
    subscription,
    runId: run.id,
    model: tier,
    amountMicrodollars: reservationAmount
  });
  // Re-cap output to what was actually reserved (minus input) after any concurrent
  // consumption; release the hold and stop the run if nothing meaningful is left.
  const finalOutputBudget = reservation.reservedMicrodollars - inputEstimate;
  if (finalOutputBudget < MIN_STEP_OUTPUT_TOKENS * outputPrice) {
    await releaseBudget(reservation.reservationId);
    if (headroom.daily <= headroom.monthly) {
      throw Object.assign(new Error("You have hit your usage limit for today. It will free up tomorrow."), { statusCode: 429, code: "RATE_LIMIT_DAY" });
    }
    throw Object.assign(new Error("You have used all your tokens for this period."), { statusCode: 402, code: "BUDGET_EXHAUSTED" });
  }
  maxOutputTokens = Math.min(maxOutputTokens, budgetLimitedOutputTokens(tier, finalOutputBudget));

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
      // into the user's hard daily or monthly caps.
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

app.post("/v1/attachments", { bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = attachmentUploadSchema.parse(request.body);
  // If the upload names a conversation, confirm it belongs to this user before
  // storing the reference, so the conversation_id column cannot be set to another
  // user's conversation id (a data-integrity guard mirroring the chat path).
  if (body.conversationId) {
    const conversation = await getConversation(body.conversationId, userId);
    if (!conversation) {
      throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
    }
  }
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

app.post("/v1/chat", routeLimit(40), async (request, reply) => {
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = chatSendSchema.parse(request.body);

  // Count the turn only; never the message text or attachment contents.
  captureEvent(userId, "chat_message_sent", { model: body.model, has_attachments: body.attachments.length > 0 });

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
  const conversation = await getConversation(z.string().uuid().parse(request.params.id), userId);
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  const stored = await getMessages(conversation.id, userId);
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
  const removed = await deleteConversation(z.string().uuid().parse(request.params.id), userId);
  if (!removed) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  return { ok: true };
});

// Authentication/authorization failure codes worth surfacing as a distinct
// security event so brute force and token abuse are visible in logs (the values
// logged are codes/paths/IP only, never credentials or tokens).
const AUTH_FAILURE_CODES = new Set(["AUTH_REQUIRED", "AUTH_INVALID", "INVALID_CREDENTIALS", "EMAIL_NOT_VERIFIED", "INVALID_REFRESH_TOKEN"]);

app.setErrorHandler((error, request, reply) => {
  const statusCode = error instanceof ZodError ? 400 : Number((error as { statusCode?: number }).statusCode ?? 500);
  const code = error instanceof ZodError ? "INVALID_REQUEST" : String((error as { code?: string }).code ?? "INTERNAL_ERROR");
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Request failed");
    // Safe category only; never the error message (it may carry identifiers).
    captureAnonymous("app_error", { source: "backend", category: safeErrorCategory(error), status: statusCode });
  }
  else if (statusCode === 429) request.log.warn({ event: "rate_limited", path: request.url, ip: request.ip }, "Rate limit exceeded");
  else if (AUTH_FAILURE_CODES.has(code)) request.log.warn({ event: "auth_failure", code, path: request.url, ip: request.ip }, "Authentication failed");
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
