/**
 * Free-tier-only OpenRouter models for PaperAgents.
 *
 * All inference runs on OpenRouter `:free` models — the actual cost is $0.00.
 *
 * Rate-limit awareness (OpenRouter free tier): 50 requests/day by default, or
 * 1,000/day after a one-time $10 credit purchase. A full six-agent run uses
 * ~8–15 LLM calls, so the base free tier supports roughly 3–5 full demos per
 * day. Free model availability rotates; the fallback chain keeps the pipeline
 * on free models even when one is temporarily unavailable or rate-limited.
 */
export const FREE_MODELS = {
  /** Primary model for all agents — reliable structured output. */
  default: "openai/gpt-oss-20b:free",

  /** Stronger reasoning for the Falsifier's adversarial claim breaking. */
  falsifier: "nvidia/nemotron-3-super-120b-a12b:free",

  /** Long-context model for full-document runs (Falsifier with full-text excerpts). */
  fullText: "nvidia/nemotron-3-ultra-550b-a55b:free",

  /** Fallback chain — tried in order after each agent's preferred model. All free. */
  fallbacks: [
    "openai/gpt-oss-20b:free",
    "poolside/laguna-xs-2.1:free",
    "openrouter/free",
  ],
} as const;

/**
 * Per-model request-option overrides applied on top of every OpenRouter call.
 *
 * All four of these free models are reasoning models that otherwise burn large
 * chunks of the `max_tokens` budget on chain-of-thought before emitting any
 * answer — measured live: a trivial JSON probe consumed 97–482 reasoning
 * tokens and returned `content: null` when the budget ran out. Taming that
 * keeps responses inside the agents' token caps so structured JSON actually
 * comes back (the pipeline's verification integrity lives in the system
 * prompts and the deterministic grounding check, not in hidden CoT).
 *
 * - gpt-oss-20b:free rejects disabling reasoning (`400 Reasoning is
 *   mandatory`) but honors a low effort level.
 * - The Nemotron and Laguna endpoints accept `reasoning: { enabled: false }`
 *   and then respond instantly with zero reasoning tokens.
 * - `openrouter/free` deliberately has NO overrides: it auto-routes to a
 *   rotating free model, some of which (e.g. gpt-oss) reject the disable
 *   flag, so it is called with whatever the routed model accepts natively.
 */
export const MODEL_OPTIONS: Record<string, Record<string, unknown> | undefined> = {
  "openai/gpt-oss-20b:free": { reasoning: { effort: "low" } },
  "nvidia/nemotron-3-super-120b-a12b:free": { reasoning: { enabled: false } },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { reasoning: { enabled: false } },
  "poolside/laguna-xs-2.1:free": { reasoning: { enabled: false } },
  // NOTE: no entry for "openrouter/free" — see the bullet above.
};
