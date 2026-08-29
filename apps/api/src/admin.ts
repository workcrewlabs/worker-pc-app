import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PLAN_CATALOG, paidPlanIdSchema, type PaidPlanId, type PlanId } from "@workcrew/contracts";
import { authenticate } from "./auth.js";
import { createPasswordCredential } from "./auth-local.js";
import { budgetWindowFor, planBudget } from "./budget.js";
import { config } from "./config.js";
import {
  createUser,
  getSubscription,
  getUserByEmail,
  getUserById,
  listAdminAudit,
  listAdminCustomers,
  listUsageByPeriodForUsers,
  recordAdminAction,
  revokeUserSessions,
  updateUserPassword,
  upsertSubscription,
  type AdminCustomerRow,
  type UsagePeriodRow
} from "./db.js";
import { z } from "zod";

/**
 * The operator's dashboard for selling access by hand. It exists because billing
 * can run in manual mode, where there is no payment processor: a customer pays
 * the operator directly and an admin switches their access on for a number of
 * months. Access still expires by itself, because every request checks the
 * subscription's active flag and period end, so "one month" is simply an end date
 * one month out and nothing has to remember to turn it off.
 *
 * Security posture:
 *  - Admission is an explicit email allowlist (WORKCREW_ADMIN_EMAILS) checked
 *    against the email on the VERIFIED token's user, never anything the client
 *    sends. An empty allowlist closes the dashboard to everyone.
 *  - A non-admin gets 404, not 403, so the surface is not advertised.
 *  - Every state change is written to admin_audit with who did it.
 *  - Grants go through the same upsertSubscription path Stripe uses, so there is
 *    one entitlement writer and the guards cannot tell the paths apart.
 */

/** An admin's identity, resolved from the verified token. */
export type AdminActor = { userId: string; email: string };

/**
 * Authenticate and confirm the caller is an admin. Throws 404 for everyone else
 * (including valid non-admin users) so the dashboard does not reveal itself, and
 * logs a distinct security event on each refusal.
 */
export async function requireAdmin(request: FastifyRequest): Promise<AdminActor> {
  const userId = await authenticate(request);
  const notFound = Object.assign(new Error("Not found"), { statusCode: 404, code: "NOT_FOUND" });

  if (config.adminEmails.size === 0) {
    request.log.warn({ event: "admin_denied", reason: "no_admins_configured", userId }, "admin access denied");
    throw notFound;
  }
  const user = await getUserById(userId);
  const email = user?.email?.trim().toLowerCase() ?? "";
  if (!email || !config.adminEmails.has(email)) {
    request.log.warn({ event: "admin_denied", reason: "not_allowlisted", userId }, "admin access denied");
    throw notFound;
  }
  return { userId, email };
}

// Request shapes. Every field is bounded and unknown fields are rejected.
export const adminListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
}).strict();

export const adminCreateCustomerSchema = z.object({
  email: z.string().trim().email().max(320),
  // Matches the sign-up policy so a hand-made account is never weaker than one
  // the customer would have created themselves.
  password: z.string().min(10).max(1_024),
  name: z.string().trim().max(80).optional(),
  plan: paidPlanIdSchema,
  months: z.number().int().min(1).max(24)
}).strict();

export const adminGrantSchema = z.object({
  plan: paidPlanIdSchema,
  months: z.number().int().min(1).max(24)
}).strict();

export const adminPasswordSchema = z.object({
  password: z.string().min(10).max(1_024)
}).strict();

export const adminUserParamSchema = z.object({
  userId: z.string().uuid()
}).strict();

/**
 * Add whole calendar months to a timestamp, clamping the day so 31 January plus
 * one month lands on the last day of February rather than skipping into March.
 */
export function addMonths(fromMs: number, months: number): number {
  const from = new Date(fromMs);
  const target = new Date(from.getTime());
  target.setMonth(target.getMonth() + months);
  // setMonth rolls over when the day does not exist in the target month; pull it
  // back to that month's last day.
  if (target.getDate() < from.getDate()) target.setDate(0);
  return target.getTime();
}

/** One hundred years out: the free plan has no billing period to expire. */
function freePeriodEnd(nowMs: number): number {
  return nowMs + 100 * 365 * 24 * 60 * 60 * 1000;
}

/** The stored plan name as a plan we actually know, or null for an account with none. */
function knownPlan(plan: string | null): PlanId | null {
  return plan !== null && Object.prototype.hasOwnProperty.call(PLAN_CATALOG, plan) ? (plan as PlanId) : null;
}

/**
 * What one account has spent of its monthly allowance, and what that allowance
 * is, both in microdollars.
 *
 * Committed spend, not settled spend: money already charged plus money held for
 * turns still running, which is exactly the figure reserveBudget measures the
 * cap against. Showing settled only would read low while a run was in flight and
 * leave the dashboard disagreeing with the wall the customer just hit.
 *
 * Referral credits are written as negative settled rows, so a heavily credited
 * account can sum below zero. Clamped, because "spent minus four dollars" is not
 * a thing anyone needs to read.
 */
function monthlySpendFor(
  row: AdminCustomerRow,
  periods: UsagePeriodRow[],
  nowMs: number
): { spent: number; limit: number } {
  const plan = knownPlan(row.plan);
  if (plan === null || row.budgetAnchorMs === null) return { spent: 0, limit: 0 };
  const window = budgetWindowFor({ plan, budgetAnchorMs: row.budgetAnchorMs }, nowMs);
  const match = periods.find(
    (period) => period.periodStartMs === window.startMs && period.periodEndMs === window.endMs
  );
  return {
    spent: match ? Math.max(0, match.used + match.reserved) : 0,
    limit: planBudget(plan)
  };
}

/**
 * The customer list, with each row's access state resolved server side.
 *
 * hasAccess answers the only question that matters, using the same rule the
 * entitlement guard applies on every request: a paid plan, an active row, AND a
 * period end still in the future. Deciding it here rather than in the page means
 * the dashboard can never disagree with what the product actually enforces, so a
 * customer whose month has run out is never shown as still paying.
 *
 * Each row also carries what that account has run up against its monthly API
 * allowance this period, so the cost of serving somebody is visible next to what
 * they pay rather than having to be looked up per customer.
 */
export async function adminListCustomers(query: unknown): Promise<{
  customers: (AdminCustomerRow & {
    hasAccess: boolean;
    expired: boolean;
    daysLeft: number | null;
    monthlySpentMicrodollars: number;
    monthlyLimitMicrodollars: number;
    monthlyPercent: number | null;
  })[];
  total: number;
}> {
  const input = adminListQuerySchema.parse(query);
  const { rows, total } = await listAdminCustomers({ search: input.search, limit: input.limit, offset: input.offset });
  const now = Date.now();

  // One ledger query for the whole page, then matched to each row in memory.
  const usage = await listUsageByPeriodForUsers(rows.map((row) => row.userId));
  const periodsByUser = new Map<string, UsagePeriodRow[]>();
  for (const period of usage) {
    const existing = periodsByUser.get(period.userId);
    if (existing) existing.push(period);
    else periodsByUser.set(period.userId, [period]);
  }

  const customers = rows.map((row) => {
    const paidPlan = Boolean(row.plan && row.plan !== "free" && row.active);
    const hasAccess = paidPlan && row.currentPeriodEndMs !== null && row.currentPeriodEndMs > now;
    const { spent, limit } = monthlySpendFor(row, periodsByUser.get(row.userId) ?? [], now);
    return {
      ...row,
      monthlySpentMicrodollars: spent,
      monthlyLimitMicrodollars: limit,
      // Null rather than zero when there is no allowance to be a share of, so
      // the page shows a dash instead of a bar sitting reassuringly at 0%.
      monthlyPercent: limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : null,
      hasAccess,
      // Held a paid plan whose period has already run out: they are on the
      // paywall right now and are the ones to chase for payment.
      expired: paidPlan && !hasAccess,
      // Only a running period has a meaningful countdown. The free plan's
      // hundred-year end date would read as nonsense, so it reports null.
      daysLeft: hasAccess && row.currentPeriodEndMs !== null
        ? Math.max(0, Math.ceil((row.currentPeriodEndMs - now) / (24 * 60 * 60 * 1000)))
        : null
    };
  });
  return { customers, total };
}

/**
 * Give a user paid access for a number of months. Time is added to whatever they
 * already have: an expired or missing subscription starts from now, an active one
 * is extended from its current end date, so paying two months running stacks
 * instead of overwriting.
 *
 * The budget anchor (which decides when the monthly token allowance renews) is
 * only reset when access was NOT already running. Extending an active customer
 * keeps their anchor, so a mid-period top-up cannot hand out a second monthly
 * allowance early.
 */
export async function adminGrantAccess(
  actor: AdminActor,
  targetUserId: string,
  plan: PaidPlanId,
  months: number
): Promise<{ currentPeriodEndMs: number }> {
  // Re-check the bound here, not only at the route. This function decides how
  // long someone can use a paid product, so it must refuse a nonsense length even
  // if a future caller forgets to validate: 0 months would grant access that has
  // already expired, and an unbounded value would hand out years by accident.
  const { months: safeMonths } = adminGrantSchema.pick({ months: true }).parse({ months });

  const user = await getUserById(targetUserId);
  if (!user) throw Object.assign(new Error("That customer no longer exists"), { statusCode: 404, code: "NOT_FOUND" });

  const now = Date.now();
  const existing = await getSubscription(targetUserId);
  const stillRunning =
    existing !== null && existing.active && existing.plan !== "free" && existing.currentPeriodEndMs > now;
  const startFromMs = stillRunning ? existing.currentPeriodEndMs : now;
  const currentPeriodEndMs = addMonths(startFromMs, safeMonths);

  await upsertSubscription({
    userId: targetUserId,
    // A manual grant has no Stripe objects behind it. Clearing these keeps the
    // row honest and means a future processor can claim the account cleanly.
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan,
    interval: "month",
    // The same status vocabulary the Stripe and simulated paths write, so every
    // entitlement check downstream behaves identically.
    status: "active",
    active: true,
    budgetAnchorMs: stillRunning ? existing.budgetAnchorMs : now,
    currentPeriodEndMs
  });

  await recordAdminAction({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: stillRunning ? "extend_access" : "grant_access",
    targetUserId,
    targetEmail: user.email,
    detail: `${plan} for ${safeMonths} month${safeMonths === 1 ? "" : "s"}`
  });
  return { currentPeriodEndMs };
}

/**
 * Create an account by hand and give it paid access. The account is created
 * already verified: the operator has met this customer and taken their money, so
 * making them wait for a verification email would only block a paying user.
 */
export async function adminCreateCustomer(actor: AdminActor, body: unknown): Promise<{ userId: string; email: string; currentPeriodEndMs: number }> {
  const input = adminCreateCustomerSchema.parse(body);
  const email = input.email.toLowerCase();

  const existing = await getUserByEmail(email);
  if (existing) {
    throw Object.assign(
      new Error("That email already has an account. Use Add months on their row instead."),
      { statusCode: 409, code: "EMAIL_IN_USE" }
    );
  }

  const userId = randomUUID();
  const { passwordHash, passwordSalt } = await createPasswordCredential(input.password);
  await createUser({
    id: userId,
    email,
    passwordHash,
    passwordSalt,
    emailVerified: true,
    name: input.name && input.name.length > 0 ? input.name : null
  });
  await recordAdminAction({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "create_account",
    targetUserId: userId,
    targetEmail: email,
    detail: "created from the admin dashboard"
  });

  const { currentPeriodEndMs } = await adminGrantAccess(actor, userId, input.plan, input.months);
  return { userId, email, currentPeriodEndMs };
}

/**
 * Take paid access away now. The account, its chats and its files all survive:
 * the customer drops to the free plan and sees the upgrade screen, so paying
 * again is one click on the operator's side.
 */
export async function adminRevokeAccess(actor: AdminActor, targetUserId: string): Promise<void> {
  const user = await getUserById(targetUserId);
  if (!user) throw Object.assign(new Error("That customer no longer exists"), { statusCode: 404, code: "NOT_FOUND" });

  const now = Date.now();
  const existing = await getSubscription(targetUserId);
  await upsertSubscription({
    userId: targetUserId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: "free",
    interval: "month",
    status: "free",
    // The free tier is a real, usable plan, so the row stays active; the small
    // free allowance is what limits it, exactly as for a self-serve free signup.
    active: true,
    // Keep the existing anchor so dropping to free does not hand out a fresh
    // monthly allowance the moment access is removed.
    budgetAnchorMs: existing?.budgetAnchorMs ?? now,
    currentPeriodEndMs: freePeriodEnd(now)
  });

  await recordAdminAction({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "revoke_access",
    targetUserId,
    targetEmail: user.email,
    detail: `moved to the free plan from ${existing?.plan ?? "no plan"}`
  });
}

/**
 * Set a customer's password, for when someone who paid cash cannot get in. Every
 * existing session is revoked so an old device cannot keep the previous
 * credentials alive.
 */
export async function adminSetPassword(actor: AdminActor, targetUserId: string, body: unknown): Promise<void> {
  const input = adminPasswordSchema.parse(body);
  const user = await getUserById(targetUserId);
  if (!user) throw Object.assign(new Error("That customer no longer exists"), { statusCode: 404, code: "NOT_FOUND" });

  const { passwordHash, passwordSalt } = await createPasswordCredential(input.password);
  await updateUserPassword(targetUserId, passwordHash, passwordSalt);
  await revokeUserSessions(targetUserId);

  await recordAdminAction({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "reset_password",
    targetUserId,
    targetEmail: user.email,
    detail: "password set from the admin dashboard"
  });
}

/** The recent admin actions shown at the bottom of the dashboard. */
export async function adminRecentActivity(): Promise<Awaited<ReturnType<typeof listAdminAudit>>> {
  return listAdminAudit(50);
}
