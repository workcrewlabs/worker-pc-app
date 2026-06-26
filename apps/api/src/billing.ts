import Stripe from "stripe";
import {
  PLAN_CATALOG,
  REFERRAL_BONUS_MICRODOLLARS,
  TOKEN_PACKS,
  tokenPackGrant,
  tokenPackIdSchema,
  type BillingInterval,
  type PlanId,
  type TokenPackId
} from "@workcrew/contracts";
import { config } from "./config.js";
import { creditReferralOnPayment, grantTokenCredit, tokenPackCharge } from "./budget.js";
import {
  getSubscription,
  getSubscriptionByStripeId,
  hasStripeEvent,
  recordStripeEvent,
  setPaymentMethod,
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

// The recurring price of a plan/interval in dollars, used to tell an upgrade
// (must be paid before access is granted) from a downgrade (a credit).
function planPriceUsd(plan: PlanId, interval: BillingInterval): number {
  const item = PLAN_CATALOG[plan];
  return interval === "year" ? item.yearlyPriceUsd : item.monthlyPriceUsd;
}

// Switch an existing active subscription to a different plan or interval (for
// example Pro to Ultra) in place, with proration, instead of opening a second
// checkout and creating a duplicate subscription. The webhook also fires, but we
// synchronize here too so the caller can return the fresh state immediately.
//
// An UPGRADE (the new plan costs more) must be PAID before the higher tier is
// granted, so a click can never hand a user a more expensive plan for free:
// always_invoice bills the prorated difference immediately and
// error_if_incomplete makes the change throw (no plan change, no grant) if that
// charge cannot be collected now. A DOWNGRADE is a credit, applied normally.
export async function changePlan(userId: string, plan: PlanId, interval: BillingInterval): Promise<void> {
  const client = requireStripe();
  const subscription = await getSubscription(userId);
  if (!subscription?.stripeSubscriptionId) {
    throw Object.assign(new Error("No active subscription to change"), { statusCode: 409, code: "NO_SUBSCRIPTION" });
  }
  const stripeSub = await client.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error("Subscription has no item to update");

  const isUpgrade = planPriceUsd(plan, interval) > planPriceUsd(subscription.plan, subscription.interval);

  let updated: Stripe.Subscription;
  try {
    updated = await client.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: itemId, price: priceId(plan, interval) }],
      proration_behavior: isUpgrade ? "always_invoice" : "create_prorations",
      payment_behavior: isUpgrade ? "error_if_incomplete" : "allow_incomplete",
      metadata: {
        workcrew_user_id: userId,
        workcrew_plan: plan,
        workcrew_interval: interval
      }
    });
  } catch (error) {
    if (isUpgrade) {
      // The prorated upgrade charge could not be collected, so the plan was NOT
      // changed and the higher tier is NOT granted. Surface a clear, safe message
      // and keep the user on their current plan.
      throw Object.assign(
        new Error("We could not complete the payment for this upgrade, so your plan was not changed. Please check your card in Manage billing and try again."),
        { statusCode: 402, code: "UPGRADE_PAYMENT_FAILED" }
      );
    }
    throw error;
  }
  await synchronizeSubscription(updated);
}

// Buy a one-time token pack via a hosted Stripe Checkout (mode=payment). The card
// used is saved for future off-session auto-reload. A configured price is used
// when present; otherwise an ad-hoc price is built from the pack catalog so the
// flow works before the owner creates the Stripe prices.
export async function createTopupCheckout(userId: string, pack: TokenPackId): Promise<string> {
  const client = requireStripe();
  const existing = await getSubscription(userId);
  const customerId = existing?.stripeCustomerId ?? undefined;
  const item = TOKEN_PACKS[pack];
  const configuredPrice = config.stripeTopupPrices[pack];
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = configuredPrice
    ? { price: configuredPrice, quantity: 1 }
    : {
        price_data: {
          currency: "usd",
          product_data: { name: "WorkCrew tokens" },
          unit_amount: item.priceUsd * 100
        },
        quantity: 1
      };

  const session = await client.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    ...(customerId ? { customer_update: { name: "auto" as const, address: "auto" as const } } : { customer_creation: "always" as const }),
    client_reference_id: userId,
    line_items: [lineItem],
    // Save the card so auto-reload can charge it later without the user present.
    payment_intent_data: { setup_future_usage: "off_session" },
    billing_address_collection: "auto",
    metadata: { workcrew_user_id: userId, workcrew_topup_pack: pack },
    success_url: `${config.billingSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: config.billingCancelUrl
  });

  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// Charge the user's saved card for one auto-reload pack, off-session. Returns
// true only when the charge succeeded; the caller grants the tokens. A decline or
// an authentication requirement returns false and no tokens are added. The
// idempotency key makes a retried or concurrent charge for the SAME exhaustion
// event resolve to a single PaymentIntent at Stripe, so the card is never double
// charged for one reload.
export async function chargeAutoReload(subscription: SubscriptionRow, pack: TokenPackId, idempotencyKey?: string): Promise<boolean> {
  const client = requireStripe();
  if (!subscription.stripeCustomerId || !subscription.stripePaymentMethodId) return false;
  const item = TOKEN_PACKS[pack];
  try {
    const intent = await client.paymentIntents.create(
      {
        amount: item.priceUsd * 100,
        currency: "usd",
        customer: subscription.stripeCustomerId,
        payment_method: subscription.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { workcrew_user_id: subscription.userId, workcrew_topup_pack: pack, workcrew_auto_reload: "1" }
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
    return intent.status === "succeeded";
  } catch {
    return false;
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

// Fulfill a completed one-time top-up checkout: grant the purchased tokens and
// save the card (set as the customer default) so auto-reload can use it later.
// The grant is made idempotent at the credit write via dedupeId (stored in
// usage_ledger.dedupe_id, unique-indexed), so two identical webhook deliveries
// processed concurrently grant the tokens exactly once. The stripe_events guard
// around the webhook is a second, coarser layer, not the primary protection.
async function fulfillTopup(client: Stripe, session: Stripe.Checkout.Session, dedupeId: string): Promise<void> {
  const userId = session.metadata?.workcrew_user_id ?? session.client_reference_id ?? undefined;
  const parsedPack = tokenPackIdSchema.safeParse(session.metadata?.workcrew_topup_pack);
  if (!userId || !parsedPack.success) return;
  const pack = parsedPack.data;

  const customerId = stringId(session.customer);
  if (customerId && typeof session.payment_intent === "string") {
    const intent = await client.paymentIntents.retrieve(session.payment_intent);
    const paymentMethodId = stringId(intent.payment_method as string | { id: string } | null);
    if (paymentMethodId) {
      await client.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
      await setPaymentMethod(userId, paymentMethodId);
    }
  }

  await grantTokenCredit({
    userId,
    grantedMicrodollars: tokenPackGrant(pack),
    chargedMicrodollars: tokenPackCharge(pack),
    source: "token_topup",
    providerRequestId: typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    dedupeId
  });
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
      await synchronizeSubscription(event.data.object);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
      // A one-time token top-up: grant the tokens and remember the card. The
      // dedupe key prefers the payment intent (stable per charge) and falls back
      // to the event id; it is enforced at the credit write so two concurrent
      // identical deliveries cannot double-credit even if both pass the
      // stripe_events check before either records it.
      if (session.mode === "payment" && session.metadata?.workcrew_topup_pack) {
        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
        const dedupeId = `topup:${paymentIntentId ?? event.id}`;
        await fulfillTopup(client, session, dedupeId);
      } else if (typeof session.subscription === "string") {
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
