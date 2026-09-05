import type { ModelMode, ModelTier } from "@workcrew/contracts";
import { config } from "./config.js";

// The three Claude tiers a request can be pinned to or routed to.
export type ClaudeTier = Exclude<ModelTier, "auto">;

// Every concrete engine a step can actually run on. "glm" and "glm-flash" are
// two different models from the same Economy provider (the flagship and its
// cheap, high-throughput sibling); "minimax" is a second, independent Economy
// provider. The rest are the Claude tiers. Kept as a superset of ClaudeTier so
// all the existing pricing and sizing helpers accept these unchanged; only
// callModel and the chat client builder branch on the provider.
export type ConcreteModelTier = ClaudeTier | "glm" | "glm-flash" | "minimax";

export type Provider = "anthropic" | "zai" | "minimax";

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
  // Flagship GLM: standard list price, $1.40 / $4.40 per million tokens.
  glm: { input: 1.4, output: 4.4 },
  // GLM's cheap sibling: standard list price ($0.15 / $0.50 per million), not
  // the September 2026 launch promo, since a reservation sized off a discount
  // that expires would quietly undercharge every request once it ends.
  "glm-flash": { input: 0.15, output: 0.5 },
  // MiniMax M3: standard pay-as-you-go list price ($0.60 / $2.40 per million),
  // not their launch discount, for the same reason.
  minimax: { input: 0.6, output: 2.4 }
} as const satisfies Record<ConcreteModelTier, { input: number; output: number }>;

/** Which upstream provider serves a given engine tier. */
export function provider(tier: ConcreteModelTier): Provider {
  if (tier === "glm" || tier === "glm-flash") return "zai";
  if (tier === "minimax") return "minimax";
  return "anthropic";
}

/**
 * Whether the Economy engine is usable right now. It is only usable when its key
 * is configured; otherwise every route falls back to Claude so the app keeps
 * working before the key is added.
 */
export function economyEngineAvailable(): boolean {
  return config.zai.enabled;
}

/** Whether the second Economy provider (Medium effort) is usable right now. */
export function minimaxAvailable(): boolean {
  return Boolean(config.minimax?.enabled);
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

/** Whether this engine actually looks at images it is sent. Verified directly
 *  for zai: it does not, and answers as though it had looked anyway. MiniMax-M3
 *  is genuinely multimodal, so it is not excluded here alongside zai. */
export function engineSeesImages(tier: ConcreteModelTier): boolean {
  return provider(tier) !== "zai";
}

/**
 * Whether an attachment of this kind can only be understood by an engine that
 * can see.
 *
 * A picture, obviously. And a PDF, for a reason worth stating: the desktop reads
 * a PDF on the machine before sending it, and when it finds a text layer it
 * sends the TEXT instead. So a PDF that arrives here still a PDF is one with no
 * readable text, which is a scan or a photograph of a document. Treating it as
 * ordinary sent scanned invoices to an engine that cannot see, and the user was
 * told "I can't read the contents of the attached PDF" about a page the same
 * account had just read perfectly as a PNG.
 */
export function attachmentNeedsEyes(kind: string): boolean {
  return kind === "image" || kind === "pdf";
}

/**
 * Auto's economy-mode ladder: the same complexity read chooseModel uses for
 * Claude (short and simple vs. ordinary planning vs. genuinely hard), pointed
 * at the three Economy engines instead. A plain question spends the least; the
 * moment the request looks like real work, it moves up a step, and a request
 * that reads as genuinely hard goes straight to the flagship rather than
 * paying for two engines that were only ever going to hand it upward anyway.
 */
function chooseEconomyModel(task: string): "glm-flash" | "minimax" | "glm" {
  const text = task ?? "";
  if (text.length > 4_000 || DEEP_REASONING_PATTERN.test(text)) return "glm";
  if (text.length > 600 || PLANNING_PATTERN.test(text)) return minimaxAvailable() ? "minimax" : "glm";
  return "glm-flash";
}

/**
 * Pick the engine for a chat turn.
 *
 * Economy mode runs the whole effort ladder on non-Claude engines, cheapest
 * first: Quick answer on the flash model, Medium effort on the second Economy
 * provider, High effort on the flagship. Auto follows the same ladder by
 * reading how demanding the request looks, rather than defaulting to the
 * cheapest tier for everything the way a fixed choice would. Claude is never
 * reached from Economy mode; that is the whole point of the mode, and the
 * flagship Economy model is now strong enough that it no longer needs a Claude
 * escape hatch for the hard cases the way it once did.
 *
 * Medium effort falls back to the flagship, not to Claude, when the second
 * Economy provider has no key configured yet: still cheaper than Claude, and
 * consistent with staying inside Economy mode's own engines. Privacy mode is
 * untouched and always uses the normal Claude routing.
 */
export function routeChatTier(opts: {
  mode: ModelMode;
  requested: ModelTier;
  task: string;
  /** Whether the user attached a picture to this turn. */
  hasImage?: boolean;
}): ConcreteModelTier {
  if (opts.mode === "economy" && economyEngineAvailable()) {
    let tier: ConcreteModelTier;
    if (opts.requested === "haiku") tier = "glm-flash";
    else if (opts.requested === "sonnet") tier = minimaxAvailable() ? "minimax" : "glm";
    else if (opts.requested === "opus") tier = "glm";
    else tier = chooseEconomyModel(opts.task);

    // A pasted screenshot is the whole question. Answering it on an engine that
    // cannot see is not a cheaper answer, it is a made up one. The picked tier
    // only needs to move when it actually lands on a blind one (either GLM
    // tier); MiniMax already sees, so a Medium or Auto turn with a picture
    // usually needs nothing extra here at all.
    if (Boolean(opts.hasImage) && !engineSeesImages(tier)) {
      if (minimaxAvailable()) return "minimax";
      if (config.anthropicApiKey) return chooseModel(opts.requested, opts.task);
      // Nothing configured that can see: stay put rather than fail. The turn
      // answers blind, same as before any of this existed.
    }
    return tier;
  }
  return chooseModel(opts.requested, opts.task);
}
