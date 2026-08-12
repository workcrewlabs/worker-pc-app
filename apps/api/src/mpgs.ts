import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { PLAN_CATALOG, type BillingInterval, type PaidPlanId } from "@workcrew/contracts";
import { config } from "./config.js";
import {
  attachMpgsSession,
  claimMpgsOrderGrant,
  countMpgsTestLinkUse,
  createMpgsOrder,
  createMpgsTestLink,
  getMpgsOrder,
  getMpgsTestLink,
  getSubscription,
  getUserById,
  recordAdminAction,
  setMpgsOrderStatus,
  upsertSubscription,
  type MpgsOrderRow
} from "./db.js";

/**
 * Card payments through Mastercard Payment Gateway Services, as resold by the
 * acquiring bank.
 *
 * The shape of the flow is what makes it safe. The server decides what is being
 * bought and writes that down BEFORE the payer goes anywhere. The payer is then
 * sent to a page hosted by the bank, so card numbers never reach this server or
 * the desktop app. When they come back, nothing they or their browser says is
 * believed: the server asks the gateway directly what happened to that order, and
 * only a confirmed, captured payment of the expected amount grants a plan.
 *
 * This runs alongside manual billing rather than replacing it. Ordinary customers
 * are still activated by hand; only accounts named in MPGS_TEST_EMAILS can reach
 * card checkout at all, which is what allows a live deployment to exercise a test
 * gateway without exposing a single real customer to an untried payment path.
 */

/** The gateway API version this integration is written against. */
const API_VERSION = "73";

/** How long an unpaid order stays claimable before it is treated as abandoned. */
const ORDER_TTL_MS = 2 * 60 * 60 * 1000;

export type MpgsAvailability = { available: boolean; reason?: string };

/** Whether this user may reach card checkout at all. */
export function mpgsAvailableFor(email: string | null | undefined): MpgsAvailability {
  if (!config.mpgs.configured) return { available: false, reason: "The card gateway is not configured." };
  if (config.mpgs.testEmails.size === 0) return { available: false, reason: "Card payment is not open to any account yet." };
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized || !config.mpgs.testEmails.has(normalized)) {
    return { available: false, reason: "Card payment is not enabled for this account." };
  }
  return { available: true };
}

/** Basic auth for the gateway: the merchant id is the username, prefixed. */
function authorizationHeader(): string {
  const credentials = `merchant.${config.mpgs.merchantId}:${config.mpgs.apiPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function endpoint(path: string): string {
  return `${config.mpgs.baseUrl}/api/rest/version/${API_VERSION}/merchant/${encodeURIComponent(config.mpgs.merchantId)}${path}`;
}

/** The price of a plan in minor units, read from the catalog, never from a client. */
export function planAmountCents(plan: PaidPlanId, interval: BillingInterval): number {
  const item = PLAN_CATALOG[plan];
  const dollars = interval === "year" ? item.yearlyPriceUsd : item.monthlyPriceUsd;
  return Math.round(dollars * 100);
}

/**
 * Ask the gateway to open a checkout session for a new order.
 *
 * The order id and the amount are minted here and stored before the request, so
 * the price is the server's decision and the id cannot be guessed or reused.
 */
export async function startCheckout(input: {
  userId: string;
  plan: PaidPlanId;
  interval: BillingInterval;
}): Promise<{ orderId: string; sessionId: string }> {
  if (!config.mpgs.configured) {
    // A 4xx on purpose. Anything 5xx is replaced by a generic message before it
    // reaches the caller, and the only people who can reach this route are the
    // operators who need to know exactly which setting is missing.
    throw Object.assign(
      new Error("The card gateway is not configured. Set MPGS_MERCHANT_ID and MPGS_API_PASSWORD."),
      { statusCode: 409, code: "MPGS_UNAVAILABLE" }
    );
  }
  const orderId = `wc-${randomUUID()}`;
  const amountCents = planAmountCents(input.plan, input.interval);
  const currency = "USD";

  await createMpgsOrder({
    orderId,
    userId: input.userId,
    plan: input.plan,
    interval: input.interval,
    amountCents,
    currency
  });

  const session = await openGatewaySession({
    orderId,
    amountCents,
    currency,
    description: `WorkCrew ${PLAN_CATALOG[input.plan].name} (${input.interval === "year" ? "yearly" : "monthly"})`,
    throwOnFailure: true
  });
  if (!session) throw new Error("The payment gateway refused to start a checkout");

  await attachMpgsSession(orderId, session.sessionId, session.successIndicator);
  return { orderId, sessionId: session.sessionId };
}

/**
 * Ask the gateway to open a checkout session for an order that is already
 * recorded. The single place this integration talks to the gateway about
 * starting a payment, so the request shape cannot drift between the two callers.
 *
 * throwOnFailure distinguishes the two audiences: an operator clicking Test needs
 * the gateway's own words, while a stranger following a shared link gets a plain
 * "not valid" page and no detail about the merchant configuration behind it.
 */
async function openGatewaySession(input: {
  orderId: string;
  amountCents: number;
  currency: string;
  description: string;
  throwOnFailure?: boolean;
}): Promise<{ sessionId: string; successIndicator: string | null } | null> {
  const body = {
    apiOperation: "INITIATE_CHECKOUT",
    interaction: {
      operation: "PURCHASE",
      merchant: { name: "WorkCrew" },
      returnUrl: `${config.publicUrl}/billing/mpgs/return?order=${encodeURIComponent(input.orderId)}`
    },
    order: {
      currency: input.currency,
      id: input.orderId,
      // The gateway takes a decimal amount, not minor units.
      amount: (input.amountCents / 100).toFixed(2),
      description: input.description
    }
  };

  const response = await fetch(endpoint("/session"), {
    method: "POST",
    headers: { authorization: authorizationHeader(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as {
    result?: string;
    session?: { id?: string };
    successIndicator?: string;
    error?: { explanation?: string; cause?: string };
  };

  if (!response.ok || payload.result !== "SUCCESS" || !payload.session?.id) {
    const detail = payload.error?.explanation ?? payload.error?.cause ?? `the gateway responded ${response.status}`;
    // Written onto the order as well as thrown. A failure that only exists in an
    // error message is gone the moment the page is refreshed, and the operator
    // then has nothing to act on; on the row it can be read back in the
    // dashboard whenever they look.
    await setMpgsOrderStatus(input.orderId, "failed", `HTTP ${response.status}: ${detail}`);
    if (!input.throwOnFailure) return null;
    // Reported as a 4xx so the operator actually sees the gateway's own words.
    // A wrong password or merchant id is a configuration problem they can fix,
    // and it is unfixable if every cause reads "the service could not complete
    // the request". The gateway never echoes the credential itself.
    throw Object.assign(new Error(`The payment gateway refused to start a checkout: ${detail}`), {
      statusCode: 409,
      code: "MPGS_SESSION_FAILED",
      gatewayStatus: response.status
    });
  }

  return { sessionId: payload.session.id, successIndicator: payload.successIndicator ?? null };
}

type GatewayOrder = {
  result?: string;
  status?: string;
  amount?: number;
  currency?: string;
};

/** Ask the gateway what actually happened to an order. This is the authority. */
async function fetchOrder(orderId: string): Promise<GatewayOrder> {
  const response = await fetch(endpoint(`/order/${encodeURIComponent(orderId)}`), {
    method: "GET",
    headers: { authorization: authorizationHeader() },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw Object.assign(new Error("The payment gateway could not be reached"), {
      statusCode: 502,
      code: "MPGS_LOOKUP_FAILED"
    });
  }
  return await response.json().catch(() => ({})) as GatewayOrder;
}

/** Gateway order states that mean the money is actually secured. */
const PAID_STATUSES = new Set(["CAPTURED", "SUCCESS"]);

export type SettleResult =
  | { granted: true; plan: PaidPlanId; interval: BillingInterval; alreadyGranted: false }
  | { granted: true; plan: PaidPlanId; interval: BillingInterval; alreadyGranted: true }
  | { granted: false; reason: string };

/**
 * Confirm an order with the gateway and, if it really was paid, grant the plan.
 *
 * Safe to call as often as anything likes: the return page, the webhook and any
 * retry all funnel through here, and the single-claim guard in the database means
 * the plan is handed out on exactly one of those calls. Nothing about the caller
 * is trusted; the decision comes from the gateway's own record of the order and
 * from the amount this server wrote down before the payer ever saw a card form.
 */
export async function settleOrder(orderId: string): Promise<SettleResult> {
  const order = await getMpgsOrder(orderId);
  if (!order) return { granted: false, reason: "That order does not exist." };

  const remote = await fetchOrder(orderId);
  const status = String(remote.status ?? remote.result ?? "").toUpperCase();
  if (!PAID_STATUSES.has(status)) {
    if (order.grantedAtMs === null) await setMpgsOrderStatus(orderId, status.toLowerCase() || "unpaid");
    return { granted: false, reason: "That payment has not completed." };
  }

  // Confirm the gateway captured the amount this server decided on. A mismatch
  // means the order was tampered with somewhere, so it grants nothing.
  const paidCents = Math.round(Number(remote.amount ?? 0) * 100);
  if (paidCents !== order.amountCents || (remote.currency ?? order.currency) !== order.currency) {
    await setMpgsOrderStatus(orderId, "amount_mismatch");
    return { granted: false, reason: "The amount paid does not match the order." };
  }

  // An order opened from a shared test link proves the payment works and stops
  // there. Nobody's subscription moves, which is what makes it safe to hand the
  // link to someone outside the business.
  if (!order.grantsPlan) {
    await setMpgsOrderStatus(orderId, "paid");
    return { granted: false, reason: "This was a test payment. It completed successfully and granted no plan." };
  }

  if (!(await claimMpgsOrderGrant(orderId))) {
    // Another caller already granted this order. Report success without granting
    // a second time, so a duplicate notification is harmless rather than free
    // months.
    return { granted: true, plan: order.plan, interval: order.interval, alreadyGranted: true };
  }

  await grantPaidPlan(order);
  return { granted: true, plan: order.plan, interval: order.interval, alreadyGranted: false };
}

/**
 * Write the paid plan onto the subscription, through the same upsert the manual
 * dashboard uses, so there is one entitlement writer in the system. Time is added
 * to whatever the customer already has rather than replacing it.
 */
async function grantPaidPlan(order: MpgsOrderRow): Promise<void> {
  const now = Date.now();
  const existing = await getSubscription(order.userId);
  const stillRunning =
    existing !== null && existing.active && existing.plan !== "free" && existing.currentPeriodEndMs > now;
  const startFromMs = stillRunning ? existing.currentPeriodEndMs : now;
  const periodMs = order.interval === "year" ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;

  await upsertSubscription({
    userId: order.userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: order.plan,
    interval: order.interval,
    // The same status vocabulary every other billing path writes, so the
    // entitlement guards cannot tell a card payment from any other.
    status: "active",
    active: true,
    budgetAnchorMs: stillRunning ? existing.budgetAnchorMs : now,
    currentPeriodEndMs: startFromMs + periodMs
  });

  const user = await getUserById(order.userId);
  // Card grants land in the same audit trail as hand-made ones, so every route
  // into a paid plan is attributable after the fact.
  await recordAdminAction({
    actorUserId: "mpgs",
    actorEmail: "card-payment",
    action: "card_payment_granted",
    targetUserId: order.userId,
    targetEmail: user?.email ?? null,
    detail: `${order.plan} ${order.interval} for order ${order.orderId}`
  });
}

/** Whether an order is still young enough to be worth settling. */
export function orderIsFresh(order: MpgsOrderRow, nowMs: number = Date.now()): boolean {
  return nowMs - order.createdAtMs <= ORDER_TTL_MS;
}

/**
 * Check a webhook actually came from the gateway.
 *
 * Compared in constant time, because a plain !== leaks how much of a guess was
 * right through how long the comparison took, and this secret is the only thing
 * standing between a stranger who guesses the URL and free paid plans. With no
 * secret configured, nothing is accepted: an unauthenticated notification
 * endpoint that grants access would be worse than having none at all.
 */
export function webhookSecretMatches(provided: string | undefined): boolean {
  const expected = config.mpgs.webhookSecret;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


/**
 * Whether this deployment may hand out shareable payment links at all.
 *
 * Only against a TEST gateway. A link that anyone holding the URL can use to run
 * a real card payment has no place pointed at production, and the host name is
 * the one thing that cannot be got wrong by accident: the bank issues an
 * entirely separate address for live traffic.
 */
export function testLinksAllowed(): boolean {
  const host = config.mpgs.baseUrl.replace(/^https?:\/\//i, "").toLowerCase();
  return config.mpgs.configured && (host.startsWith("test-") || host.startsWith("test."));
}

/** How long a shared link stays usable. Long enough for an email exchange. */
export const TEST_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Mint a link that lets someone with no account run test payments.
 *
 * The token IS the credential, so it is 32 random bytes: long enough that
 * guessing one is not a strategy. Opening the link creates a fresh order every
 * time, so a single link covers as many test transactions as the recipient wants
 * to run, including deliberate declines.
 */
export async function createTestLink(input: {
  label: string;
  plan: PaidPlanId;
  interval: BillingInterval;
  createdBy: string;
}): Promise<{ token: string; url: string; expiresAtMs: number }> {
  if (!testLinksAllowed()) {
    throw Object.assign(
      new Error("Shareable payment links are only available against a test gateway."),
      { statusCode: 409, code: "MPGS_TEST_LINKS_DISABLED" }
    );
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + TEST_LINK_TTL_MS;
  await createMpgsTestLink({
    token,
    label: input.label.slice(0, 120),
    plan: input.plan,
    interval: input.interval,
    createdBy: input.createdBy,
    expiresAtMs
  });
  return { token, url: `${config.publicUrl}/pay/link/${token}`, expiresAtMs };
}

/**
 * Open a fresh checkout from a shared link. Returns null when the link is
 * unknown, revoked, expired, or the deployment has since been pointed at a live
 * gateway, in which case the caller shows a plain "not valid" page rather than
 * explaining which of those it was.
 */
export async function startCheckoutFromLink(token: string): Promise<{ orderId: string } | null> {
  if (!testLinksAllowed()) return null;
  const link = await getMpgsTestLink(token);
  if (!link || link.revoked || link.expiresAtMs <= Date.now()) return null;

  const orderId = `wc-test-${randomUUID()}`;
  const amountCents = planAmountCents(link.plan, link.interval);
  await createMpgsOrder({
    orderId,
    // Attributed to the link's creator for the audit trail, but it grants
    // nothing, so this cannot move anyone's subscription.
    userId: link.createdBy,
    plan: link.plan,
    interval: link.interval,
    amountCents,
    currency: "USD",
    grantsPlan: false
  });
  const session = await openGatewaySession({
    orderId,
    amountCents,
    currency: "USD",
    description: `WorkCrew ${PLAN_CATALOG[link.plan].name} (test payment)`
  });
  if (!session) return null;
  await attachMpgsSession(orderId, session.sessionId, session.successIndicator);
  await countMpgsTestLinkUse(token);
  return { orderId };
}
