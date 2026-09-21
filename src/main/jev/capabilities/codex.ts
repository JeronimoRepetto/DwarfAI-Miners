import type { ModelCapabilityEntry } from './modelCapability'

/**
 * Codex CLI's own model ids (#509 follow-up, jev-routing-profiles T1). Codex
 * documents none of this in `--help` (see `PROVIDER_EFFORT_LEVELS`'s own
 * comment in `launchTuning.ts`), so every fact below is read off the CLI's
 * own cache file instead — `description`, `visibility`, `context_window` and
 * the retirement notice all came from it, byte for byte, re-read on
 * 2026-09-21. Pricing is not in that file at all; it comes from OpenAI's own
 * published rate card. `PROVIDER_EFFORT_LEVELS.codex` in `launchTuning.ts`
 * is the already-verified six-level ladder (including `ultra`, Codex's
 * alone) every `effortLevels` below reads against.
 */

const CODEX_MODELS_CACHE = 'installed CLI: ~/.codex/models_cache.json'
const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing'
const VERIFIED_ON = '2026-09-21'
/**
 * Two narrowed ladders, read off each model's own `supported_reasoning_levels`
 * in the cache rather than assumed — `gpt-5.6-luna` lists five (no `ultra`),
 * `gpt-5.5` lists only four (no `max`, no `ultra`). Two different ladders,
 * not one "everything but ultra" constant, because the cache says so.
 */
const LADDER_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const LADDER_TO_XHIGH = ['low', 'medium', 'high', 'xhigh'] as const
const FULL_LADDER = 'all' as const

/**
 * Every model in the cache reports the same base `context_window`
 * (272,000 tokens) as of this reading — the CLI's own answer for what this
 * app's Codex integration actually sees, read in preference to a third-party
 * "1M" figure describing a separate compaction/upgrade path the cache also
 * carries (`max_context_window`) but this app does not exercise.
 */
const CODEX_CONTEXT_WINDOW_TOKENS = 272_000

export const CODEX_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilityEntry>> = {
  'gpt-5.6-sol': {
    tier: 'frontier',
    what: "This provider's primary recommendation for hard coding work — its own cache describes it as the latest frontier agentic coding model, and `ultra` on its ladder can delegate to sub-tasks automatically.",
    notFor:
      'A small, well-understood change, or a budget-sensitive run where a cheaper model on this ladder already gets it right.',
    examples: [
      'Design and implement the new plugin system from scratch.',
      'Debug this flaky integration test that fails once in twenty runs.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    relativeCost: 'high',
    sources: [CODEX_MODELS_CACHE, OPENAI_PRICING],
    verifiedOn: VERIFIED_ON
  },

  'gpt-5.6-luna': {
    tier: 'fast-cheap',
    what: "The cheapest model on this ladder — the cache's own description is fast and affordable, meant for routine agentic coding rather than hard reasoning.",
    notFor: 'Anything that needs sustained multi-file reasoning or an architectural decision.',
    examples: [
      'Add a null check before this property access.',
      'Update this test fixture to match the new shape.'
    ],
    launchTarget: true,
    // Codex's own cache lists five reasoning levels for this model — up to
    // `max`, but no `ultra` (unlike sol/terra/astra) — narrowed rather than
    // 'all' for that reason.
    effortLevels: LADDER_TO_MAX,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    relativeCost: 'low',
    sources: [CODEX_MODELS_CACHE, OPENAI_PRICING],
    verifiedOn: VERIFIED_ON
  },

  'gpt-5.6-terra': {
    tier: 'balanced',
    what: "This provider's everyday middle ground — the cache's own description is a balanced agentic coding model for everyday work.",
    notFor:
      'A one-line mechanical fix that needs no reasoning depth, or a task that has already shown the frontier model is needed to get it right.',
    examples: [
      'Add a new API endpoint and its request validation.',
      'Extract this duplicated logic into a shared helper.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    relativeCost: 'medium',
    sources: [CODEX_MODELS_CACHE, OPENAI_PRICING],
    verifiedOn: VERIFIED_ON
  },

  'gpt-6-astra': {
    tier: 'frontier',
    what: "This provider's newest and most capable model — the cache's own description is its most capable model for complex, demanding work, priced above the other frontier option on this ladder.",
    notFor:
      'Routine work the cheaper frontier option on this ladder (gpt-5.6-sol) already handles — this is the more expensive of the two, not a strictly different job.',
    examples: [
      'Design the data model for a feature this codebase has never had before.',
      'Untangle a deadlock that only reproduces under real production load.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    relativeCost: 'very-high',
    sources: [CODEX_MODELS_CACHE, OPENAI_PRICING],
    verifiedOn: VERIFIED_ON
  },

  /**
   * `visibility: "hide"` in the cache — never a chip a person could pick, and
   * never a name Jev may return either. `special-purpose` rather than any of
   * the coding tiers: its own description is an automatic approval review
   * model, a job with no coding-prompt criteria to write at all.
   */
  'codex-auto-review': {
    tier: 'special-purpose',
    what: 'An automatic approval-review model Codex runs internally — never a model a launch chooses to run a prompt on.',
    notFor:
      'Everything a launch could ask for. This entry exists only so the exhaustiveness suite can prove the id is excluded, never offered.',
    examples: [
      '(not applicable — this model is never offered as a launch choice)',
      '(see launchTarget: false)'
    ],
    launchTarget: false,
    // The cache lists five levels for this model too (up to `max`, no `ultra`)
    // — recorded for completeness even though `launchTarget: false` means no
    // launch will ever read it.
    effortLevels: LADDER_TO_MAX,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    relativeCost: 'unverified',
    sources: [CODEX_MODELS_CACHE],
    verifiedOn: VERIFIED_ON
  },

  /**
   * Retiring 2026-10-14 per the cache's own `migration_markdown` — kept in
   * the table rather than deleted, because a still-installed CLI can still
   * report it in a session's history until that date, and an id the
   * catalogue can still hand back must still resolve here (this file's own
   * exhaustiveness rule, applied to itself).
   */
  'gpt-5.5': {
    tier: 'balanced',
    what: "The previous-generation balanced model, retiring 2026-10-14 in favour of gpt-5.6-sol — the cache's own description is proven previous-generation model for coding and general work.",
    notFor:
      "A new launch with a choice — gpt-5.6-terra now costs less for the same tier, and gpt-5.6-sol's current price is below this model's despite being the frontier option.",
    examples: [
      'Continue the change already under way in this thread.',
      'Make the same kind of edit this session has been making.'
    ],
    launchTarget: true,
    // Codex's own cache lists only four reasoning levels for this model — up
    // to `xhigh`, with no `max` and no `ultra`.
    effortLevels: LADDER_TO_XHIGH,
    contextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    // AMENDED: the research lead named no figure for this id. OpenAI's own
    // rate card prices it at $5/$30 per Mtok — ABOVE gpt-5.6-sol's current
    // $4/$20, because sol is carrying a temporary promotional discount OpenAI
    // states lasts through 2026-11-21. Read as 'high' rather than 'medium' to
    // reflect what a person would actually pay today, not sol's list price.
    relativeCost: 'high',
    sources: [CODEX_MODELS_CACHE, OPENAI_PRICING],
    verifiedOn: VERIFIED_ON
  }
}
