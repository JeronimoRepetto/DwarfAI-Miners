// layer: L2
// L2 (17 §1.2): the jev `RoutingCatalogSource` bridge (16 §4.9 "bridge → suppliers"; 21 §2 cut 3 "Let
// Jev choose"): it answers `SupplierCatalogueQueries.launchable()` as is, read again on every call,
// so a provider that stops being launchable at this step is never a criterion. Inline catalogue
// double (R15).
import { describe, expect, it } from 'vitest'
import type { SupplierCatalogueQueries, SupplierEntry } from '../../modules/suppliers'
import { routingCatalogSource } from './routingCatalogSource'

function entry(providerId: string): SupplierEntry {
  return {
    providerId,
    label: `Label ${providerId}`,
    models: ['m'],
    efforts: [],
    permissionModes: ['read-only'],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'none'
  }
}

describe('routingCatalogSource', () => {
  it('[US-LAUNCH-003.AC11] answers the launchable list as suppliers answers it, read on every call, never filtered or widened', async () => {
    const answers: SupplierEntry[][] = [[entry('claude'), entry('codex')], [entry('codex')]]
    let reads = 0
    const catalogue: Pick<SupplierCatalogueQueries, 'launchable'> = {
      launchable: () => Promise.resolve(answers[reads++] ?? [])
    }
    const source = routingCatalogSource(catalogue)

    expect(await source.launchable()).toStrictEqual([entry('claude'), entry('codex')])
    expect(await source.launchable()).toStrictEqual([entry('codex')])
    expect(reads).toBe(2)
  })
})
