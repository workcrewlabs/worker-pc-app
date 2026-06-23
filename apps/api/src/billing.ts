import Stripe from "stripe";
import { PLAN_CATALOG, REFERRAL_BONUS_MICRODOLLARS, type BillingInterval, type PlanId } from "@workcrew/contracts";
import { config } from "./config.js";
import {
  creditReferrer,
  getSubscription,
  getSubscriptionByStripeId,
  hasStripeEvent,
  recordStripeEvent,
  upsertSubscription,
  type SubscriptionRow
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

// Switch an existing active subscription to a different plan or interval (for
// example Pro to Ultra) in place, with proration, instead of opening a second
// checkout and creating a duplicate subscription. The webhook also fires, but we
// synchronize here too so the caller can return the fresh state immediately.
export async function changePlan(userId: string, plan: PlanId, interval: BillingInterval): Promise<void> {
  const client = requireStripe();
  const subscription = await getSubscription(userId);
  if (!subscription?.stripeSubscriptionId) {
    throw Object.assign(new Error("No active subscription to change"), { statusCode: 409, code: "NO_SUBSCRIPTION" });
  }
  const stripeSub = await client.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error("Subscription has no item to update");

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
  // Treat trialing and past_due as still entitled. "past_due" is Stripe's grace
  // window while it retries a payment, and "trialing" is a live trial, so a
  // paying customer is not locked out the instant a renewal or an in-place plan
  // upgrade is briefly not "active". A truly ended subscription becomes
  // canceled/unpaid, which correctly falls through to inactive.
  const active = ["active", "trialing", "past_due"].includes(subscription.status);
  const row: SubscriptionRow = {
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
  if (active) await creditReferrer(userId, REFERRAL_BONUS_MICRODOLLARS);
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const client = requireStripe();
  if (!config.stripeWebhookSecret) throw new Error("Stripe webhook secret is not configured");
  const event = client.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);

  // Skip an event we have already fully processed. We check BEFORE processing but
  // record only AFTER, so an event whose handler throws is never marked done and
  // Stripe's automatic retry reprocesses it. The handlers below are idempotent
  // (upsert by subscription), so a rare reprocess is harmless.
  if (await hasStripeEvent(event.id)) return;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await synchronizeSubscription(event.data.object);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
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
}
