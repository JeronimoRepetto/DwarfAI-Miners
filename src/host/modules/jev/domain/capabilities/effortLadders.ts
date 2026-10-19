// The effort ladder of every catalog provider, complete and ordered low → high (ADR-028
// Consequences; 16 §6.3). Jev maps its effort score onto the chosen provider's ladder, then
// `capEffort` caps it to the levels the chosen model accepts. Re-homed from the found tree's
// `src/main/domain/launchTuning.ts` (`PROVIDER_EFFORT_LEVELS`, ADR-028 Reuse) with its evidence.
// Pure data: no I/O, no clock read (05 §2.2, R1). A lookup table keyed by the catalog's provider
// ids, never a branch on one (R12).
import type { ProviderId } from '../../../../kernel/domain/values'

/**
 * The effort levels each CLI accepts, per catalog provider (`contracts/catalog/ids.mjs`).
 *
 * - **Claude Code 2.1.263** documents its own five in `claude --help`: `--effort <level>` (low,
 *   medium, high, xhigh, max).
 * - **codex-cli 0.153.4** documents none in `--help`; the model catalogue the CLI keeps under its own
 *   home carries `supported_reasoning_levels` per model, and their union is these six. `ultra` is
 *   Codex's alone.
 * - **Antigravity CLI 1.1.26** documents its own three in `agy --help`: `--effort (low|medium|high)`.
 * - **OpenCode**: `opencode run --variant <key>`; the union of every variant key observed across the
 *   measured models that carry a non-empty `variants` map (vendor-specific, #534).
 * - **Simulated** (15 §4.12): its catalog profile declares no effort levels.
 *
 * A provider absent from this table has no ladder: Jev picks no effort for it.
 */
export const PROVIDER_EFFORT_LEVELS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  antigravity: ['low', 'medium', 'high'],
  opencode: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking'],
  simulated: []
}

/** The ladder of `provider`, `[]` for a provider this table does not know. */
export function effortLadderOf(
  ladders: Readonly<Record<ProviderId, readonly string[]>>,
  provider: ProviderId
): readonly string[] {
  return ladders[provider] ?? []
}
