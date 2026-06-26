import Stripe from "stripe";
import {
  PLAN_CATALOG,
  REFERRAL_BONUS_MICRODOLLARS,
  type BillingInterval,
  type PlanId
} from "@workcrew/contracts";
import { config } from "./config.js";
import { creditReferralOnPayment } from "./budget.js";
import {
  getSubscription,
  getSubscriptionByStripeId,
  hasStripeEvent,
  recordStripeEvent,
  upsertSubscription
} from "./db.js";

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

function requireStripe(): Stripe {
  if (!stripe) {
    throw Object.assign(new Error("Billing is not configured"), { statusCode: 503, code: "BILLING_UNAVAILABLE" });
  }
  return stripe;
}

function priceId(plan: PlanId, interval: BillingInterval): string {
  const id = config.stripePrices[plan][interval];
  if (!id) {
    throw Object.assign(new Error("The selected price is not configured"), { statusCode: 503, code: "PRICE_UNAVAILABLE" });
  }
  return id;
}

function identifyPrice(id: string): { plan: PlanId; interval: BillingInterval } | null {
  for (const plan of ["pro", "ultra"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (config.stripePrices[plan][interval] === id) return { plan, interval };
    }
  }
  return null;
}

// The single source of truth for which Stripe subscription statuses grant access.
// Pre-launch strict mode counts only a live subscription ("active") or a live
// trial ("trialing"). "past_due" is Stripe's payment-retry window; it is treated
// as entitled ONLY when an explicit grace period is enabled
// (WORKCREW_BILLING_GRACE_PAST_DUE), so a failed renewal does not silently keep a
// non-paying account unlocked. canceled / unpaid / incomplete are never entitled.
const ENTITLED_STATUSES = new Set(["active", "trialing"]);
export function isEntitledStatus(status: string): boolean {
  if (ENTITLED_STATUSES.has(status)) return true;
  if (status === "past_due" && config.billingGracePastDue) return true;
  return false;
}

export async function createCheckout(userId: string, plan: PlanId, interval: BillingInterval): Promise<string> {
  const client = requireStripe();
  const existing = await getSubscription(userId);
  const customerId = existing?.stripeCustomerId ?? undefined;
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    // When the customer already exists, Stripe requires permission to update the
    // name and address on file before it will collect a tax ID or compute tax.
    // Without this the session creation fails with a "customer_update[name]"
    // error. For brand new customers Stripe collects these directly, so this is
    // only set when reusing a customer.
    ...(customerId ? { customer_update: { name: "auto" as const, address: "auto" as const } } : {}),
    client_reference_id: userId,
    line_items: [{ price: priceId(plan, interval), quantity: 1 }],
    allow_promotion_codes: false,
    billing_address_collection: "auto",
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
    subscription_data: {
      metadata: {
        workcrew_user_id: userId,
        workcrew_plan: plan,
        workcrew_interval: interval
      }
    },
    metadata: {
      workcrew_user_id: userId,
      workcrew_plan: plan,
      workcrew_interval: interval
    },
    success_url: `${config.billingSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: config.billingCancelUrl
  });

  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// The recurring price of a plan/interval in dollars.
function planPriceUsd(plan: PlanId, interval: BillingInterval): number {
  const item = PLAN_CATALOG[plan];
  return interval === "year" ? item.yearlyPriceUsd : item.monthlyPriceUsd;
}

// Whether moving from one plan/interval to another is an UPGRADE that must be
// paid before it is granted, versus a downgrade applied in place. An upgrade is a
// move to a plan with a HIGHER monthly allowance (more capacity / higher limits).
// Ranking by allowance, not by recurring price, is essential: Pro yearly ($270)
// costs more than Ultra monthly ($200), yet Pro-yearly -> Ultra-monthly is a tier
// upgrade that hands over Ultra's strictly higher limits and so must pay first. An
// interval change WITHIN the same plan does not change limits, so it falls back to
// the recurring price (monthly -> yearly costs more now, so it also pays first;
// yearly -> monthly is a credit applied in place).
export function isPlanUpgrade(fromPlan: PlanId, fromInterval: BillingInterval, toPlan: PlanId, toInterval: BillingInterval): boolean {
  const fromCapacity = PLAN_CATALOG[fromPlan].monthlyApiBudgetMicrodollars;
  const toCapacity = PLAN_CATALOG[toPlan].monthlyApiBudgetMicrodollars;
  if (toCapacity !== fromCapacity) return toCapacity > fromCapacity;
  return planPriceUsd(toPlan, toInterval) > planPriceUsd(fromPlan, fromInterval);
}

// Switch an existing active subscription to a different plan or interval (for
// example Pro to Ultra), instead of opening a second checkout and creating a
// duplicate subscription.
//
// An UPGRADE (a higher-allowance plan) charges the prorated difference for the
// rest of the current period IMMEDIATELY against the card on file, and the higher
// tier is granted only if that charge clears. We update the subscription with
// proration_behavior "always_invoice" (bill the proration now, not on the next
// renewal) and payment_behavior "pending_if_incomplete" (keep the current plan
// unless the charge is paid). If the card clears synchronously the new plan is
// applied at once; if it needs extra bank authentication (3-D Secure) or is
// declined, Stripe holds the change as a pending update, the customer stays on
// the current plan, and we return a hosted invoice { url } so they can finish
// paying in the browser. Either way the grant is applied by the
// customer.subscription.updated / pending_update_applied webhook, never for free.
//
// A DOWNGRADE (the same or lower allowance) is a credit, not a charge, so it is
// applied in place immediately and the fresh entitlement is returned.
export async function changePlan(
  userId: string,
  plan: PlanId,
  interval: BillingInterval
): Promise<{ url: string } | { changed: true }> {
  const client = requireStripe();
  const subscription = await getSubscription(userId);
  if (!subscription?.stripeSubscriptionId || !subscription.stripeCustomerId) {
    throw Object.assign(new Error("No active subscription to change"), { statusCode: 409, code: "NO_SUBSCRIPTION" });
  }
  const stripeSub = await client.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error("Subscription has no item to update");

  const isUpgrade = isPlanUpgrade(subscription.plan, subscription.interval, plan, interval);

  if (isUpgrade) {
    // Bill the prorated difference for the rest of this period NOW and grant the
    // higher tier only after it is actually paid. always_invoice finalizes and
    // charges that proration invoice immediately (instead of deferring it to the
    // next renewal); pending_if_incomplete keeps the subscription on the current
    // plan unless the charge clears, so an upgrade is never handed over for free.
    // metadata is not sent here: pending_if_incomplete only accepts
    // pending-update-safe fields, and the subscription already carries
    // workcrew_user_id from checkout.
    let updated: Stripe.Subscription;
    try {
      updated = await client.subscriptions.update(subscription.stripeSubscriptionId, {
        items: [{ id: itemId, price: priceId(plan, interval) }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
        expand: ["latest_invoice"]
      });
    } catch (error) {
      // With pending_if_incomplete a declined card normally surfaces below as a
      // pending update, not as a throw, so a throw here is usually a non-card
      // problem (a misconfigured price, rate limiting, an API error). Map a genuine
      // card error to a clear 402; everything else to a generic 502. The detail is
      // logged server side either way.
      if ((error as { type?: string }).type === "StripeCardError") {
        throw Object.assign(
          new Error("We could not charge your card for the upgrade. Please check your payment details and try again."),
          { statusCode: 402, code: "UPGRADE_PAYMENT_FAILED", cause: error }
        );
      }
      throw Object.assign(
        new Error("We could not start the upgrade. Please try again in a moment."),
        { statusCode: 502, code: "UPGRADE_FAILED", cause: error }
      );
    }

    // Grant the higher tier ONLY once the prorated charge has actually been paid.
    // pending_update is set when the charge needs 3-D Secure or was declined; and
    // even when it is absent, an asynchronously-settling payment can leave the
    // invoice unpaid, so we also require the proration invoice itself to read
    // "paid". This keeps the grant strictly behind cleared money for every payment
    // method, not just instant cards.
    const invoice = updated.latest_invoice && typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;
    if (!updated.pending_update && invoice?.status === "paid") {
      // The customer.subscription.updated webhook also applies this; the upsert is
      // idempotent, so granting now just reflects the upgrade without the wait.
      await synchronizeSubscription(updated);
      return { changed: true };
    }

    // Not paid yet (needs authentication, still processing, or declined): keep the
    // customer on the current plan and send them to the hosted invoice to finish
    // paying. The higher tier is applied by the pending_update_applied / updated
    // webhook once the charge clears, so it is never granted for free.
    const hostedUrl = invoice?.hosted_invoice_url ?? null;
    if (hostedUrl) return { url: hostedUrl };
    throw Object.assign(
      new Error("We could not charge your card for the upgrade. Please check your payment details and try again."),
      { statusCode: 402, code: "UPGRADE_PAYMENT_FAILED" }
    );
  }

  // Downgrade (or same price): apply in place as a proration credit. No payment
  // page is needed because the user is not being charged more.
  const updated = await client.subscriptions.update(subscription.stripeSubscriptionId, {
    items: [{ id: itemId, price: priceId(plan, interval) }],
    proration_behavior: "create_prorations",
    payment_behavior: "allow_incomplete",
    metadata: {
      workcrew_user_id: userId,
      workcrew_plan: plan,
      workcrew_interval: interval
    }
  });
  await synchronizeSubscription(updated);
  return { changed: true };
}

// Cancel the user's Stripe subscription immediately, used when the account is
// being deleted so billing stops. A missing or already-canceled subscription is
// fine; any other failure is surfaced so the account is NOT deleted while an
// active paid subscription would keep charging the card. In simulated billing
// there is nothing to cancel.
export async function cancelSubscriptionForDeletion(userId: string): Promise<void> {
  if (config.billingMode !== "stripe") return;
  const subscription = await getSubscription(userId);
  if (!subscription?.stripeSubscriptionId) return;
  const client = requireStripe();
  try {
    await client.subscriptions.cancel(subscription.stripeSubscriptionId);
  } catch (error) {
    if ((error as { code?: string }).code === "resource_missing") return;
    throw Object.assign(
      new Error("We could not cancel your subscription, so your account was not deleted. Please try again."),
      { statusCode: 502, code: "CANCEL_FAILED" }
    );
  }
}

export async function createPortal(userId: string): Promise<string> {
  const client = requireStripe();
  const subscription = await getSubscription(userId);
  if (!subscription?.stripeCustomerId) {
    throw Object.assign(new Error("No billing account exists"), { statusCode: 404, code: "BILLING_ACCOUNT_MISSING" });
  }
  const session = await client.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: config.billingSuccessUrl
  });
  return session.url;
}

function subscriptionPeriod(subscription: Stripe.Subscription): { startMs: number; endMs: number } {
  const value = subscription as unknown as {
    created: number;
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  const firstItem = value.items?.data?.[0];
  return {
    startMs: (value.current_period_start ?? firstItem?.current_period_start ?? value.created) * 1_000,
    endMs: (value.current_period_end ?? firstItem?.current_period_end ?? value.created) * 1_000
  };
}

function stringId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function synchronizeSubscription(subscription: Stripe.Subscription): Promise<void> {
  const metadata = subscription.metadata;
  const existing = await getSubscriptionByStripeId(subscription.id);
  const userId = metadata.workcrew_user_id ?? existing?.userId;
  if (!userId) throw new Error(`Subscription ${subscription.id} has no WorkCrew user mapping`);

  const firstPrice = subscription.items.data[0]?.price.id;
  const identified = firstPrice ? identifyPrice(firstPrice) : null;
  const plan = identified?.plan ?? (metadata.workcrew_plan as PlanId | undefined) ?? existing?.plan;
  const interval = identified?.interval ?? (metadata.workcrew_interval as BillingInterval | undefined) ?? existing?.interval;
  if (!plan || !interval || !(plan in PLAN_CATALOG)) {
    throw new Error(`Subscription ${subscription.id} uses an unknown price`);
  }

  const period = subscriptionPeriod(subscription);
  // Entitlement comes from the centralized policy. Strict by default: only
  // active/trialing count; past_due requires the explicit grace-period flag.
  const active = isEntitledStatus(subscription.status);
  // The auto-reload settings and saved card are managed elsewhere; the upsert
  // never writes them, so this identity/budget row deliberately omits them.
  const row = {
    userId,
    stripeCustomerId: stringId(subscription.customer),
    stripeSubscriptionId: subscription.id,
    plan,
    interval,
    status: subscription.status,
    active,
    budgetAnchorMs: existing?.budgetAnchorMs ?? period.startMs,
    currentPeriodEndMs: period.endMs
  };
  await upsertSubscription(row);
  // The first time a referred user becomes a paying subscriber, credit the
  // inviter. Guarded in the database, so repeated subscription webhook events
  // (created, updated, renewals) never double-credit.
  if (active) await creditReferralOnPayment(userId, REFERRAL_BONUS_MICRODOLLARS);
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<{ type: string; duplicate: boolean }> {
  const client = requireStripe();
  if (!config.stripeWebhookSecret) throw new Error("Stripe webhook secret is not configured");
  // Throws StripeSignatureVerificationError on a forged/invalid signature; the
  // route catches that and logs a security event with a 400, not a 500.
  const event = client.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);

  // Skip an event we have already fully processed. We check BEFORE processing but
  // record only AFTER, so an event whose handler throws is never marked done and
  // Stripe's automatic retry reprocesses it. The handlers below are idempotent
  // (upsert by subscription), so a rare reprocess is harmless.
  if (await hasStripeEvent(event.id)) return { type: event.type, duplicate: true };

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    // A pending upgrade whose payment cleared after extra authentication, or one
    // that expired unpaid. synchronizeSubscription re-derives the plan from the
    // live price, so the grant (applied) or non-grant (expired) is always correct.
    case "customer.subscription.pending_update_applied":
    case "customer.subscription.pending_update_expired":
      await synchronizeSubscription(event.data.object);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
      // A completed first-time subscription checkout. (Plan upgrades for existing
      // subscribers are charged in place and arrive as customer.subscription.updated
      // or customer.subscription.pending_update_applied, handled above.)
      if (typeof session.subscription === "string") {
        await synchronizeSubscription(await client.subscriptions.retrieve(session.subscription));
      }
      break;
    }
    default:
      break;
  }

  // Mark handled only after the switch succeeded.
  await recordStripeEvent(event.id, event.type);
  return { type: event.type, duplicate: false };
}
