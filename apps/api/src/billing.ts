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
  clearPendingDowngrade,
  getSubscription,
  getSubscriptionByStripeId,
  hasStripeEvent,
  recordStripeEvent,
  setPendingDowngrade,
  upsertSubscription
} from "./db.js";

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

function requireStripe(): Stripe {
  if (!stripe) {
    throw Object.assign(new Error("Billing is not configured"), { statusCode: 503, code: "BILLING_UNAVAILABLE" });
  }
  return stripe;
}

// Best-effort: make the account's customer portal charge an upgrade's prorated
// difference IMMEDIATELY (on the confirm page) instead of deferring it to the next
// invoice. Stripe controls this only through the portal configuration's
// subscription-update proration_behavior, so we flip the owner's EXISTING default
// configuration to always_invoice, reusing the fields they already set up, rather
// than creating a new configuration from scratch (which a live account rejects).
// Run before opening the upgrade page; the caller swallows any failure so the page
// still opens even if this cannot be applied, in which case proration falls back to
// Stripe's default timing.
let immediateProrationEnsured = false;
async function ensureImmediateUpgradeProration(client: Stripe): Promise<void> {
  if (immediateProrationEnsured) return;
  const configs = await client.billingPortal.configurations.list({ active: true, limit: 100 });
  const target = configs.data.find((c) => c.is_default) ?? configs.data[0];
  const feature = target?.features.subscription_update;
  if (!target || !feature?.enabled) return;
  if (feature.proration_behavior === "always_invoice") {
    immediateProrationEnsured = true;
    return;
  }
  await client.billingPortal.configurations.update(target.id, {
    features: {
      subscription_update: {
        enabled: true,
        default_allowed_updates: feature.default_allowed_updates,
        products: feature.products?.map((p) => ({ product: p.product, prices: [...p.prices] })),
        proration_behavior: "always_invoice"
      }
    }
  });
  immediateProrationEnsured = true;
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

// Build the two phases for a scheduled downgrade: keep the current (already paid
// for) price until the end of the current period, then start the new lower price
// at renewal. Pure, so the phase shape is unit tested without calling Stripe.
export function downgradeSchedulePhases(
  currentPriceId: string,
  newPriceId: string,
  period: { start: number; end: number },
  meta: { userId: string; plan: PlanId; interval: BillingInterval }
): Stripe.SubscriptionScheduleUpdateParams.Phase[] {
  return [
    {
      items: [{ price: currentPriceId, quantity: 1 }],
      start_date: period.start,
      end_date: period.end
    },
    {
      items: [{ price: newPriceId, quantity: 1 }],
      metadata: {
        workcrew_user_id: meta.userId,
        workcrew_plan: meta.plan,
        workcrew_interval: meta.interval
      }
    }
  ];
}

// Switch an existing active subscription to a different plan or interval (for
// example Pro to Ultra), instead of opening a second checkout and creating a
// duplicate subscription.
//
// An UPGRADE (a higher-allowance plan) sends the customer to a hosted Stripe page
// (the customer portal's subscription update confirm flow) that shows the prorated
// difference and collects payment to confirm the change. It uses the account's
// existing portal configuration and, best-effort, sets that portal's proration to
// "always_invoice" so the difference is charged now rather than on the next
// invoice. The subscription moves to the higher tier and the grant is applied only
// after that payment, via the customer.subscription.updated / pending_update_applied
// webhook, so the higher allowance is never granted for free. This returns a
// { url } to open in the browser.
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
    // Send the customer to a hosted Stripe page (the customer portal's subscription
    // update confirm flow) that shows the prorated difference and collects payment
    // to confirm the upgrade. We use the account's existing (default) portal
    // configuration, which the owner already set up, so there is nothing fragile to
    // create. The subscription moves to the higher tier and the grant is applied
    // only after that payment, via the customer.subscription.updated /
    // pending_update_applied webhook, so the higher allowance is never granted for
    // free. First, best-effort, make that page charge the difference now rather than
    // on the next invoice; if it cannot be set the page still opens.
    await ensureImmediateUpgradeProration(client).catch(() => {});
    // Starting an upgrade cancels any pending downgrade. The Stripe schedule must be
    // released before the portal can edit the subscription item (otherwise the
    // schedule fights the portal change), and the schedule cannot be partially
    // released, so this is intentional: choosing to upgrade discards a previously
    // scheduled downgrade. If the user then abandons the hosted page without paying,
    // they simply stay on their current plan with no pending change (they keep the
    // tier they are already paying for), which is the safe outcome.
    const pendingScheduleId = stringId(stripeSub.schedule);
    if (pendingScheduleId) {
      await client.subscriptionSchedules.release(pendingScheduleId).catch(() => {});
    }
    await clearPendingDowngrade(userId);
    let session: Stripe.BillingPortal.Session;
    try {
      session = await client.billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: subscription.stripeSubscriptionId,
            items: [{ id: itemId, price: priceId(plan, interval), quantity: 1 }]
          },
          after_completion: { type: "redirect", redirect: { return_url: config.billingSuccessUrl } }
        }
      });
    } catch (error) {
      // The most common cause is that the Customer Portal has not been activated in
      // the Stripe dashboard. Surface a clean message and keep the user on their
      // current plan; the detail is logged server side.
      throw Object.assign(
        new Error("We could not start the upgrade. Please try again in a moment."),
        { statusCode: 502, code: "UPGRADE_FAILED", cause: error }
      );
    }
    if (!session.url) throw new Error("Stripe did not return an upgrade payment URL");
    return { url: session.url };
  }

  // Downgrade: the user already paid for the current period at the higher tier, so
  // keep their higher allowance until that period ends, then switch to the lower
  // plan at renewal. The limit must never drop mid-period. We do this with a Stripe
  // subscription schedule: phase 1 keeps the current price until period end, phase 2
  // starts the new (lower) price after. The live price is unchanged now, so the
  // entitlement (derived from it) stays high until Stripe advances the schedule at
  // period end and fires customer.subscription.updated, which lowers it then.
  if (subscription.plan === plan && subscription.interval === interval) {
    // Re-selecting the current plan cancels any scheduled downgrade: release the
    // schedule so renewals continue on the current plan, and clear the marker.
    const existingScheduleId = stringId(stripeSub.schedule);
    if (existingScheduleId) await client.subscriptionSchedules.release(existingScheduleId).catch(() => {});
    await clearPendingDowngrade(userId);
    return { changed: true };
  }

  const currentPriceId = stripeSub.items.data[0]?.price.id;
  if (!currentPriceId) throw new Error("Subscription has no current price to schedule a downgrade from");

  // Reuse an existing schedule (e.g. the user changed a pending downgrade) or create
  // one mirroring the live subscription. Either way phase 0 is the current period.
  const existingScheduleId = stringId(stripeSub.schedule);
  const schedule = existingScheduleId
    ? await client.subscriptionSchedules.retrieve(existingScheduleId)
    : await client.subscriptionSchedules.create({ from_subscription: subscription.stripeSubscriptionId });
  const currentPhase = schedule.phases[0];
  if (!currentPhase) throw new Error("Subscription schedule is missing its current phase");

  await client.subscriptionSchedules.update(schedule.id, {
    // After the new (lower) phase begins, release the schedule back to a normal
    // subscription so future renewals just continue on the new plan.
    end_behavior: "release",
    metadata: { workcrew_user_id: userId },
    phases: downgradeSchedulePhases(
      currentPriceId,
      priceId(plan, interval),
      { start: currentPhase.start_date, end: currentPhase.end_date },
      { userId, plan, interval }
    )
  });

  // Do NOT lower the entitlement now. Re-sync from the live (still higher) price so
  // our record stays on the paid plan; the webhook lowers it when the schedule
  // advances at period end.
  await synchronizeSubscription(await client.subscriptions.retrieve(subscription.stripeSubscriptionId));
  // Record the scheduled downgrade so the app can tell the user their current limit
  // holds until period end and then becomes the lower plan. currentPhase.end_date is
  // in seconds; the lower plan begins exactly then.
  await setPendingDowngrade(userId, plan, interval, currentPhase.end_date * 1_000);
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
  // If a scheduled downgrade has now taken effect (the live plan AND interval equal
  // what was pending), clear the marker so the app stops advertising a future
  // change. Both must match: an interval-only downgrade (e.g. Ultra yearly to Ultra
  // monthly) keeps the same plan, so comparing the plan alone would wipe the marker
  // early on any unrelated webhook while the higher interval is still live. The
  // upsert above leaves the pending columns untouched, so this is the one place a
  // landed downgrade is reconciled.
  if (existing?.pendingPlan && plan === existing.pendingPlan && interval === existing.pendingInterval) {
    await clearPendingDowngrade(userId);
  }
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
