import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  PLAN_CATALOG,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  type RunStepResponse,
  type SubscriptionState
} from "@workcrew/contracts";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { ZodError } from "zod";
import { authenticate } from "./auth.js";
import {
  actualCostMicrodollars,
  callModel,
  chooseModel,
  maximumReservationMicrodollars,
  modelRequestPayload
} from "./anthropic.js";
import { createCheckout, createPortal, handleStripeWebhook } from "./billing.js";
import { getBudgetUsage, getBudgetWindow, planBudget, reserveBudget, settleBudget } from "./budget.js";
import { config, DEV_USER_ID } from "./config.js";
import {
  createRun,
  getRun,
  getSubscription,
  initializeDatabase,
  updateRun,
  upsertSubscription,
  type SubscriptionRow
} from "./db.js";

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: 256 * 1024,
  requestTimeout: 70_000,
  trustProxy: config.nodeEnv === "production"
});

await app.register(helmet, { global: true });
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  ban: 3,
  keyGenerator: (request) => request.headers.authorization?.slice(-24) ?? request.ip
});
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error("Origin is not allowed"), false);
  },
  methods: ["GET", "POST"],
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
      reservedMicrodollars: 0
    };
  }
  const window = getBudgetWindow(subscription.budgetAnchorMs);
  const usage = await getBudgetUsage(userId, window);
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
    reservedMicrodollars: usage.reserved
  };
}

app.get("/health", async () => ({ ok: true, service: "workcrew-api", version: "0.1.0" }));

app.get("/v1/entitlement", async (request) => subscriptionState(await authenticate(request)));

app.post("/v1/dev/activate", async (request) => {
  const userId = await authenticate(request);
  if (!config.devBilling || config.nodeEnv === "production" || userId !== DEV_USER_ID) {
    throw Object.assign(new Error("Development billing is disabled"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const body = createCheckoutSchema.parse(request.body);
  const now = Date.now();
  const end = new Date(now);
  if (body.interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  await upsertSubscription({
    userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: body.plan,
    interval: body.interval,
    status: "active",
    active: true,
    budgetAnchorMs: now,
    currentPeriodEndMs: end.getTime()
  });
  return subscriptionState(userId);
});

app.post("/v1/billing/checkout", async (request) => {
  const userId = await authenticate(request);
  const body = createCheckoutSchema.parse(request.body);
  return { url: await createCheckout(userId, body.plan, body.interval) };
});

app.post("/v1/billing/portal", async (request) => ({ url: await createPortal(await authenticate(request)) }));

app.post("/v1/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
  const signature = request.headers["stripe-signature"];
  const body = (request as typeof request & { rawBody?: Buffer }).rawBody;
  if (typeof signature !== "string" || !body) return reply.code(400).send({ error: "Invalid webhook" });
  await handleStripeWebhook(body, signature);
  return { received: true };
});

app.post("/v1/runs", async (request) => {
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
    pendingToolUseId: null
  });
  return { runId: id, status: "ready" };
});

app.post<{ Params: { runId: string } }>("/v1/runs/:runId/next", async (request): Promise<RunStepResponse> => {
  const userId = await authenticate(request);
  const subscription = requireActive(await getSubscription(userId));
  const body = nextRunStepSchema.parse(request.body ?? {});
  const run = await getRun(request.params.runId, userId);
  if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404, code: "RUN_NOT_FOUND" });
  if (run.status === "complete") return { runId: run.id, status: "complete", message: "This run is already complete." };

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

  const originalTask = String((run.messages[0] as { content?: unknown } | undefined)?.content ?? "");
  const tier = chooseModel(run.model, originalTask);
  const maxOutputTokens = 1_200;
  const payload = modelRequestPayload(run.messages, tier, maxOutputTokens);
  const reservationAmount = maximumReservationMicrodollars(tier, payload, maxOutputTokens);
  const reservation = await reserveBudget({
    subscription,
    runId: run.id,
    model: tier,
    amountMicrodollars: reservationAmount
  });

  try {
    const result = await callModel({ tier, messages: run.messages, maxOutputTokens });
    const actualCost = actualCostMicrodollars(tier, result.usage);
    if (actualCost > reservationAmount) {
      throw Object.assign(new Error("Provider usage exceeded the reserved maximum"), { code: "USAGE_RESERVATION_BREACH" });
    }
    await settleBudget(reservation.reservationId, actualCost, result.providerRequestId);
    run.messages.push({ role: "assistant", content: result.content });
    run.pendingToolUseId = result.action.kind === "finish" ? null : result.toolUseId ?? null;
    run.status = result.action.kind === "finish" ? "complete" : "awaiting_tool";
    await updateRun(run);
    const usage = await getBudgetUsage(userId, reservation.window);
    return {
      runId: run.id,
      status: result.action.kind === "finish" ? "complete" : "awaiting_tool",
      action: result.action,
      toolUseId: result.toolUseId,
      message: result.action.kind === "finish" ? result.action.summary : undefined,
      usage: { usedMicrodollars: usage.used, budgetMicrodollars: PLAN_CATALOG[subscription.plan].monthlyApiBudgetMicrodollars }
    };
  } catch (error) {
    await settleBudget(reservation.reservationId, reservationAmount, (error as { providerRequestId?: string }).providerRequestId);
    run.status = "failed";
    await updateRun(run);
    throw error;
  }
});

app.setErrorHandler((error, request, reply) => {
  const statusCode = error instanceof ZodError ? 400 : Number((error as { statusCode?: number }).statusCode ?? 500);
  const code = error instanceof ZodError ? "INVALID_REQUEST" : String((error as { code?: string }).code ?? "INTERNAL_ERROR");
  if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
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
}

export { app };
