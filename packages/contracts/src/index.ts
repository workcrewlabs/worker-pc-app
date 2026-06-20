import { z } from "zod";

export const APP_NAME = "WorkCrew" as const;
export const APP_PROTOCOL = "workcrew" as const;

export const planIdSchema = z.enum(["pro", "ultra"]);
export type PlanId = z.infer<typeof planIdSchema>;

export const billingIntervalSchema = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const PLAN_CATALOG = {
  pro: {
    name: "Pro",
    monthlyPriceUsd: 27,
    yearlyPriceUsd: 270,
    monthlyApiBudgetMicrodollars: 6_750_000,
    devices: 1
  },
  ultra: {
    name: "Ultra",
    monthlyPriceUsd: 200,
    yearlyPriceUsd: 2_000,
    monthlyApiBudgetMicrodollars: 50_000_000,
    devices: 5
  }
} as const satisfies Record<PlanId, {
  name: string;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
  monthlyApiBudgetMicrodollars: number;
  devices: number;
}>;

export const modelTierSchema = z.enum(["auto", "haiku", "sonnet", "opus"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const browserCommandSchema = z.enum([
  "open",
  "goto",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "screenshot",
  "go-back",
  "go-forward",
  "reload",
  "tab-list",
  "tab-new",
  "tab-select",
  "tab-close"
]);

export const browserActionSchema = z.object({
  kind: z.literal("browser"),
  command: browserCommandSchema,
  target: z.string().max(500).optional(),
  value: z.string().max(10_000).optional(),
  url: z.string().url().max(2_048).optional(),
  key: z.string().max(80).optional(),
  index: z.number().int().min(0).max(100).optional()
}).strict();

export const windowsCommandSchema = z.enum([
  "list-windows",
  "connect",
  "inspect",
  "click",
  "set-text",
  "type-keys",
  "get-text",
  "screenshot"
]);

export const windowsActionSchema = z.object({
  kind: z.literal("windows"),
  command: windowsCommandSchema,
  application: z.string().max(260).optional(),
  windowTitle: z.string().max(500).optional(),
  control: z.string().max(500).optional(),
  value: z.string().max(10_000).optional()
}).strict();

export const finishActionSchema = z.object({
  kind: z.literal("finish"),
  summary: z.string().min(1).max(10_000)
}).strict();

export const automationActionSchema = z.discriminatedUnion("kind", [
  browserActionSchema,
  windowsActionSchema,
  finishActionSchema
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type WindowsAction = z.infer<typeof windowsActionSchema>;

export const createCheckoutSchema = z.object({
  plan: planIdSchema,
  interval: billingIntervalSchema
}).strict();

export const createRunSchema = z.object({
  task: z.string().trim().min(3).max(20_000),
  model: modelTierSchema.default("auto")
}).strict();

export const runToolResultSchema = z.object({
  toolUseId: z.string().min(1).max(200),
  ok: z.boolean(),
  output: z.string().max(100_000)
}).strict();

export const nextRunStepSchema = z.object({
  result: runToolResultSchema.optional()
}).strict();

export type SubscriptionState = {
  active: boolean;
  plan: PlanId | null;
  interval: BillingInterval | null;
  status: string;
  currentPeriodEnd: string | null;
  budgetPeriodStart: string | null;
  budgetPeriodEnd: string | null;
  budgetMicrodollars: number;
  usedMicrodollars: number;
  reservedMicrodollars: number;
};

export type RunStepResponse = {
  runId: string;
  status: "awaiting_tool" | "complete" | "failed";
  action?: AutomationAction;
  toolUseId?: string;
  message?: string;
  usage?: {
    usedMicrodollars: number;
    budgetMicrodollars: number;
  };
};
