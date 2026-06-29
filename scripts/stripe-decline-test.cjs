#!/usr/bin/env node
/*
 * Live subscription-lifecycle test driver for WorkCrew (Stripe TEST mode only).
 *
 * It uses a Stripe test clock to play out a real subscription against the LOCAL
 * backend, and delivers the resulting webhooks to the backend by signing them
 * with STRIPE_WEBHOOK_SECRET (so no Stripe CLI is needed). One subscription can
 * cover both the downgrade test and the card-decline test:
 *
 *   setup <email> [pro|ultra]   Create a test clock + customer (on the clock) +
 *                               a real subscription (default ultra) tied to the
 *                               local app account for <email>, paid with a good
 *                               test card, then tell the backend.
 *                               -> the app shows the user subscribed (month 1).
 *
 *   advance-cycle               Fast-forward to the next billing date with the
 *                               GOOD card so the renewal SUCCEEDS, then tell the
 *                               backend. Use this after the user downgrades in
 *                               the app: the scheduled lower plan takes effect at
 *                               the cycle boundary, so the limit drops only now.
 *
 *   decline                     Swap the card to one that fails on renewal, then
 *                               fast-forward past the next renewal so the charge
 *                               fails (subscription becomes past_due), then tell
 *                               the backend. -> the app blocks the user.
 *
 *   status                      Print the live Stripe status/price and the local
 *                               backend's stored subscription row (plan + active).
 *
 *   cleanup                     Delete the test clock and its customer/sub, and
 *                               clear local test state.
 *
 * Requires the worktree .env (STRIPE_SECRET_KEY=sk_test_..., STRIPE_WEBHOOK_SECRET,
 * the four STRIPE_*_PRICE_ID values) and the local backend running
 * (npm run dev -w @workcrew/api) before setup/advance-cycle/decline.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { createRequire } = require("module");

const repoRoot = path.resolve(__dirname, "..");
const apiDir = path.join(repoRoot, "apps", "api");
const apiRequire = createRequire(path.join(apiDir, "package.json"));

apiRequire("dotenv").config({ path: path.join(repoRoot, ".env") });
const Stripe = apiRequire("stripe");
const { createClient } = apiRequire("@libsql/client");

const SECRET = process.env.STRIPE_SECRET_KEY || "";
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || "";
const PRICE = {
  pro: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || "",
  ultra: process.env.STRIPE_ULTRA_MONTHLY_PRICE_ID || ""
};
const BACKEND = (process.env.WORKCREW_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const WEBHOOK_URL = `${BACKEND}/v1/billing/webhook`;
const STATE_FILE = path.join(os.tmpdir(), "workcrew-stripe-test-state.json");

function fail(message) {
  console.error(`\n[x] ${message}\n`);
  process.exit(1);
}
function ok(message) {
  console.log(`[ok] ${message}`);
}
function step(message) {
  console.log(`\n=== ${message} ===`);
}

if (!SECRET.startsWith("sk_test_")) {
  fail("STRIPE_SECRET_KEY in .env must be a Stripe TEST key (sk_test_...). Never use a live key here.");
}
if (!WHSEC) fail("STRIPE_WEBHOOK_SECRET is missing in .env.");

// This driver signs synthetic billing webhooks and POSTs them to WORKCREW_API_URL.
// Refuse any non-local target so a stray .env pointing at staging/production can
// never replay billing mutations against a shared backend.
let backendHost = "";
try {
  backendHost = new URL(BACKEND).hostname;
} catch {
  fail(`WORKCREW_API_URL is not a valid URL: ${BACKEND}`);
}
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(backendHost)) {
  fail(`This is a local-only test driver. WORKCREW_API_URL must point at localhost; got ${BACKEND}.`);
}

const stripe = new Stripe(SECRET);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

// The backend resolves a webhook to a user via subscription.metadata.workcrew_user_id,
// so we read the local sqlite database the backend writes (apps/api/workcrew.db) to
// find the user id for the email the tester signed up with. We match the backend's
// own relative file path by switching into apps/api first.
function openDb() {
  process.chdir(apiDir);
  return createClient({ url: "file:workcrew.db" });
}

async function findUserId(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) fail("Pass the email you signed up with: node scripts/stripe-decline-test.cjs setup you@example.com");
  const db = openDb();
  try {
    const result = await db.execute({ sql: "SELECT id FROM users WHERE email = ? LIMIT 1", args: [normalized] });
    return result.rows[0] ? String(result.rows[0].id) : null;
  } finally {
    db.close();
  }
}

async function readLocalSubscription(userId) {
  const db = openDb();
  try {
    const result = await db.execute({
      sql: "SELECT plan, status, active, current_period_end_ms FROM subscriptions WHERE user_id = ? LIMIT 1",
      args: [userId]
    });
    return result.rows[0] || null;
  } finally {
    db.close();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    fail("No test in progress. Run 'setup <email>' first.");
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

// Sign the event with the configured webhook secret and POST it to the local
// backend, exactly like Stripe would. The backend verifies the signature against
// the raw body, so a wrong secret here is rejected.
async function deliver(type, subscriptionObject) {
  const event = {
    id: `evt_localtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    object: "event",
    created: nowSec(),
    type,
    data: { object: subscriptionObject },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null }
  };
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  let res;
  try {
    res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": header },
      body: payload
    });
  } catch (error) {
    fail(`Could not reach the backend at ${WEBHOOK_URL}. Start it first: npm run dev -w @workcrew/api\n    (${error.message})`);
  }
  const text = await res.text();
  console.log(`    delivered ${type} -> HTTP ${res.status} ${text.slice(0, 160)}`);
  if (!res.ok) {
    fail(`Backend rejected the ${type} webhook (HTTP ${res.status}). Make sure the backend's STRIPE_WEBHOOK_SECRET matches .env.`);
  }
}

async function advanceClockTo(clockId, frozenTime) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime });
  for (let i = 0; i < 90; i += 1) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return;
    if (clock.status === "internal_failure") fail("Stripe test clock advance failed (internal_failure).");
    await sleep(2000);
  }
  fail("Timed out waiting for the Stripe test clock to finish advancing.");
}

function periodEndOf(subscription) {
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  return subscription.current_period_end || (item && item.current_period_end) || nowSec();
}

function planOfPrice(priceId) {
  if (priceId === PRICE.ultra) return "ultra";
  if (priceId === PRICE.pro) return "pro";
  return `(price ${priceId})`;
}

async function setup(email, planArg) {
  const plan = planArg === "pro" ? "pro" : "ultra";
  if (!PRICE[plan]) fail(`STRIPE_${plan.toUpperCase()}_MONTHLY_PRICE_ID is missing in .env. Run: node scripts/create-stripe-prices.cjs`);
  if (fs.existsSync(STATE_FILE)) {
    console.log("[i] A previous test is still recorded. Running 'cleanup' first.");
    await cleanup();
  }

  step("Finding the local app account");
  const userId = await findUserId(email);
  if (!userId) {
    fail(`No local account found for ${email}. In the app (pointed at the local backend), sign up with that email first, then rerun.`);
  }
  ok(`Local user id: ${userId}`);

  step("Canceling any existing live subscription for this account (e.g. from a manual checkout)");
  const existing = await stripe.subscriptions.list({ limit: 100, status: "all" });
  const mine = existing.data.filter(
    (s) => s.metadata && s.metadata.workcrew_user_id === userId &&
      ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status)
  );
  for (const s of mine) {
    await stripe.subscriptions.cancel(s.id).catch(() => {});
    ok(`Canceled prior subscription ${s.id}`);
  }
  if (!mine.length) console.log("  (none found)");

  step(`Creating a Stripe test clock + customer (subscribing to ${plan.toUpperCase()})`);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: nowSec(), name: "WorkCrew lifecycle test" });
  ok(`Test clock: ${clock.id}`);
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    email,
    name: "WorkCrew Test User",
    metadata: { workcrew_user_id: userId }
  });
  ok(`Customer: ${customer.id}`);

  const goodCard = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
  await stripe.paymentMethods.attach(goodCard.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: goodCard.id } });
  ok("Attached a good test card (Visa 4242).");

  let subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: PRICE[plan] }],
    default_payment_method: goodCard.id,
    metadata: { workcrew_user_id: userId, workcrew_plan: plan, workcrew_interval: "month" },
    expand: ["latest_invoice"]
  });
  if (subscription.status === "incomplete" && subscription.latest_invoice && subscription.latest_invoice.id) {
    await stripe.invoices.pay(subscription.latest_invoice.id);
    subscription = await stripe.subscriptions.retrieve(subscription.id);
  }
  ok(`Subscription: ${subscription.id} (Stripe status: ${subscription.status}, plan: ${plan})`);

  saveState({
    clockId: clock.id,
    customerId: customer.id,
    subscriptionId: subscription.id,
    goodCardId: goodCard.id,
    userId,
    email,
    plan
  });

  step("Telling the local backend the subscription started");
  const fresh = await stripe.subscriptions.retrieve(subscription.id);
  await deliver("customer.subscription.created", fresh);

  console.log("\n--------------------------------------------------------------");
  console.log(`MONTH 1 DONE. The app should now show ${plan.toUpperCase()} active.`);
  console.log("Click the WorkCrew window (or sign out/in) so it refreshes off the paywall.");
  console.log("To test the downgrade: in the app open Account -> Adjust plan -> switch to Pro,");
  console.log("then confirm the token limit is STILL the higher amount. Then run:");
  console.log("  node scripts/stripe-decline-test.cjs advance-cycle");
  console.log("--------------------------------------------------------------\n");
}

async function advanceCycle() {
  const state = loadState();
  step("Fast-forwarding to the next billing date (renewal should SUCCEED on the good card)");
  const before = await stripe.subscriptions.retrieve(state.subscriptionId);
  const target = periodEndOf(before) + 2 * 24 * 3600;
  await advanceClockTo(state.clockId, target);
  const after = await stripe.subscriptions.retrieve(state.subscriptionId);
  const livePlan = planOfPrice(after.items.data[0] && after.items.data[0].price.id);
  ok(`Renewal processed. Stripe status: ${after.status}. Current plan from live price: ${livePlan}`);

  step("Telling the local backend about the renewal");
  await deliver("customer.subscription.updated", after);

  console.log("\n--------------------------------------------------------------");
  console.log(`The live plan is now ${livePlan.toUpperCase()}. If you downgraded before this,`);
  console.log("the app's token limit should drop to the lower plan ONLY now (the period you");
  console.log("already paid for at the higher tier has ended).");
  console.log("To then test a declined card, run: node scripts/stripe-decline-test.cjs decline");
  console.log("--------------------------------------------------------------\n");
}

async function decline() {
  const state = loadState();

  step("Swapping to a card that fails on renewal");
  const badCard = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: state.customerId });
  await stripe.customers.update(state.customerId, { invoice_settings: { default_payment_method: badCard.id } });
  await stripe.subscriptions.update(state.subscriptionId, { default_payment_method: badCard.id });
  ok("Card on file now fails when charged.");

  step("Fast-forwarding past the next renewal so the charge declines");
  const before = await stripe.subscriptions.retrieve(state.subscriptionId);
  const target = periodEndOf(before) + 2 * 24 * 3600;
  await advanceClockTo(state.clockId, target);
  const after = await stripe.subscriptions.retrieve(state.subscriptionId);
  ok(`Renewal attempted. Stripe status is now: ${after.status}`);

  step("Telling the local backend the renewal failed");
  await deliver("customer.subscription.updated", after);

  console.log("\n--------------------------------------------------------------");
  console.log(`Stripe now reports the subscription as "${after.status}".`);
  console.log("In the app: try to send a chat (it should be REFUSED), and/or sign out and");
  console.log("back in to see the PAYWALL. The declined user cannot use the app for free.");
  console.log("Check the stored state with: node scripts/stripe-decline-test.cjs status");
  console.log("--------------------------------------------------------------\n");
}

async function status() {
  const state = loadState();
  step("Live Stripe status");
  const sub = await stripe.subscriptions.retrieve(state.subscriptionId);
  const livePlan = planOfPrice(sub.items.data[0] && sub.items.data[0].price.id);
  console.log(`  subscription ${sub.id}: status=${sub.status}, live plan=${livePlan}`);

  step("Local backend's stored entitlement");
  const row = await readLocalSubscription(state.userId);
  if (!row) {
    console.log("  no subscription row yet (has the backend received a webhook?).");
  } else {
    const active = Number(row.active) === 1;
    const ends = new Date(Number(row.current_period_end_ms)).toISOString();
    console.log(`  plan=${row.plan}  status=${row.status}  active=${active ? "YES (access)" : "NO (blocked)"}  period_end=${ends}`);
  }
  console.log("");
}

async function cleanup() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log("[i] Nothing to clean up.");
    return;
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  step("Cleaning up Stripe test objects");
  try {
    await stripe.testHelpers.testClocks.del(state.clockId);
    ok(`Deleted test clock ${state.clockId} (and its customer/subscription).`);
  } catch (error) {
    console.log(`[i] Could not delete the test clock (${error.message}). You can remove it in the Stripe dashboard.`);
  }
  fs.unlinkSync(STATE_FILE);
  ok("Cleared local test state.");
}

async function main() {
  const [command, arg, arg2] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await setup(arg, arg2);
      break;
    case "advance-cycle":
      await advanceCycle();
      break;
    case "decline":
      await decline();
      break;
    case "status":
      await status();
      break;
    case "cleanup":
      await cleanup();
      break;
    default:
      console.log("Usage: node scripts/stripe-decline-test.cjs <setup <email> [pro|ultra] | advance-cycle | decline | status | cleanup>");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("\nFailed:", error && error.message ? error.message : error);
  process.exit(1);
});
