import { z } from "zod";

export const APP_NAME = "WorkCrew" as const;
export const APP_PROTOCOL = "workcrew" as const;
/** Address the "Contact support" action opens. Shared so the main process and
 * the renderer never drift on it. */
export const SUPPORT_EMAIL = "workcrew.support@gmail.com" as const;

/** Bonus the inviter earns each time someone they referred becomes a paying
 * subscriber. Stored and displayed in the same internal units as the monthly
 * budget (shown to the user as "tokens"), so 250,000 displays as "250K tokens".
 * One place to change the reward. */
export const REFERRAL_BONUS_MICRODOLLARS = 250_000 as const;

/** The public site a referral link points at. The ?ref=CODE is read by the
 * sign-up screen so a referred friend can be attributed to the inviter. */
export const REFERRAL_LINK_BASE = "https://getworkcrew.com" as const;

/** A user's referral standing, returned by GET /v1/referral. */
export type ReferralInfo = {
  code: string;
  link: string;
  invitedCount: number;
  creditedCount: number;
  bonusMicrodollars: number;
};

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
  "launch",
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

// ---------------------------------------------------------------------------
// Chat contracts
// ---------------------------------------------------------------------------

// A chat message is authored either by the user or by the assistant.
export const messageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

// Effort levels map to the Anthropic output_config.effort field.
export const effortSchema = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof effortSchema>;

// A reference to an uploaded file that the renderer attaches to a turn. The
// renderer holds the file id and metadata, the bytes live on disk locally.
export const attachmentRefSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(0),
  kind: z.enum(["pdf", "image", "text"]),
  redact: z.boolean().default(false)
}).strict();
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

// The kinds of file WorkCrew can currently read into a chat turn.
export const attachmentKindSchema = z.enum(["pdf", "image", "text"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

// Request to upload one file. The desktop reads the file from local disk and
// sends its bytes as base64, because in production the backend has no access to
// the user's machine. The base64 ceiling here is a coarse guard; the backend
// enforces the real per-file byte limit after decoding. conversationId is
// optional association metadata.
export const attachmentUploadSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  base64: z.string().min(1).max(14_000_000),
  conversationId: z.string().uuid().optional()
}).strict();
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

// Payload for sending a chat turn. modelTierSchema stays as it is (auto,
// haiku, sonnet, opus) but the chat default is sonnet.
export const chatSendSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().max(200_000),
  attachments: z.array(attachmentRefSchema).max(20).default([]),
  model: modelTierSchema.default("sonnet"),
  effort: effortSchema.default("high"),
  thinking: z.boolean().default(false)
}).strict();
export type ChatSend = z.infer<typeof chatSendSchema>;

// A one-line summary of a conversation used in the Recents list.
export const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  model: modelTierSchema,
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  projectId: z.string().uuid().nullable()
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

// A stored message. contentJson holds the full Anthropic content block array
// (text, thinking, citations, tool_use) so reload preserves everything. It is
// kept as an array of arbitrary blocks (passthrough) on purpose.
export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: messageRoleSchema,
  contentJson: z.array(z.any()),
  createdAtMs: z.number().int()
});
export type Message = z.infer<typeof messageSchema>;

// SSE frame type for documentation. The chat endpoint streams a discriminated
// union of frames keyed by "type": incremental text, thinking, and citation
// deltas, a terminal done frame carrying usage and the persisted message id,
// and an error frame.
export const chatDeltaFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string()
  }).strict(),
  z.object({
    type: z.literal("thinking"),
    text: z.string()
  }).strict(),
  z.object({
    type: z.literal("citation"),
    citation: z.any()
  }).strict(),
  z.object({
    type: z.literal("done"),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    usage: z.object({
      usedMicrodollars: z.number().int(),
      budgetMicrodollars: z.number().int()
    })
  }).strict(),
  z.object({
    type: z.literal("error"),
    message: z.string()
  }).strict()
]);
export type ChatDeltaFrame = z.infer<typeof chatDeltaFrameSchema>;

// ---------------------------------------------------------------------------
// Attachment storage (mirrors the attachments table)
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().min(1).max(64),
  localPath: z.string(),
  anthropicFileId: z.string().nullable(),
  pageCount: z.number().int().min(0).nullable(),
  redacted: z.boolean(),
  createdAtMs: z.number().int()
});
export type Attachment = z.infer<typeof attachmentSchema>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  name: z.string(),
  defaultModel: modelTierSchema,
  createdAtMs: z.number().int()
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120)
}).strict();
export type CreateProject = z.infer<typeof createProjectSchema>;

// ---------------------------------------------------------------------------
// Routines (recurring local automations)
// ---------------------------------------------------------------------------

// How a routine is scheduled. Preset first, plus custom (cron) and one-off.
export const routineScheduleKindSchema = z.enum([
  "manual",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "custom",
  "once"
]);
export type RoutineScheduleKind = z.infer<typeof routineScheduleKindSchema>;

// Per-routine permission policy: present a plan first, ask for each action, or
// run automatically.
export const routinePermissionSchema = z.enum(["plan_first", "ask_each", "auto"]);
export type RoutinePermission = z.infer<typeof routinePermissionSchema>;

// The scope a routine is allowed to touch. Network defaults to allowlist.
export const routineScopeSchema = z.object({
  apps: z.array(z.string()).default([]),
  folders: z.array(z.string()).default([]),
  sites: z.array(z.string()).default([]),
  network: z.enum(["off", "allowlist", "on"]).default("allowlist")
}).strict();
export type RoutineScope = z.infer<typeof routineScopeSchema>;

export const createRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  instructions: z.string().min(3).max(20_000),
  scheduleKind: routineScheduleKindSchema,
  scheduleCron: z.string().max(200).optional(),
  scheduleAtMs: z.number().int().optional(),
  permissionMode: routinePermissionSchema.default("plan_first"),
  scope: routineScopeSchema,
  model: modelTierSchema.default("auto")
}).strict();
export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = createRoutineSchema.partial().extend({
  active: z.boolean().optional()
}).strict();
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

// A stored routine (mirrors the routines table).
export const routineSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  instructions: z.string(),
  scheduleKind: routineScheduleKindSchema,
  scheduleCron: z.string().nullable(),
  scheduleAtMs: z.number().int().nullable(),
  permissionMode: routinePermissionSchema,
  scope: routineScopeSchema,
  model: modelTierSchema,
  active: z.boolean(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int()
});
export type Routine = z.infer<typeof routineSchema>;

// Honest run outcome vocabulary for routine runs.
export const routineRunStatusSchema = z.enum([
  "succeeded",
  "ran_with_issues",
  "skipped",
  "failed"
]);
export type RoutineRunStatus = z.infer<typeof routineRunStatusSchema>;

// A single routine run record (mirrors the routine_runs table). run_id links
// back to the existing runs table so ad-hoc and scheduled runs share a shape.
export const routineRunSchema = z.object({
  id: z.string().uuid(),
  routineId: z.string().uuid(),
  startedAtMs: z.number().int(),
  endedAtMs: z.number().int().nullable(),
  status: routineRunStatusSchema,
  skipReason: z.string().nullable(),
  runId: z.string().nullable(),
  evidenceJson: z.array(z.any()).nullable()
});
export type RoutineRun = z.infer<typeof routineRunSchema>;

// ---------------------------------------------------------------------------
// Entitlement status vocabulary
// ---------------------------------------------------------------------------

// Stripe's exact status vocabulary so simulated and real billing paths write
// identical values. SubscriptionState above keeps its loose string status, and
// this union is the canonical set those values are drawn from.
export const stripeStatusSchema = z.enum([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid"
]);
export type StripeStatus = z.infer<typeof stripeStatusSchema>;
