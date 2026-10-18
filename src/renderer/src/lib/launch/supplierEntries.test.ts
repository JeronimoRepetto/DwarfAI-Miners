// layer: L1
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS, type ProviderId, type SupplierEntryView } from '@dwarfai/contracts'
import { launchSourcesOf } from './supplierEntries'

const [CLAUDE = '', CODEX = '', , , SIMULATED = ''] = CATALOG_PROVIDER_IDS

function entry(providerId: string, overrides: Partial<SupplierEntryView> = {}): SupplierEntryView {
  return {
    providerId: providerId as ProviderId,
    label: providerId,
    models: [],
    permissionModes: [],
    offeredModes: [],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available',
    ...overrides
  }
}

/*
 * From 3a A-36 answers the 14 `SupplierEntryView[]` for every provider (21 §2 cut 3 common rules; A-37 retired, its
 * models merged into each entry). The Add panel's chips and pickers keep reading the panel's own provider and catalogue
 * lists, built here from that one answer.
 */
describe('launchSourcesOf', () => {
  it('[ADR-033] each launchable entry becomes a chip and a catalogue with its models and their efforts', () => {
    const sources = launchSourcesOf({
      ok: true,
      value: [
        entry(CLAUDE, {
          models: [
            { value: 'opus', label: 'Opus', efforts: ['high', 'max'] },
            { value: 'haiku', efforts: [] }
          ]
        }),
        entry(CODEX, { installed: false }),
        entry(SIMULATED)
      ]
    })
    expect(sources.providers).toEqual([
      { provider: CLAUDE, installed: true, launchable: true },
      { provider: CODEX, installed: false, launchable: false }
    ])
    expect(sources.catalogs).toEqual([
      {
        provider: CLAUDE,
        models: [
          { value: 'opus', label: 'Opus', effortLevels: ['high', 'max'] },
          { value: 'haiku' }
        ],
        efforts: ['high', 'max'],
        source: 'provider'
      },
      { provider: CODEX, models: [], efforts: [], source: 'none' }
    ])
  })

  it('[ADR-033] a gated entry is no launchable chip, and a call error is no source at all', () => {
    expect(
      launchSourcesOf({ ok: true, value: [entry(CLAUDE, { publicLaunch: 'gated' })] }).providers
    ).toEqual([{ provider: CLAUDE, installed: true, launchable: false }])
    expect(
      launchSourcesOf({
        ok: false,
        error: { code: 'INTERNAL', message: 'no Host', retryable: true }
      })
    ).toEqual({ providers: [], catalogs: [] })
  })
})
