import { stripeStatusSchema, type BillingInterval, type PlanId } from "@workcrew/contracts";
import { upsertSubscription } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The billing provider contract. The real Stripe path (billing.ts) drives
// checkout and webhooks; this simulated path writes the same entitlement rows
// directly so the paywall behaves identically without a paid Stripe account.
// Both must write the exact same Stripe status vocabulary so the entitlement
// guard cannot tell them apart.
export interface BillingProvider {
  /**
   * Provision an active subscription for the given user and return nothing; the
   * caller reads the resulting entitlement back through subscriptionState. The
   * simulated provider writes through the same upsertSubscription path the real
   * Stripe webhook uses.
   */
  activate(userId: string, plan: PlanId, interval: BillingInterval): Promise<void>;
}

export class SimulatedBillingProvider implements BillingProvider {
  async activate(userId: string, plan: PlanId, interval: BillingInterval): Promise<void> {
    const now = Date.now();
    // Yearly grants a 365 day period, monthly a 30 day period.
    const periodDays = interval === "year" ? 365 : 30;
    const currentPeriodEndMs = now + periodDays * DAY_MS;

    // Draw the status from the shared Stripe vocabulary so the simulated and the
    // real billing paths write byte identical values.
    const status = stripeStatusSchema.parse("active");

    await upsertSubscription({
      userId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan,
      interval,
      status,
      active: true,
      // Anchor the monthly budget window at activation time.
      budgetAnchorMs: now,
      currentPeriodEndMs
    });
  }
}

export const simulatedBillingProvider = new SimulatedBillingProvider();
