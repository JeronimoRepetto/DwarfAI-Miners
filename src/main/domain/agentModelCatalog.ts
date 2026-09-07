import { PROVIDER_EFFORT_LEVELS } from './launchTuning'
import type { AgentModelCatalog, DwarfProvider, ModelOption } from './types'

/** A mutable copy of one provider's effort levels — the wire field is not readonly. */
function effortsFor(provider: DwarfProvider): string[] {
  return [...PROVIDER_EFFORT_LEVELS[provider]]
}

/**
 * Turning what each provider can actually say about its own models into the
 * wire's AgentModelCatalog, one provider at a time (#239).
 *
 * Pure, and in `domain/` for the reason `launchTuning.ts` is: this is a rule
 * about SHAPING an answer, not about asking one — the ask itself needs the
 * Agent SDK (sdkHeldSession.ts's createSdkModelCatalog) or Codex's own SQLite
 * registry (readCodexThreads), neither of which a unit test may reach. So the
 * IO lives in runtime.ts and sessionLaunch/, and this file is what turns
 * whatever came back into something the wire can carry — which is what makes
 * every branch below testable with a plain array, no disk and no process.
 */

/**
 * One model Claude's own `supportedModels()` named, narrowed at the SDK seam
 * before this app's wire shape decides what crosses (#239). Deliberately not
 * the SDK's own `ModelInfo` — this is the app's side of that boundary, and it
 * keeps only what a catalogue entry needs.
 */
export interface ClaudeModelInfo {
  value: string
  displayName: string
  supportsEffort: boolean
}

/**
 * Claude's catalogue from a live `supportedModels()` answer — `source:
 * 'provider'`, the strongest of the three, because it was asked live and can
 * never be stale.
 *
 * `label` is dropped when the display name is empty or repeats the value:
 * a picker with no distinct label just shows the value, and inventing one
 * that matched it anyway would be this app claiming a name the SDK did not
 * give.
 */
export function claudeModelCatalog(models: readonly ClaudeModelInfo[]): AgentModelCatalog {
  return {
    provider: 'claude',
    models: models.map((model): ModelOption => ({
      value: model.value,
      ...(model.displayName !== '' && model.displayName !== model.value
        ? { label: model.displayName }
        : {})
    })),
    efforts: effortsFor('claude'),
    source: 'provider'
  }
}

/**
 * Claude's catalogue when nothing could be asked live — not installed, or the
 * short-lived query itself failed. `source: 'none'`: an empty list from a
 * provider that normally answers live must not be confused with `'history'`,
 * which promises nothing about completeness in the first place.
 */
export function unavailableClaudeModelCatalog(): AgentModelCatalog {
  return { provider: 'claude', models: [], efforts: effortsFor('claude'), source: 'none' }
}

/** The one field this reads off a Codex registry row — see readCodexThreads. */
export interface CodexThreadModel {
  model?: string
}

/**
 * Codex's catalogue: every distinct model this machine's own registry has
 * actually recorded, most-recently-used first (#239) — `source: 'history'`
 * always, whether or not anything was found, because the DERIVATION never
 * changes: Codex names no live model-list command (`codex --help` and
 * `codex exec --help` both lack one), so every answer here is inferred from
 * past use rather than asked.
 *
 * `threads` is expected pre-sorted newest-activity-first, exactly as
 * `readCodexThreads` already returns them — order is read, never re-derived,
 * so this stays a plain de-duplication and nothing here has to know what
 * "most recent" means for a registry row.
 */
export function codexModelCatalog(threads: readonly CodexThreadModel[]): AgentModelCatalog {
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const thread of threads) {
    const model = thread.model
    if (model === undefined || model === '' || seen.has(model)) continue
    seen.add(model)
    models.push({ value: model })
  }
  return { provider: 'codex', models, efforts: effortsFor('codex'), source: 'history' }
}

/**
 * Antigravity's catalogue: always none, until #237 gives it a launch path —
 * see HELDABLE_PROVIDERS and LAUNCHABLE_PROVIDERS for the same absence, drawn
 * for the same reason.
 */
export function antigravityModelCatalog(): AgentModelCatalog {
  return {
    provider: 'antigravity',
    models: [],
    efforts: effortsFor('antigravity'),
    source: 'none'
  }
}
