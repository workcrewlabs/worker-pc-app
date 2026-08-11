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
  conversationUpdateSchema,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  preferencesUpdateSchema,
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
  MAX_SUMMARY_IMAGES,
  MODEL_PRICES,
  actionSignature,
  actualCostMicrodollars,
  budgetLimitedOutputTokens,
  callModel,
  estimatedInputMicrodollars,
  maximumReservationMicrodollars,
  modelRequestPayload,
  summarizeRecording,
  type ModelResult
} from "./anthropic.js";
import { economyEngineAvailable, provider, routeAutomationTier, type ConcreteModelTier } from "./model-registry.js";
import { processAndStoreAttachment } from "./attachments.js";
import { cancelSubscriptionForDeletion, changePlan, createCheckout, createPortal, handleStripeWebhook } from "./billing.js";
import {
  adminCreateCustomer,
  adminGrantAccess,
  adminGrantSchema,
  adminListCustomers,
  adminRecentActivity,
  adminRevokeAccess,
  adminSetPassword,
  adminUserParamSchema,
  requireAdmin
} from "./admin.js";
import { adminPage } from "./admin-page.js";
import { diagnoseGateway, mpgsAvailableFor, orderIsFresh, settleOrder, startCheckout, webhookSecretMatches } from "./mpgs.js";
import { mpgsCheckoutPage, mpgsResultPage } from "./mpgs-page.js";
import { landingPage } from "./landing.js";
import { pricingPage, privacyPage, refundPolicyPage, termsPage } from "./legal.js";
import { budgetHeadroom, budgetWindowFor, creditReferralOnPayment, exhaustionError, getBudgetUsage, getBudgetWindow, planBudget, planLimits, releaseBudget, reserveBudget, rollingSettledUsage, settleBudget } from "./budget.js";
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
  getMpgsOrder,
  getSubscription,
  listMpgsAttempts,
  grantFreeSubscriptionIfAbsent,
  getUserById,
  initializeDatabase,
  listConversations,
  renameConversation,
  setConversationPinned,
  setModelMode,
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
 * Trim screenshot history to the newest few, exactly as the reference
 * computer-use loop does (its harness filters tool results down to the N most
 * recent images).
 *
 * Every acting step now carries a screenshot, and each is worth far more input
 * tokens than the text around it, so resending all of them every step would
 * multiply the cost of a long task and eventually breach the request size. The
 * newest picture is what the planner acts on; the one before it gives just
 * enough before-and-after context to tell whether the last action worked. The
 * text of each older result is left untouched, so the history of what happened
 * stays intact; only the stale pixels go.
 */
export function stripOlderScreenshots(messages: unknown[], keepNewest = 1): void {
  let kept = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    // The history is replayed from storage, so a malformed or partial entry must
    // skip rather than take the whole run down on the next step.
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { content?: unknown };
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      const parts = block.content as Record<string, unknown>[];
      if (!parts.some((part) => part?.type === "image")) continue;
      if (kept < keepNewest) {
        kept += 1;
        continue;
      }
      block.content = parts
        .filter((part) => part?.type !== "image")
        .concat([{ type: "text", text: "(screenshot from an earlier step, no longer shown)" }]);
    }
  }
}

/**
 * The same messages with every screenshot's bytes replaced by a stub, plus how
 * many were removed. The budget estimators below count serialized BYTES as a
 * token upper bound, which is honest for text but absurd for base64: one JPEG
 * would be counted as a few hundred thousand tokens, and a single vision step
 * would try to reserve more than a whole daily cap. The API actually prices an
 * image by its dimensions, so images are estimated separately at a realistic
 * per-image token cost.
 */
export function withoutImageBytes(messages: unknown[]): { messages: unknown[]; imageCount: number } {
  let imageCount = 0;
  const cleaned = JSON.parse(JSON.stringify(messages)) as unknown[];
  for (const raw of cleaned) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { content?: unknown };
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      const parts = block.content as Record<string, unknown>[];
      for (let index = 0; index < parts.length; index += 1) {
        if (parts[index]?.type === "image") {
          imageCount += 1;
          parts[index] = { type: "text", text: "(screenshot)" };
        }
      }
    }
  }
  return { messages: cleaned, imageCount };
}

/**
 * Token cost of one screenshot. The realistic figure matches a 1400px-wide JPEG
 * (the API charges roughly width times height over 750); the upper bound is the
 * API's own ceiling for any single image after its 1568px resize. Used to price
 * images into the budget without the byte-count fiction.
 */
const IMAGE_TOKEN_ESTIMATE = 1_800;
const IMAGE_TOKEN_UPPER_BOUND = 3_500;

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
  let subscription = await getSubscription(userId);
  // A signed-in user with no subscription row at all gets the free plan here,
  // on their first entitlement read (every client loads entitlement right
  // after login, so this is the single choke point). The grant is a strictly
  // additive INSERT-if-absent: it can never alter an existing free or paid
  // row, and paid tiers are still granted only by the Stripe webhook.
  if (!subscription) {
    await grantFreeSubscriptionIfAbsent(userId);
    subscription = await getSubscription(userId);
  }
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
      pendingEffective: null,
      modelMode: "economy"
    };
  }
  const nowMs = Date.now();
  const window = budgetWindowFor(subscription, nowMs);
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
    pendingEffective: subscription.pendingEffectiveMs ? new Date(subscription.pendingEffectiveMs).toISOString() : null,
    modelMode: subscription.modelMode
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

// Public pricing and policy pages. Payment providers will not verify a merchant
// account until these exist at stable URLs AND the site links to them, so they
// are served here next to the landing page rather than hosted separately. They
// carry no inline script, so the CSP can stay tighter than the landing page's.
for (const [path, render] of [
  ["/pricing", pricingPage],
  ["/terms", termsPage],
  ["/privacy", privacyPage],
  ["/refund-policy", refundPolicyPage]
] as const) {
  app.get(path, async (_request, reply) => {
    void reply
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:")
      .type("text/html")
      .send(render());
  });
}

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

// The few facts a client needs before it has a session: how plans are paid for,
// and who to write to when payment is arranged by hand. Public and unauthenticated
// (the support address is published anyway); carries no user data and no secret.
app.get("/v1/config", routeLimit(60), async () => ({
  billingMode: config.billingMode,
  // Only meaningful under manual billing; empty otherwise, so a client can never
  // show a "pay us directly" message while a real payment processor is live.
  billingContactEmail: config.billingMode === "manual" ? config.billingContactEmail : ""
}));

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
// Recording summaries may carry a handful of small per-click screenshots, so
// this one route accepts a larger body than the global 256 KB limit.
app.post("/v1/recordings/summarize", { ...authLimit(20), bodyLimit: 1_536 * 1024 }, async (request) => {
  // Gate like the other paid routes: a real (Haiku) model call happens here, so
  // only an active subscriber may use it, and a tight per-route limit bounds spend
  // beyond the loose global limit.
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = summarizeRecordingRequestSchema.parse(request.body);
  // Screenshots need a vision model, so an image-bearing recording summarizes on
  // Claude Haiku; a plain text trace may use the Economy engine in Economy mode.
  // If only the Economy engine is configured, the images are dropped rather than
  // failing the whole summary.
  let events = body.events;
  let hasImages = events.some((event) => typeof event.screenshot === "string" && event.screenshot.length > 0);
  if (hasImages && !config.anthropicApiKey) {
    events = events.map(({ screenshot: _screenshot, ...rest }) => rest);
    hasImages = false;
  }
  const summaryTier: ConcreteModelTier = !hasImages && subscription.modelMode === "economy" && economyEngineAvailable() ? "glm" : "haiku";
  const headroom = await budgetHeadroom(userId, subscription);
  const summaryMaxTokens = Math.min(400, budgetLimitedOutputTokens(summaryTier, Math.min(headroom.daily, headroom.monthly)));
  if (summaryMaxTokens < 1) {
    throw exhaustionError(subscription.plan, headroom.daily <= headroom.monthly);
  }
  // Reserve against the text of the trace plus a flat allowance per screenshot: a
  // small crop costs a few hundred input tokens, while its base64 text would
  // inflate a byte-length estimate (and the user's hold) a hundredfold.
  const textOnly = { surface: body.surface, events: events.map(({ screenshot: _screenshot, ...rest }) => rest) };
  const imageCount = hasImages ? Math.min(MAX_SUMMARY_IMAGES, events.filter((event) => event.screenshot).length) : 0;
  const reservationAmount = maximumReservationMicrodollars(summaryTier, textOnly, summaryMaxTokens)
    + imageCount * 600 * MODEL_PRICES[summaryTier].input;
  const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: summaryTier, amountMicrodollars: reservationAmount });
  try {
    const summary = await summarizeRecording(body.surface, events, summaryMaxTokens, summaryTier);
    // Settle what the call actually cost (settleBudget clamps to the reservation),
    // so an image-bearing recording is billed for real tokens, not size estimates.
    await settleBudget(reservation.reservationId, actualCostMicrodollars(summaryTier, summary.usage));
    return { task: summary.task };
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

// Under manual billing there is no payment processor to send anyone to. Every
// purchase path answers with the same explicit error so the app can show the
// "write to us to activate your plan" screen instead of opening a dead checkout.
function refuseUnderManualBilling(): void {
  if (config.billingMode !== "manual") return;
  throw Object.assign(
    new Error(`Plans are activated by the WorkCrew team right now. Email ${config.billingContactEmail} to arrange payment.`),
    { statusCode: 409, code: "MANUAL_BILLING" }
  );
}

app.post("/v1/billing/checkout", routeLimit(15), async (request) => {
  const userId = await authenticate(request);
  refuseUnderManualBilling();
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
  refuseUnderManualBilling();
  const body = createCheckoutSchema.parse(request.body);
  // A free-plan user has no Stripe subscription to modify, so "changing plan"
  // for them is really a first purchase: send them through a fresh hosted
  // checkout. The paid tier is still granted only by the post-payment webhook.
  const current = await getSubscription(userId);
  if (!current?.stripeSubscriptionId) {
    return { url: await createCheckout(userId, body.plan, body.interval) };
  }
  const result = await changePlan(userId, body.plan, body.interval);
  if ("url" in result) return { url: result.url };
  return subscriptionState(userId);
});

app.post("/v1/billing/portal", routeLimit(15), async (request) => {
  const userId = await authenticate(request);
  refuseUnderManualBilling();
  return { url: await createPortal(userId) };
});

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

// Card payment through the bank's gateway. This sits ALONGSIDE manual billing:
// real customers are still activated by hand, and only the accounts listed in
// MPGS_TEST_EMAILS can reach these routes at all, so a live deployment can
// exercise a test gateway without exposing anyone to an untried payment path.
const mpgsCheckoutSchema = z.object({
  plan: z.enum(["pro", "ultra"]),
  interval: z.enum(["month", "year"])
}).strict();

const mpgsOrderQuerySchema = z.object({
  order: z.string().min(1).max(200)
}).strict();

app.post("/v1/billing/mpgs/checkout", routeLimit(10), async (request) => {
  const userId = await authenticate(request);
  const user = await getUserById(userId);
  const availability = mpgsAvailableFor(user?.email);
  if (!availability.available) {
    request.log.warn({ event: "mpgs_checkout_denied", userId }, "card checkout denied");
    throw Object.assign(new Error(availability.reason ?? "Card payment is not available"), {
      statusCode: 403,
      code: "MPGS_NOT_AVAILABLE"
    });
  }
  const body = mpgsCheckoutSchema.parse(request.body);
  let orderId: string;
  try {
    ({ orderId } = await startCheckout({ userId, plan: body.plan, interval: body.interval }));
  } catch (error) {
    // Log the gateway's status alongside the failure so the cause is in the
    // server log too, not only on the operator's screen.
    request.log.warn(
      { event: "mpgs_session_failed", userId, gatewayStatus: (error as { gatewayStatus?: number }).gatewayStatus },
      "card checkout session failed"
    );
    throw error;
  }
  request.log.info({ event: "mpgs_checkout_started", userId, orderId }, "card checkout started");
  // The payer is sent to a page on this backend, which hands over to the bank's
  // own hosted form. The session id is never useful to anyone else.
  return { url: `${config.publicUrl}/pay/${encodeURIComponent(orderId)}` };
});

// The hand-off page. Deliberately unauthenticated: the payer may open it in a
// different browser from the app, and the order id is an unguessable uuid that
// grants nothing on its own.
app.get("/pay/:orderId", async (request, reply) => {
  const { orderId } = z.object({ orderId: z.string().min(1).max(200) }).strict().parse(request.params);
  const order = await getMpgsOrder(orderId);
  if (!order || !order.sessionId || !orderIsFresh(order)) {
    return reply
      .code(404)
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .type("text/html")
      .send(mpgsResultPage({ ok: false, heading: "This payment link has expired", message: "Start the upgrade again from WorkCrew." }));
  }
  if (order.grantedAtMs !== null) {
    return reply
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .type("text/html")
      .send(mpgsResultPage({ ok: true, heading: "Already paid", message: "This order is complete. Switch back to WorkCrew." }));
  }
  // The gateway's script is loaded from the bank's own host, so the CSP for this
  // one page has to allow it, and nothing else.
  const gateway = config.mpgs.baseUrl;
  void reply
    .header(
      "content-security-policy",
      `default-src 'none'; script-src 'unsafe-inline' ${gateway}; style-src 'unsafe-inline'; frame-src ${gateway}; connect-src ${gateway}; img-src ${gateway} data:`
    )
    .header("cache-control", "no-store")
    .type("text/html")
    .send(mpgsCheckoutPage({
      sessionId: order.sessionId,
      orderId: order.orderId,
      planName: PLAN_CATALOG[order.plan].name,
      amount: (order.amountCents / 100).toFixed(2)
    }));
});

// Where the gateway returns the payer. The result shown here is decided by asking
// the gateway what happened, never by anything in the URL.
app.get("/billing/mpgs/return", async (request, reply) => {
  const parsed = mpgsOrderQuerySchema.safeParse(request.query);
  const send = (ok: boolean, heading: string, message: string): unknown =>
    reply
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .header("cache-control", "no-store")
      .type("text/html")
      .send(mpgsResultPage({ ok, heading, message }));

  if (!parsed.success) return send(false, "Something went wrong", "That payment link is not valid.");
  try {
    const result = await settleOrder(parsed.data.order);
    if (result.granted) {
      request.log.info({ event: "mpgs_payment_settled", orderId: parsed.data.order, repeat: result.alreadyGranted }, "card payment settled");
      return send(true, "Payment received", "Your plan is active. Switch back to WorkCrew, it updates on its own.");
    }
    return send(false, "Payment not completed", `${result.reason} Nothing has been charged twice; you can try again from WorkCrew.`);
  } catch (error) {
    request.log.error({ event: "mpgs_settle_failed", orderId: parsed.data.order }, "card payment settle failed");
    void error;
    return send(false, "We could not confirm your payment", "If money left your account, contact support and we will sort it out.");
  }
});

// The gateway's own notification, which is what catches a payment whose payer
// closed the browser before returning. The secret proves it came from the bank;
// the order is then verified with the gateway regardless, so even a valid-looking
// notification cannot grant a plan the gateway did not actually take money for.
app.post("/v1/billing/mpgs/webhook", routeLimit(60), async (request, reply) => {
  const provided =
    (request.headers["x-notification-secret"] as string | undefined) ??
    (request.headers["x-webhook-secret"] as string | undefined);
  if (!webhookSecretMatches(provided)) {
    request.log.warn({ event: "mpgs_webhook_secret_failed" }, "card notification rejected: bad secret");
    return reply.code(401).send({ error: "Unauthorized" });
  }
  const body = z.object({ order: z.object({ id: z.string().min(1).max(200) }).passthrough() }).passthrough().safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Invalid notification" });
  try {
    const result = await settleOrder(body.data.order.id);
    request.log.info({ event: "mpgs_webhook_processed", granted: result.granted }, "card notification processed");
    return { received: true };
  } catch {
    // A 5xx asks the gateway to retry, which is what we want if our own lookup
    // failed transiently.
    return reply.code(503).send({ error: "Could not verify the order" });
  }
});

// Admin dashboard API. Every route resolves the caller through requireAdmin,
// which authenticates the token and checks the email allowlist, answering 404 for
// anyone else. Rate limits are deliberately tight: this is a one-operator surface,
// not something that should ever see traffic.
app.get("/v1/admin/customers", routeLimit(60), async (request) => {
  await requireAdmin(request);
  return adminListCustomers(request.query);
});

app.post("/v1/admin/customers", routeLimit(20), async (request) => {
  const actor = await requireAdmin(request);
  return adminCreateCustomer(actor, request.body);
});

app.post("/v1/admin/customers/:userId/grant", routeLimit(30), async (request) => {
  const actor = await requireAdmin(request);
  const { userId } = adminUserParamSchema.parse(request.params);
  const body = adminGrantSchema.parse(request.body);
  const { currentPeriodEndMs } = await adminGrantAccess(actor, userId, body.plan, body.months);
  return { ok: true, currentPeriodEndMs };
});

app.post("/v1/admin/customers/:userId/revoke", routeLimit(30), async (request) => {
  const actor = await requireAdmin(request);
  const { userId } = adminUserParamSchema.parse(request.params);
  await adminRevokeAccess(actor, userId);
  return { ok: true };
});

app.post("/v1/admin/customers/:userId/password", routeLimit(15), async (request) => {
  const actor = await requireAdmin(request);
  const { userId } = adminUserParamSchema.parse(request.params);
  await adminSetPassword(actor, userId, request.body);
  return { ok: true };
});

app.get("/v1/admin/activity", routeLimit(30), async (request) => {
  await requireAdmin(request);
  return { actions: await adminRecentActivity() };
});

// Recent card checkout attempts with the gateway's own reason for any refusal.
// Admin only, and the reason comes from the gateway, which never echoes the
// credential that was used.
app.get("/v1/admin/card-attempts", routeLimit(30), async (request) => {
  await requireAdmin(request);
  return { attempts: await listMpgsAttempts(10) };
});

// Ask the gateway which merchant id it will actually accept, instead of an
// operator working it out by trial and error. Admin only, and it returns no
// secret: the password's length and whether it has stray whitespace, never its
// value. Tighter rate limit because each call talks to the bank.
app.get("/v1/admin/card-diagnose", routeLimit(6), async (request) => {
  await requireAdmin(request);
  const diagnosis = await diagnoseGateway();
  request.log.info(
    { event: "mpgs_diagnose", worksWith: diagnosis.worksWith, tried: diagnosis.attempts.length },
    "card gateway diagnosed"
  );
  return diagnosis;
});

// The dashboard itself: one self-contained page that signs in with a normal
// WorkCrew account and then drives the routes above. Its inline style and script
// need a relaxed per-response CSP, like the landing page.
app.get("/admin", async (_request, reply) => {
  void reply
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:")
    .header("cache-control", "no-store")
    .header("x-robots-tag", "noindex, nofollow")
    .type("text/html")
    .send(adminPage());
});

app.post("/v1/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
  // With no Stripe account behind this deployment, anything arriving here is
  // stale or forged. Refuse before touching the body or any signing secret.
  if (config.billingMode !== "stripe") {
    request.log.warn({ event: "stripe_webhook_rejected_mode" }, "Stripe webhook received while billing is not in Stripe mode");
    return reply.code(404).send({ error: "Not found" });
  }
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

// Read the signed-in user's preferences (currently just the token-spend mode).
// Tolerant of a user without a subscription row yet so Settings can render before
// checkout; it returns the default in that case.
app.get("/v1/preferences", routeLimit(60), async (request) => {
  const userId = await authenticate(request);
  const subscription = await getSubscription(userId);
  return { modelMode: subscription?.modelMode ?? "economy" };
});

// Update the signed-in user's preferences. The mode only affects paid model use, so
// it requires an active subscription (the row the mode is stored on).
app.patch("/v1/preferences", routeLimit(30), async (request) => {
  const userId = await authenticate(request);
  requireActive(await getSubscription(userId));
  const body = preferencesUpdateSchema.parse(request.body);
  const saved = await setModelMode(userId, body.modelMode);
  if (!saved) throw Object.assign(new Error("Could not save your preferences."), { statusCode: 400, code: "PREFERENCES_NOT_SAVED" });
  return { modelMode: body.modelMode };
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
    escalated: false,
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
  // A non-null alias so the nested planStep closure below sees a defined run
  // (control-flow narrowing from the check above does not reach into a closure).
  const activeRun = run;
  if (run.status === "complete") return { runId: run.id, status: "complete", message: "This run is already complete." };
  if (run.status === "failed") {
    return { runId: run.id, status: "failed", message: "This run has already stopped and cannot continue." };
  }

  if (run.pendingToolUseId) {
    if (!body.result || body.result.toolUseId !== run.pendingToolUseId) {
      throw Object.assign(new Error("The expected tool result was not supplied"), { statusCode: 409, code: "TOOL_RESULT_REQUIRED" });
    }
    // A screenshot comes back as a picture, not a sentence, so the planner can
    // actually SEE a window that publishes no named controls. Only the newest
    // result carries one (older screenshots are stripped below), which keeps a
    // long run from resending every image it has ever taken.
    const resultContent: unknown[] = [{ type: "text", text: body.result.output }];
    if (body.result.imageBase64) {
      resultContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: body.result.imageBase64 }
      });
    }
    stripOlderScreenshots(run.messages);
    run.messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: body.result.toolUseId,
        is_error: !body.result.ok,
        content: resultContent
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

  const mode = subscription.modelMode;
  const isUltra = subscription.plan === "ultra";

  // One automation step is a single tool call. Most steps are small, but a
  // write_file step carries an entire file's content in its arguments, and a
  // ceiling that truncates the call mid-JSON corrupts it into an unrunnable
  // action (observed as garbage argument keys from the economy engine). The
  // ceiling therefore leaves room for a real file; unspent output is never
  // billed (reservations settle to actual usage), so the higher ceiling only
  // means a temporarily larger hold, not more spend.
  const MIN_STEP_OUTPUT_TOKENS = 64;
  const STEP_MAX_OUTPUT_TOKENS = 4_000;
  // After the Economy engine repeats the same action this many times, hand the run
  // off to Claude. MAX_REPEATED_ACTIONS remains the final give-up if even Claude loops.
  const ESCALATE_AFTER_REPEATS = 2;

  // Plan one step on a given engine: size the request to the money that is left,
  // reserve, call the model, and settle the real cost, all against the ONE shared
  // budget (so a cheaper engine simply stretches the same daily and monthly caps
  // further). Throws 429/402 before spending when a cap is reached, and releases its
  // hold on a genuine model failure. It does NOT append to run.messages; the caller
  // appends the action it actually returns, so an escalation can discard a stuck
  // action without leaving a dangling tool_use in the transcript.
  async function planStep(tier: ConcreteModelTier): Promise<ModelResult> {
    const headroom = await budgetHeadroom(userId, subscription);
    const remaining = Math.min(headroom.daily, headroom.monthly);
    // Screenshots are priced separately: the byte-based estimators would count a
    // base64 image as hundreds of thousands of tokens and reject the step against
    // the daily cap, when its real cost is under two thousand tokens.
    const { messages: estimateMessages, imageCount } = withoutImageBytes(activeRun.messages);
    const inputEstimate = estimatedInputMicrodollars(
      tier,
      modelRequestPayload(estimateMessages, tier, STEP_MAX_OUTPUT_TOKENS),
      imageCount * IMAGE_TOKEN_ESTIMATE
    );
    const outputPrice = MODEL_PRICES[tier].output;
    if (remaining - inputEstimate < MIN_STEP_OUTPUT_TOKENS * outputPrice) {
      throw exhaustionError(subscription.plan, headroom.daily <= headroom.monthly);
    }
    let maxOutputTokens = Math.min(STEP_MAX_OUTPUT_TOKENS, budgetLimitedOutputTokens(tier, remaining - inputEstimate));
    const payload = modelRequestPayload(estimateMessages, tier, maxOutputTokens);
    const reservationAmount =
      maximumReservationMicrodollars(tier, payload, maxOutputTokens) +
      imageCount * IMAGE_TOKEN_UPPER_BOUND * MODEL_PRICES[tier].input;
    const reservation = await reserveBudget({ subscription, runId: activeRun.id, model: tier, amountMicrodollars: reservationAmount });
    // Re-cap output to what was actually reserved (minus input) after any concurrent
    // consumption; release the hold and stop if nothing meaningful is left.
    const finalOutputBudget = reservation.reservedMicrodollars - inputEstimate;
    if (finalOutputBudget < MIN_STEP_OUTPUT_TOKENS * outputPrice) {
      await releaseBudget(reservation.reservationId);
      throw exhaustionError(subscription.plan, headroom.daily <= headroom.monthly);
    }
    maxOutputTokens = Math.min(maxOutputTokens, budgetLimitedOutputTokens(tier, finalOutputBudget));
    try {
      const result = await callModel({ tier, messages: activeRun.messages, maxOutputTokens });
      const actualCost = actualCostMicrodollars(tier, result.usage);
      if (actualCost > reservationAmount) {
        // Provider reported usage above the reserved maximum. Settle at the clamped
        // ceiling (settleBudget clamps) so a genuine overage is billed, then fail.
        await settleBudget(reservation.reservationId, actualCost, result.providerRequestId);
        throw Object.assign(new Error("Provider usage exceeded the reserved maximum"), { code: "USAGE_RESERVATION_BREACH", providerRequestId: result.providerRequestId });
      }
      await settleBudget(reservation.reservationId, actualCost, result.providerRequestId);
      activeRun.tokensInput += result.usage.input_tokens;
      activeRun.tokensCacheRead += result.usage.cache_read_input_tokens;
      activeRun.tokensCacheWrite += result.usage.cache_creation_input_tokens;
      activeRun.tokensOutput += result.usage.output_tokens;
      return result;
    } catch (error) {
      if ((error as { code?: string }).code === "USAGE_RESERVATION_BREACH") throw error; // already settled at the ceiling
      await releaseBudget(reservation.reservationId); // genuine failure: never bill it, never eat the caps
      throw error;
    }
  }

  try {
    // Economy runs the loop on the cost-efficient engine; Privacy (or an unconfigured
    // engine) uses cheap Claude Haiku. Once escalated, every step is Claude.
    let tier = routeAutomationTier({ mode, escalated: run.escalated, ultra: isUltra });
    let result: ModelResult;
    try {
      result = await planStep(tier);
    } catch (stepError) {
      // If the Economy engine fails the REQUEST itself (a config, format, or upstream
      // error, not a budget cap), fall back to Claude for the rest of the run so a
      // provider hiccup never blocks the user. Budget and rate errors are not caught
      // here: they bubble up and leave the run resumable.
      const stepCode = (stepError as { code?: string }).code;
      const modelFailed = stepCode === "MODEL_REQUEST_FAILED" || stepCode === "MODEL_UNAVAILABLE";
      // Only fall back when a Claude key is configured (always true in production).
      if (modelFailed && provider(tier) === "zai" && !run.escalated && config.anthropicApiKey) {
        run.escalated = true;
        request.log.warn({ runId: run.id, step: run.stepCount, code: stepCode }, "economy engine request failed; falling back to Claude");
        tier = routeAutomationTier({ mode, escalated: true, ultra: isUltra });
        result = await planStep(tier);
      } else {
        throw stepError;
      }
    }

    // A malformed tool call is fed back to the model as a plain-text correction
    // so it can fix its own call, instead of ending the run. The broken tool_use
    // block is deliberately NOT replayed into history (one provider's
    // compatibility layer chokes on a dangling malformed tool call); a text
    // description of the mistake is enough for the model to retry correctly.
    // Bounded corrections per engine; if the Economy engine still cannot produce
    // a runnable action (its tool-call serialization is known to corrupt long
    // file contents), the run escalates to Claude like a stuck run does. Only
    // when even that fails does the fallback finish in result.action end the run.
    const correctInvalid = async (): Promise<void> => {
      for (let corrections = 0; result.invalid && corrections < 2; corrections += 1) {
        const assistantText = result.content
          .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim() || "(sent a tool call that could not be run)";
        run.messages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] });
        run.messages.push({ role: "user", content: [{ type: "text", text: result.invalid.message }] });
        request.log.warn({ runId: run.id, step: run.stepCount, detail: result.invalid.message.slice(0, 300) }, "invalid planner action fed back for correction");
        result = await planStep(tier);
      }
    };
    await correctInvalid();
    if (result.invalid && !run.escalated && provider(tier) === "zai" && config.anthropicApiKey) {
      run.escalated = true;
      request.log.warn({ runId: run.id, step: run.stepCount }, "invalid actions persisted; escalating to Claude");
      tier = routeAutomationTier({ mode, escalated: true, ultra: isUltra });
      result = await planStep(tier);
      await correctInvalid();
    }

    // Track repeated actions for both the escalation trigger and the final loop
    // stop. A finish action ends the run and is never a loop.
    if (result.action.kind !== "finish") {
      const signature = actionSignature(result.action);
      run.repeatCount = signature === run.lastActionSignature ? run.repeatCount + 1 : 1;
      run.lastActionSignature = signature;
    }

    // Claude solves what the Economy engine cannot. When the engine repeats the same
    // action ESCALATE_AFTER_REPEATS times (stuck), hand off to Claude for the rest of
    // the run and re-plan this step now, discarding the stuck action instead of
    // executing it. This happens at most once per run.
    if (
      result.action.kind !== "finish" &&
      !run.escalated &&
      provider(tier) === "zai" &&
      run.repeatCount >= ESCALATE_AFTER_REPEATS
    ) {
      run.escalated = true;
      request.log.info({ runId: run.id, step: run.stepCount }, "automation escalated to Claude after a repeated action");
      tier = routeAutomationTier({ mode, escalated: true, ultra: isUltra });
      result = await planStep(tier);
      // Reset loop tracking against Claude's fresh action.
      if (result.action.kind !== "finish") {
        run.repeatCount = 1;
        run.lastActionSignature = actionSignature(result.action);
      } else {
        run.repeatCount = 0;
        run.lastActionSignature = null;
      }
    }

    // Append the action we will actually return so the transcript stays valid.
    run.messages.push({ role: "assistant", content: result.content });
    request.log.info({
      runId: run.id,
      step: run.stepCount,
      tier,
      escalated: run.escalated,
      runTokens: {
        input: run.tokensInput,
        cacheRead: run.tokensCacheRead,
        cacheWrite: run.tokensCacheWrite,
        output: run.tokensOutput
      }
    }, "automation step token usage");

    const window = budgetWindowFor(subscription);
    const usage = await getBudgetUsage(userId, window);
    const usagePayload = {
      usedMicrodollars: usage.used,
      budgetMicrodollars: PLAN_CATALOG[subscription.plan].monthlyApiBudgetMicrodollars
    };

    // Final loop stop: if the same action still repeats too many times in a row
    // (even after any escalation), end the run instead of spending more budget.
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
    const code = (error as { code?: string }).code;
    if (code === "RATE_LIMIT_DAY" || code === "BUDGET_EXHAUSTED") {
      // A cap was reached before a step could run. planStep spent nothing (or already
      // released its hold), so leave the run resumable: do not persist a failed status
      // or the step increment. It can continue once the daily window frees or the
      // period resets.
      throw error;
    }
    // planStep already released or settled its own reservation. Just record the run
    // as failed and surface the error.
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
  // Writing to the raw socket bypasses the CORS plugin's reply hooks, so the
  // allow-origin header must be attached here by hand or the web app's browser
  // discards the stream. Only origins already on the allowlist are echoed.
  const origin = request.headers.origin;
  const corsHeaders = origin && config.allowedOrigins.has(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders
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
    projectId: conversation.projectId,
    pinnedAtMs: conversation.pinnedAtMs
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
      projectId: conversation.projectId,
      pinnedAtMs: conversation.pinnedAtMs
    },
    messages
  };
});

// Rename and/or pin a conversation from the Recents menu. Ownership is enforced
// by scoping every write to the authenticated user_id; a request for a
// conversation the user does not own affects no rows and returns 404.
app.patch<{ Params: { id: string } }>("/v1/conversations/:id", routeLimit(60), async (request) => {
  const userId = await authenticate(request);
  const id = z.string().uuid().parse(request.params.id);
  const body = conversationUpdateSchema.parse(request.body);
  if (body.title !== undefined && !(await renameConversation(id, userId, body.title))) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  if (body.pinned !== undefined && !(await setConversationPinned(id, userId, body.pinned))) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
  }
  return { ok: true };
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
