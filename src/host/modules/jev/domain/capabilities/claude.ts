import type { ModelCapabilityEntry } from './modelCapability'

/**
 * Claude Code's own model ids (#509 follow-up, jev-routing-profiles T1) — the
 * five observed on the maintainer's machine in a live route request, every
 * fact re-verified against Anthropic's own documentation on 2026-09-21.
 *
 * Two documents, cited per entry rather than repeated as prose: Claude
 * Code's own alias table (`CLAUDE_CODE_MODEL_CONFIG`) says what each id
 * RESOLVES to, and the model comparison table (`CLAUDE_MODELS_OVERVIEW`,
 * which embeds Anthropic's pricing figures) says what the resolved model
 * COSTS and CAN DO. `PROVIDER_EFFORT_LEVELS.claude` in `launchTuning.ts` is
 * the already-verified five-level ladder every `effortLevels: 'all'` below
 * refers to — this file does not re-derive it.
 */

const CLAUDE_CODE_MODEL_CONFIG = 'https://code.claude.com/docs/en/model-config'
const CLAUDE_MODELS_OVERVIEW = 'https://platform.claude.com/docs/en/models/overview'
const VERIFIED_ON = '2026-09-21'
/** The full five-level ladder every Claude model below accepts unless narrowed. */
const FULL_LADDER = 'all' as const

export const CLAUDE_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilityEntry>> = {
  /**
   * AMENDED reading of the research lead: `CLAUDE_CODE_MODEL_CONFIG` resolves
   * `default` to Opus 5 on Max/Team Premium/Enterprise/API, and to Sonnet 5 on
   * Pro/Team Standard — this app has no way to see which plan is active, so
   * `tier`/`relativeCost` are read at the CONSERVATIVE floor (Sonnet's) rather
   * than assumed to be the pricier one, and `contextWindowTokens` is left off
   * because the two resolutions disagree on it.
   */
  default: {
    tier: 'balanced',
    what: "Whatever this account's own plan already resolves to when nothing more specific is named — Anthropic's own floor answer, asked for by naming nothing at all.",
    notFor:
      'A prompt where the concrete model matters to the decision — the resolution depends on account plan, which this table cannot see, so it can promise nothing more specific than the floor.',
    examples: ['Fix the off-by-one in this loop.', 'Summarize what this module does.'],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    alias:
      'Resolves to Claude Opus 5 on Max, Team Premium, Enterprise and API plans; to Claude Sonnet 5 on Pro and Team Standard; to Claude Sonnet 4.5 on Microsoft Foundry.',
    sources: [CLAUDE_CODE_MODEL_CONFIG],
    verifiedOn: VERIFIED_ON
  },

  /**
   * `frontier`, not `long-context`: Opus 5 is Anthropic's frontier model and
   * the ONLY frontier-tier launch target Claude Code offers here — Fable is
   * `special-purpose` by Anthropic's own "start with Opus 5" guidance — so a
   * hard prompt under the premium profile must be able to land on it. The
   * `[1m]` suffix (what makes this id distinct from a plain `opus`, not
   * itself an observed id) forces the full 1,000,000-token window; that is
   * recorded in `contextWindowTokens`, where T3's large-context check reads
   * it, rather than spent on the tier.
   */
  'opus[1m]': {
    tier: 'frontier',
    what: 'Frontier-grade reasoning with its context window explicitly forced to the full 1,000,000-token window, for a task whose relevant material will not fit a smaller one.',
    notFor:
      'A prompt that fits comfortably in an ordinary context and needs no more reasoning depth than a balanced model already gives — the extra window and price buy headroom nothing here would use.',
    examples: [
      'Review this migration end to end across the whole monorepo.',
      'Trace where this regression was introduced across the full test history.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: 1_000_000,
    relativeCost: 'high',
    alias: 'Claude Opus 5, with its context window explicitly forced to 1,000,000 tokens.',
    sources: [CLAUDE_CODE_MODEL_CONFIG, CLAUDE_MODELS_OVERVIEW],
    verifiedOn: VERIFIED_ON
  },

  /**
   * `special-purpose` rather than `frontier`: Anthropic's own guidance names
   * this model for a narrower job than "hardest reasoning" alone —
   * long-horizon AGENTIC work specifically, and its own docs recommend
   * starting with Opus 5 and reaching for this one only when Opus falls
   * short at higher effort. That recommendation is the `notFor` below,
   * verbatim in substance.
   */
  'claude-fable-5-1[1m]': {
    tier: 'special-purpose',
    what: 'The slowest, most expensive model in this table, built for a long-horizon agentic session that runs autonomously for a long stretch, investigates before acting, and verifies its own work more than a smaller model would.',
    notFor:
      "A task that Claude Opus 5 already handles well, or one no longer than a single sitting — Anthropic's own guidance is to start with Opus 5 and reach for this model only when Opus at higher effort still falls short.",
    examples: [
      'Take this feature from an empty branch to a merged PR without checking in.',
      'Migrate the whole auth system to the new provider and verify every call site yourself.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: 1_000_000,
    relativeCost: 'very-high',
    alias:
      'Claude Fable 5.1, already 1,000,000-token context by default on the Anthropic API — the [1m] suffix here is explicit rather than implied by the provider.',
    sources: [CLAUDE_CODE_MODEL_CONFIG, CLAUDE_MODELS_OVERVIEW],
    verifiedOn: VERIFIED_ON
  },

  sonnet: {
    tier: 'balanced',
    what: 'The everyday choice: near-frontier reasoning at a fraction of the top price, with a full 1,000,000-token window natively.',
    notFor:
      "A one-line mechanical fix that needs no reasoning depth at all, or a task that has already shown Anthropic's frontier model is needed to get it right.",
    examples: [
      'Add a new field to this form and wire it through validation.',
      'Refactor this component to use the new composable.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    contextWindowTokens: 1_000_000,
    relativeCost: 'medium',
    alias:
      'Claude Sonnet 5 on the Anthropic API, AWS and Bedrock; Claude Sonnet 4.5 on Microsoft Foundry.',
    sources: [CLAUDE_CODE_MODEL_CONFIG, CLAUDE_MODELS_OVERVIEW],
    verifiedOn: VERIFIED_ON
  },

  /**
   * `effortLevels: []`, not `FULL_LADDER` — Anthropic's own comparison table
   * lists Haiku's default effort as "Not supported", and this app already
   * held the same boundary independently: `modelEffortLevels` in
   * `agentModelCatalog.ts` degrades a model with no `supportsEffort` to NO
   * list at all, never an empty control. This entry matches that rule rather
   * than inventing a second one.
   */
  haiku: {
    tier: 'fast-cheap',
    what: 'The fastest, cheapest model in this table — near-frontier intelligence for a task that is small, well-understood, and latency-sensitive.',
    notFor:
      'Anything that needs sustained reasoning across several files, or a prompt whose difficulty is not already obviously low.',
    examples: [
      'Rename this variable everywhere it appears in the file.',
      'What does this error message mean?'
    ],
    launchTarget: true,
    effortLevels: [],
    contextWindowTokens: 200_000,
    relativeCost: 'low',
    alias: 'The latest Haiku model — Claude Haiku 4.5 as of this table.',
    sources: [CLAUDE_CODE_MODEL_CONFIG, CLAUDE_MODELS_OVERVIEW],
    verifiedOn: VERIFIED_ON
  }
}
