import type { ModelCapabilityEntry } from './modelCapability'

/**
 * Antigravity's model line-up (#509 follow-up, jev-routing-profiles T1) —
 * read from Google's own docs page rather than the CLI, because `agy` is not
 * installed on the machine this table was verified from and this app has
 * measured no `agy models` output to check an id's exact spelling against
 * (see `parseAgyModelLine` in `providers/antigravity/models.ts` for the tab-
 * separated format a real answer would take).
 *
 * The keys below are therefore NOT a verified id grammar — they are this
 * table's own slug derived from the docs' own display names, written so a
 * real `agy models` answer can be compared against them later. Whoever
 * verifies against a real `agy models` output first should rename these keys
 * to match it exactly (the exhaustiveness suite in `capabilities.test.ts`
 * will fail loudly if a real id and a key here disagree) and update this
 * comment. Context window and per-token pricing are UNVERIFIED for every
 * entry below — the docs page states neither.
 */

const ANTIGRAVITY_MODELS = 'https://antigravity.google/docs/models/'
const VERIFIED_ON = '2026-09-21'

/**
 * `PROVIDER_EFFORT_LEVELS.antigravity` (`launchTuning.ts`) is CLI-verified as
 * a session-wide `--effort low|medium|high` flag, not gated per model the way
 * Claude's `supportsEffort` is. The docs page describes each REASONING model
 * with a fixed effort category in Antigravity's own web UI (Flash: "Fast",
 * Pro: "High"), but names no per-model gate on the CLI's flag itself — so
 * every reasoning model below accepts the full provider ladder until a
 * narrower gate is documented, and only the image model takes none.
 */
const FULL_LADDER = 'all' as const

export const ANTIGRAVITY_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilityEntry>> = {
  'gemini-3.8-flash': {
    tier: 'fast-cheap',
    what: "The newest of this provider's fast reasoning models — its own docs group it under the Fast effort category for quick, everyday turns.",
    notFor: 'A task that needs sustained multi-step reasoning across a large change.',
    examples: ['Fix this failing test.', 'Add a missing null check here.'],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  'gemini-3.7-flash': {
    tier: 'fast-cheap',
    what: 'A previous-generation fast reasoning model in the same Fast category as the newer Flash release, kept available alongside it.',
    notFor: 'A task that needs sustained multi-step reasoning across a large change.',
    examples: [
      'Update this import path after the file moved.',
      'Add a docstring to this function.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  'gemini-3.6-flash': {
    tier: 'fast-cheap',
    what: "The oldest of this provider's fast reasoning models still offered, in the same Fast category as the two newer Flash releases.",
    notFor: 'A task that needs sustained multi-step reasoning across a large change.',
    examples: ['Rename this variable across the file.', 'Fix this typo in the error message.'],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  /**
   * The only model this provider's own docs single out for "advanced
   * reasoning" (its own High effort category) — read as this table's
   * `frontier` option for Antigravity specifically, without claiming parity
   * against Claude's or Codex's frontier models, which the docs never compare it to.
   */
  'gemini-3.1-pro': {
    tier: 'frontier',
    what: "This provider's advanced-reasoning model — its own docs place it in the High effort category, distinct from the three Flash models' Fast category.",
    notFor: 'A small, well-understood change where a Flash model already gets it right.',
    examples: [
      'Design the approach for a feature this codebase has never had before.',
      'Diagnose a bug that only reproduces under specific concurrent conditions.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  'claude-sonnet-4.6-thinking': {
    tier: 'balanced',
    what: "Anthropic's balanced model, offered here as one of this provider's alternative reasoning models with thinking enabled — not customizable away on Enterprise, per the docs.",
    notFor:
      "A prompt this provider's own Gemini models already handle — offered as a choice among reasoning models, not the only option.",
    examples: [
      'Refactor this component to use the new composable.',
      'Add a new endpoint and its request validation.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  'claude-opus-4.6-thinking': {
    tier: 'frontier',
    what: "Anthropic's frontier model, offered here as one of this provider's alternative reasoning models with thinking enabled — not customizable away on Enterprise, per the docs.",
    notFor: 'A small, well-understood change where a cheaper model already gets it right.',
    examples: [
      'Untangle a deadlock that only reproduces under real load.',
      'Migrate a subsystem to a new dependency and verify every call site.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  'gpt-oss-120b': {
    tier: 'balanced',
    what: "An open-weight generalist model offered as one of this provider's alternative reasoning models — not customizable away on Enterprise, per the docs.",
    notFor: 'A task that specifically needs one of the named frontier models above.',
    examples: [
      'Write a unit test for this pure function.',
      'Explain what this configuration option controls.'
    ],
    launchTarget: true,
    effortLevels: FULL_LADDER,
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  },

  /**
   * Image generation only — the docs describe it for UI mockups, web page
   * graphics, diagrams and architectural visualizations, never for running a
   * coding prompt. `launchTarget: false` on the same terms `codex-auto-review`
   * is: a real catalogue entry this table must still resolve, never offer.
   */
  'nano-banana-2': {
    tier: 'special-purpose',
    what: 'An image-generation model for mockups, diagrams and architectural visualizations — never a model that runs a coding prompt.',
    notFor: 'Every coding or agentic task this launch surface exists for.',
    examples: [
      '(not applicable — this model is never offered as a launch choice)',
      '(see launchTarget: false)'
    ],
    launchTarget: false,
    effortLevels: [],
    relativeCost: 'unverified',
    sources: [ANTIGRAVITY_MODELS],
    verifiedOn: VERIFIED_ON
  }
}
