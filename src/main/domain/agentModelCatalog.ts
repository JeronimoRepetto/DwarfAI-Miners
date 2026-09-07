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
 * Agent SDK (sdkHeldSession.ts's createSdkModelCatalog), Codex's own SQLite
 * registry (readCodexThreads), or a read-only `agy models` spawn
 * (providers/antigravity/models.ts's createAntigravityModelCatalog, #282),
 * none of which a unit test may reach. So the IO lives in runtime.ts and the
 * two provider-specific modules above, and this file is what turns whatever
 * came back into something the wire can carry — which is what makes every
 * branch below testable with a plain array, no disk and no process.
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
  /**
   * The effort levels this model itself named, off the SDK's own
   * `supportedEffortLevels` (issue #96) — absent or empty when the answer
   * carried none, which is a real possibility even on a model that says it
   * supports effort. `supportsEffort` alone decides WHETHER a control is
   * offered; this decides which values it offers.
   */
  effortLevels?: string[]
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
 *
 * `effortLevels` rides each option since #96, gated on `supportsEffort` and
 * nothing else — see `modelEffortLevels` below for why the gate is there and
 * where the values come from when the model named none.
 */
export function claudeModelCatalog(models: readonly ClaudeModelInfo[]): AgentModelCatalog {
  const efforts = effortsFor('claude')
  return {
    provider: 'claude',
    models: models.map((model): ModelOption => {
      const effortLevels = modelEffortLevels(model, efforts)
      return {
        value: model.value,
        ...(model.displayName !== '' && model.displayName !== model.value
          ? { label: model.displayName }
          : {}),
        ...(effortLevels === undefined ? {} : { effortLevels })
      }
    }),
    efforts,
    source: 'provider'
  }
}

/**
 * Which effort levels one model actually offers, or undefined for "offer no
 * effort control at all" (issue #96).
 *
 * The gate is `supportsEffort`, exactly as the maintainer's ruling names it,
 * and it is a hard one: `applyFlagSettings({ effortLevel })` on a model
 * without it resolves cleanly and silently does nothing — measured live in
 * #96's spike — so a control drawn for such a model would answer a click by
 * doing nothing and reporting success.
 *
 * A model that passes the gate but named no levels falls back to the
 * PROVIDER's own boundary list rather than to nothing. Not an invention: that
 * list is what every launch of this provider is already checked against
 * (`PROVIDER_EFFORT_LEVELS`), so the fallback cannot offer a level the
 * boundary would refuse — and the alternative, no control on a model that
 * said outright that it takes one, would hide a setting that works. An empty
 * list is read as "named none", not as "an effort control with nothing in it".
 */
function modelEffortLevels(
  model: ClaudeModelInfo,
  providerEfforts: readonly string[]
): string[] | undefined {
  if (!model.supportsEffort) return undefined
  const named = model.effortLevels ?? []
  return named.length > 0 ? [...named] : [...providerEfforts]
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
 * One model Antigravity's own `agy models` line named — id and label,
 * tab-separated, parsed by providers/antigravity/models.ts (#282). Kept
 * distinct from `ModelOption` for the same reason `ClaudeModelInfo` is: this
 * is what the CLI seam hands the domain, before the label-dropping rule below
 * decides what the wire actually carries.
 */
export interface AntigravityModelInfo {
  value: string
  displayName: string
}

/**
 * Antigravity's catalogue from a live `agy models` answer — `source:
 * 'provider'`, on the same terms as Claude's: asked live, on demand, so it can
 * never be stale (#282). Until this issue the answer was always none — #237
 * gave Antigravity a launch path but no live list, and #239 left
 * `PROVIDER_EFFORT_LEVELS.antigravity` empty because nothing could carry an
 * effort yet.
 *
 * `label` is dropped on the same terms as Claude's, for the same reason: a
 * picker with no distinct label just shows the value.
 */
export function antigravityModelCatalog(
  models: readonly AntigravityModelInfo[]
): AgentModelCatalog {
  return {
    provider: 'antigravity',
    models: models.map((model): ModelOption => ({
      value: model.value,
      ...(model.displayName !== '' && model.displayName !== model.value
        ? { label: model.displayName }
        : {})
    })),
    efforts: effortsFor('antigravity'),
    source: 'provider'
  }
}

/**
 * Antigravity's catalogue when nothing could be asked live — not installed,
 * the spawn failed, or its output could not be read as a model list (#282).
 * `source: 'none'`, on the same terms as `unavailableClaudeModelCatalog`: an
 * empty list from a provider that normally answers live must not be confused
 * with `'history'`, which promises nothing about completeness in the first
 * place.
 */
export function unavailableAntigravityModelCatalog(): AgentModelCatalog {
  return { provider: 'antigravity', models: [], efforts: effortsFor('antigravity'), source: 'none' }
}
