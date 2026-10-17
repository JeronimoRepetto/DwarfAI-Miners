// layer: L2
import { describe, expect, it } from 'vitest'
import { supplierEntryViewSchema, type SupplierEntryView } from '@dwarfai/contracts'
import { createCatalogMergeAdapter } from './CatalogMergeAdapter'

/** A Host entry of a moved provider, as `suppliers.launchable` answers it. */
const HOST_CLAUDE: SupplierEntryView = {
  providerId: 'claude',
  label: 'Claude Code',
  models: [{ value: 'opus', efforts: ['high'] }],
  permissionModes: ['default'],
  offeredModes: ['default'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'available'
}
/** A Host entry of a provider still launched `legacy`: never part of the answer. */
const HOST_CODEX: SupplierEntryView = { ...HOST_CLAUDE, providerId: 'codex', label: 'Codex' }

/** Today's A-36 answer: Claude, Codex and OpenCode can start from the panel; Antigravity cannot. */
const TODAY_PROVIDERS = {
  providers: [
    { provider: 'claude', installed: true, launchable: true },
    { provider: 'codex', installed: true, launchable: true },
    { provider: 'antigravity', installed: false, launchable: false, reason: 'not here' },
    { provider: 'opencode', installed: true, launchable: true }
  ]
}
/** Today's model catalog (what A-37 answered). */
const TODAY_CATALOG = {
  catalogs: [
    {
      provider: 'claude',
      models: [{ value: 'sonnet' }],
      efforts: ['low'],
      source: 'provider'
    },
    {
      provider: 'codex',
      models: [
        { value: 'gpt-5-codex', label: 'GPT-5 Codex', effortLevels: ['low', 'high'] },
        { value: 'o3' }
      ],
      efforts: ['medium'],
      source: 'history'
    },
    { provider: 'opencode', models: [], efforts: [], source: 'none' }
  ]
}

function world(
  moved: readonly string[],
  host: () => Promise<unknown> = () => Promise.resolve([HOST_CLAUDE, HOST_CODEX])
) {
  const legacyServed: Array<[string, unknown]> = []
  const hostCalls: Array<[string, unknown]> = []
  let catalogReads = 0
  const adapter = createCatalogMergeAdapter({
    legacy: {
      serve: (channel, payload) => {
        legacyServed.push([channel, payload])
        return Promise.resolve(channel === 'agent:providers' ? TODAY_PROVIDERS : undefined)
      }
    },
    models: {
      read: () => {
        catalogReads += 1
        return Promise.resolve(TODAY_CATALOG)
      }
    },
    client: {
      call: (method: string, params: unknown) => {
        hostCalls.push([method, params])
        return host()
      }
    } as never,
    movedProviders: new Set(moved)
  })
  return { adapter, legacyServed, hostCalls, catalogReads: () => catalogReads }
}

const CODEX_ENTRY: SupplierEntryView = {
  providerId: 'codex',
  label: 'Codex CLI',
  models: [
    { value: 'gpt-5-codex', label: 'GPT-5 Codex', efforts: ['low', 'high'] },
    { value: 'o3', efforts: ['medium'] }
  ],
  permissionModes: ['default', 'workspace-write', 'read-only'],
  offeredModes: ['default', 'workspace-write', 'read-only'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'available'
}
const OPENCODE_ENTRY: SupplierEntryView = {
  providerId: 'opencode',
  label: 'OpenCode',
  models: [],
  permissionModes: [],
  offeredModes: [],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'available'
}

describe('CatalogMergeAdapter (21 §3.1)', () => {
  it("[ADR-001] a legacy provider's models come from the legacy model catalog and A-37 is never called", async () => {
    const { adapter, legacyServed, hostCalls, catalogReads } = world(['claude'])

    const answer = await adapter.serve('agent:providers', { refresh: true })

    expect(answer).toEqual({ ok: true, value: [HOST_CLAUDE, CODEX_ENTRY, OPENCODE_ENTRY] })
    for (const entry of (answer as { value: unknown[] }).value) {
      expect(supplierEntryViewSchema.safeParse(entry).success).toBe(true)
    }
    // Today's provider list is read through today's A-36 handler; the catalog is read inside the adapter, once.
    expect(legacyServed).toEqual([['agent:providers', undefined]])
    expect(legacyServed.some(([channel]) => channel === 'agent:models')).toBe(false)
    expect(catalogReads()).toBe(1)
    expect(hostCalls).toEqual([['suppliers.launchable', { refresh: true }]])
  })

  it('[ADR-001] with no provider moved the Host is not asked, and a Host call error is the answer when one is', async () => {
    const none = world([])
    expect(await none.adapter.serve('agent:providers', {})).toEqual({
      ok: true,
      value: [
        {
          ...CODEX_ENTRY,
          providerId: 'claude',
          label: 'Claude Code',
          permissionModes: [],
          offeredModes: [],
          models: [{ value: 'sonnet', efforts: ['low'] }]
        },
        CODEX_ENTRY,
        OPENCODE_ENTRY
      ]
    })
    expect(none.hostCalls).toEqual([])

    const down = world(['claude'], () =>
      Promise.reject({ error: { code: 'HOST_UNAVAILABLE', message: 'down', retryable: true } })
    )
    expect(await down.adapter.serve('agent:providers', {})).toEqual({
      ok: false,
      error: { code: 'HOST_UNAVAILABLE', message: 'down', retryable: true }
    })
  })

  it('[ADR-001] a request off the A-36 shape or another row reaches nothing', async () => {
    const { adapter, legacyServed, hostCalls } = world(['claude'])
    expect(await adapter.serve('agent:providers', { refresh: 'yes' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'INVALID_PARAMS' })
    })
    expect(await adapter.serve('agent:models', undefined)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'METHOD_NOT_FOUND' })
    })
    expect(legacyServed).toEqual([])
    expect(hostCalls).toEqual([])
  })
})
