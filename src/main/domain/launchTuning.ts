import type { DwarfProvider } from './types'

/**
 * What a launch request may say about the model and the effort it wants (#239),
 * and the boundary check that decides whether it may say it.
 *
 * Pure, and in `domain/` for the reason `launchProviders.ts` is: this is a rule
 * about the request rather than about this machine, so it is asked of a plain
 * record and reaches into no adapter. `main/index.ts` calls it where it already
 * validates every other launch field — the parse functions there cannot be unit
 * tested, because that file owns Electron's `ipcMain`, so the rule lives here
 * and the endpoint calls it.
 *
 * ## Absent is not an instruction; present and unusable is
 *
 * This is the asymmetry the `config-layering` skill states, applied to a launch
 * request rather than to the settings file. A field that is ABSENT degrades:
 * the CLI keeps its own default, exactly as every launch before this issue did,
 * which is what makes ignoring the Add Panel's new row launch precisely as
 * before. A field that is PRESENT and cannot be carried out takes the whole
 * request down instead of being dropped.
 *
 * Dropping it would be worse here than in a config file, because the
 * disobedience is invisible: a launch that quietly discarded `effort: 'max'`
 * starts a real session at the CLI's own default, reports `launched: true`, and
 * nothing on screen ever says the instruction went nowhere. A refusal the panel
 * can show is the only honest end for a value nobody could have chosen.
 */

/** The model and effort one launch asked for. Either half may be absent. */
export interface LaunchTuning {
  /**
   * The model id as the CLI takes it, trimmed. Passed through and never echoed
   * back as a claim — see the note on the model half below.
   */
  model?: string
  /** One of `PROVIDER_EFFORT_LEVELS` for the provider being launched. */
  effort?: string
}

/**
 * The effort levels each CLI accepts, per provider.
 *
 * Verified live on 2026-09-07, and the two launchable providers are verified
 * from different kinds of evidence — which is exactly why this is a per-provider
 * table and not one union. A union would refuse a level Codex accepts and
 * accept one Claude does not have.
 *
 * **Claude Code 2.1.263** documents its own five in `claude --help`:
 * `--effort <level>  Effort level for the current session (low, medium, high,
 * xhigh, max)`. The Agent SDK's `EffortLevel` is the same five, so two
 * independent sources agree, and `Options.effort` on a held session takes
 * exactly that union.
 *
 * **codex-cli 0.153.4** documents NONE. Neither `codex --help` nor `codex exec
 * --help` names a level anywhere; all either offers is the generic
 * `-c key=value` override that carries one. What does state them is the model
 * catalogue the CLI keeps under its own home, written by the CLI itself from
 * the provider's list: each model row carries `supported_reasoning_levels`, and
 * their union across the eight models it listed on this machine is these six.
 * `ultra` is real and is Codex's alone.
 *
 * **Antigravity CLI 1.1.26** documents its own three in `agy --help`:
 * `--effort   Reasoning effort for the current CLI session (low|medium|high)`
 * (#282) — read-only, on the machine this table is verified against. Its own
 * three, not borrowed from either neighbour: it has no `xhigh`, no `max`, and
 * no `ultra`, which is exactly why a per-provider table exists rather than one
 * union.
 *
 * Effort levels are a closed enum a CLI documents, which is why they may live
 * here at all — the guideline that keeps MODEL names out of source (they come
 * from the provider live, or from config) is about a list that moves whenever
 * a model ships. If a CLI ever adds a level, this table is where it is added,
 * with its evidence beside it.
 */
export const PROVIDER_EFFORT_LEVELS: Record<DwarfProvider, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // AMENDED for #282 (was: `[]`, because Antigravity was an observer absent
  // from LAUNCHABLE_PROVIDERS — #237 gave it a launch path, and this is its
  // own documented three, verified live above).
  antigravity: ['low', 'medium', 'high']
}

/**
 * The tuning one payload asked for, or null when it asked for something that
 * cannot be carried out.
 *
 * Null means refuse the whole request, the way an unrecognised provider already
 * does (#168). Both halves are checked before either is kept, so a request is
 * never half honoured: a model applied while its effort was silently dropped
 * would cost the user real tokens at a depth they did not choose.
 *
 * The model half is deliberately NOT closed. No list of model names lives in
 * this repository, so what a bare boundary can check is the SHAPE — a trimmed,
 * non-empty string — and whether the name exists is the catalogue's question,
 * asked where the catalogue is. A name that passes here is handed to the CLI
 * unchanged and never reported back as a claim about what started: this side
 * cannot know, and the CLI's own `init`/transcript is what says.
 */
export function parseLaunchTuning(
  provider: DwarfProvider,
  payload: Record<string, unknown>
): LaunchTuning | null {
  const tuning: LaunchTuning = {}

  if (payload.model !== undefined) {
    if (typeof payload.model !== 'string') return null
    const model = payload.model.trim()
    if (model === '') return null
    tuning.model = model
  }

  if (payload.effort !== undefined) {
    if (typeof payload.effort !== 'string') return null
    // Trimmed because a text box collects whitespace, then matched exactly:
    // the CLIs' own enums are lowercase, and folding case here would accept a
    // spelling neither of them does.
    const effort = payload.effort.trim()
    if (!PROVIDER_EFFORT_LEVELS[provider].includes(effort)) return null
    tuning.effort = effort
  }

  return tuning
}
