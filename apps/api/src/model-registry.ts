import type { ModelMode, ModelTier } from "@workcrew/contracts";
import { config } from "./config.js";

// The three Claude tiers a request can be pinned to or routed to.
export type ClaudeTier = Exclude<ModelTier, "auto">;

// Every concrete engine a step can actually run on. "glm" is the Economy-mode
// engine (a separate, cost-efficient provider); the rest are the Claude tiers.
// Kept as a superset of ClaudeTier so all the existing pricing and sizing helpers
// accept a glm tier unchanged; only callModel branches on the provider.
export type ConcreteModelTier = ClaudeTier | "glm";

export type Provider = "anthropic" | "zai";

/**
 * MODEL_PRICES is the single source of truth for per token pricing in
 * microdollars. Input covers prompt tokens, output covers completion tokens.
 * anthropic.ts re-exports this so existing imports keep working. The glm figures
 * track the Economy-provider list price and are what makes the shared budget go
 * further: the same daily and monthly caps buy far more work at these rates.
 */
export const MODEL_PRICES = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
  glm: { input: 1.4, output: 4.4 }
} as const satisfies Record<ConcreteModelTier, { input: number; output: number }>;

/** Which upstream provider serves a given engine tier. */
export function provider(tier: ConcreteModelTier): Provider {
  return tier === "glm" ? "zai" : "anthropic";
}

/**
 * Whether the Economy engine is usable right now. It is only usable when its key
 * is configured; otherwise every route falls back to Claude so the app keeps
 * working before the key is added.
 */
export function economyEngineAvailable(): boolean {
  return config.zai.enabled;
}

/** Prompt and tool schema version. Persisted on run records lets failures be reproduced. */
export const PROMPT_VERSION = "2026-06-20" as const;

/** Resolve a concrete tier to the configured provider model id. */
export function modelId(tier: ConcreteModelTier): string {
  return config.models[tier];
}

/**
 * Patterns that signal explicit deep reasoning or genuinely hard, multistep,
 * or ambiguous work. These route to opus only when the requester opted in or
 * the language is unambiguous about difficulty.
 */
const DEEP_REASONING_PATTERN = /\b(deep reasoning|think (?:hard|deeply|step by step)|reason carefully|prove|derive|debug a tricky|root cause|architect|design a system|complex multi[ -]?step|ambiguous|difficult)\b/i;

/**
 * Patterns that signal normal planning, tool use, recovery, and multi
 * application coordination. These route to sonnet.
 */
const PLANNING_PATTERN = /\b(analy[sz]e|research|workflow|plan|multiple|across|coordinate|compare|summari[sz]e a (?:long|large)|recover|navigate|fill out)\b/i;

/**
 * Improved capability and cost aware router.
 *
 * When the caller pins a tier we honour it. Otherwise we route by capability
 * and cost intent following MVP_PLAN section 12:
 *   - haiku for short, simple, classification style next action selection,
 *   - sonnet for normal task planning, tool use, recovery, and communication,
 *   - opus only for explicit deep reasoning or clearly difficult multistep work.
 */
export function chooseModel(requested: ModelTier, task: string): ClaudeTier {
  if (requested !== "auto") return requested;
  const text = task ?? "";
  if (text.length > 4_000 || DEEP_REASONING_PATTERN.test(text)) return "opus";
  if (text.length > 600 || PLANNING_PATTERN.test(text)) return "sonnet";
  return "haiku";
}

/**
 * Pick the engine for one automation planning step.
 *
 * The plan-act loop is mechanical (look at the latest snapshot, choose one
 * action), so it never needs an expensive model by default:
 *   - Economy mode runs it on the cost-efficient glm engine, which is both
 *     cheaper and stronger at agentic tool use than the old "route everything to
 *     Sonnet" behavior, so the same plan does far more.
 *   - Privacy mode (or Economy when the engine is not configured) runs it on the
 *     cheapest Claude tier, haiku, instead of Sonnet.
 *   - Either way, once a run has escalated (glm got stuck), Claude takes over:
 *     Sonnet normally, Opus for Ultra, which is the "Claude solves what glm can't"
 *     safety net.
 */
export function routeAutomationTier(opts: {
  mode: ModelMode;
  escalated: boolean;
  ultra: boolean;
  /** Whether this step's request carries a screenshot for the model to look at. */
  hasImage?: boolean;
}): ConcreteModelTier {
  if (opts.escalated) return opts.ultra ? "opus" : "sonnet";
  if (opts.mode === "economy" && economyEngineAvailable() && !mustSee(opts.hasImage)) return "glm";
  return "haiku";
}

/**
 * Whether a request carrying an image has to leave the Economy engine.
 *
 * The Economy engine does not read images. It does not say so either: it accepts
 * the image block, returns 200, and answers as though it had looked, which comes
 * back to the user as a confident description of a screenshot nobody ever saw.
 * Verified directly against the engine, which replied "I cannot see any image"
 * to a screenshot it was sent. So a request with a picture in it goes to an
 * engine that can see, and only stays put when there is no such engine
 * configured at all.
 */
function mustSee(hasImage: boolean | undefined): boolean {
  return Boolean(hasImage) && Boolean(config.anthropicApiKey);
}

/** Whether this engine actually looks at images it is sent. */
export function engineSeesImages(tier: ConcreteModelTier): boolean {
  return provider(tier) !== "zai";
}

/**
 * Pick the engine for a chat turn. Economy mode runs chats on the cost-efficient
 * engine to keep everyday cost low, with ONE deliberate exception: when the user
 * picks High effort (opus), that turn goes to top-quality Claude. This is the
 * on-demand escape for hard work such as a complex spreadsheet, where the cheap
 * engine is not good enough, without making ordinary chat expensive. It only
 * applies when a Claude key is configured; otherwise the turn stays on the cheap
 * engine rather than failing. Privacy mode uses the normal Claude routing.
 */
export function routeChatTier(opts: {
  mode: ModelMode;
  requested: ModelTier;
  task: string;
  /** Whether the user attached a picture to this turn. */
  hasImage?: boolean;
}): ConcreteModelTier {
  if (opts.mode === "economy" && economyEngineAvailable()) {
    if (opts.requested === "opus" && Boolean(config.anthropicApiKey)) return "opus";
    // A pasted screenshot is the whole question. Answering it on an engine that
    // cannot see is not a cheaper answer, it is a made up one.
    if (mustSee(opts.hasImage)) return chooseModel(opts.requested, opts.task);
    return "glm";
  }
  return chooseModel(opts.requested, opts.task);
}
