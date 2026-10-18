import type { IpcResult, SupplierEntryView } from '@dwarfai/contracts'
import { isDwarfProvider, type AgentModelCatalog, type AgentProviderOption } from '../../types'

/*
 * A-36's answer in the Add panel's own vocabulary (ISSUE-001; 21 §2 cut 3 common rules; 14 §3.6 `SupplierEntryView`):
 * from 3a the renderer asks one catalogue, every provider's entry with its models and their efforts (A-37 retired,
 * the models of a provider not yet moved merged in by `CatalogMergeAdapter`, 21 §3.1). The chips, the model picker and
 * the effort picker keep reading the provider list and the catalogues they always read, built here from it. Pure.
 *
 * - An entry is a launchable chip while its supplier is installed. The Host lists only what it may launch in its build
 *   (ADR-009 D6: a public build lists no `publicLaunch: 'gated'` entry, R-03; a development build keeps one
 *   launchable), so the build is never decided here. AMENDED for ISSUE-188 (was: also `publicLaunch === 'enabled'`,
 *   which left a development build's Antigravity off the chips). No reason sentence is made up for one that is not.
 * - A supplier with no chip of the panel (a development-only one) is left out, as the chips leave it out.
 * - A call error is no source at all: every picker says the provider does not report its models.
 */

export interface LaunchSources {
  providers: AgentProviderOption[]
  catalogs: AgentModelCatalog[]
}

export function launchSourcesOf(answer: IpcResult<readonly SupplierEntryView[]>): LaunchSources {
  const sources: LaunchSources = { providers: [], catalogs: [] }
  if (!answer.ok) return sources
  for (const entry of answer.value) {
    const provider = entry.providerId
    if (!isDwarfProvider(provider)) continue
    sources.providers.push({
      provider,
      installed: entry.installed,
      launchable: entry.installed
    })
    const efforts: string[] = []
    for (const model of entry.models) {
      for (const effort of model.efforts) if (!efforts.includes(effort)) efforts.push(effort)
    }
    sources.catalogs.push({
      provider,
      models: entry.models.map((model) => ({
        value: model.value,
        ...(model.label === undefined ? {} : { label: model.label }),
        ...(model.efforts.length === 0 ? {} : { effortLevels: [...model.efforts] })
      })),
      efforts,
      source: entry.models.length === 0 ? 'none' : 'provider'
    })
  }
  return sources
}
