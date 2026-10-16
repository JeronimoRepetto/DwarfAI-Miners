// layer: L6
// L6 (17 §1.6): B-M37 `suppliers.launchable` (14 §2.3, §3.4, §3.6 `SupplierEntryView`, frozen) on
// the Host dispatcher: the strict params schema (ADR-019), the wire type equal to the contract
// type, and the entry of a gated provider carrying its answer channel and gating integration
// (ADR-011 items 1, 7). The catalogue is an inline double (R15): what it answers is the suppliers
// module's rule (catalogue.test.ts); the mapping onto the wire is this method's.
//
// TC-163-02 and TC-163-04.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_METHOD_SCHEMAS,
  supplierEntryViewSchema,
  type HostMethods,
  type SupplierEntryView
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { ModelEntry, ProviderId, SupplierEntry } from '../../modules/suppliers'
import { Dispatcher } from '../dispatcher'
import { registerSuppliersLaunchable } from './suppliersLaunchable'

const UI = { role: 'ui' as const, clientId: 'ui-1' }

/** A supplier whose answer channel is gated by an integration that is off (ADR-011 item 7). */
const GATED: SupplierEntry = {
  providerId: 'opencode',
  label: 'OpenCode',
  models: ['model-a'],
  efforts: [],
  permissionModes: ['read-only', 'full-access'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel: 'gated-off',
  gatingIntegration: 'opencode-permissions'
}

const MODELS: Readonly<Record<string, readonly ModelEntry[]>> = {
  opencode: [{ id: 'model-a', label: 'Model A', efforts: ['low', 'high'] }]
}

function served(entries: readonly SupplierEntry[]) {
  const clock = new FakeClock()
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  registerSuppliersLaunchable(dispatcher, {
    catalogue: { launchable: () => Promise.resolve(entries.map((entry) => ({ ...entry }))) },
    models: (id: ProviderId) => MODELS[id] ?? []
  })
  return (params: unknown) =>
    dispatcher.dispatch({ id: 'req-1', method: 'suppliers.launchable', params }, UI)
}

describe('suppliers.launchable (B-M37)', () => {
  it('[ADR-019] the suppliers.launchable params schema is strict and refresh is the only accepted key', async () => {
    const call = served([GATED])

    expect((await call({})).ok).toBe(true)
    expect((await call({ refresh: true })).ok).toBe(true)
    expect((await call({ refresh: false })).ok).toBe(true)
    for (const params of [
      { refresh: 'yes' },
      { refresh: 1 },
      { refresh: true, extra: 1 },
      { requestId: '01890a5d-ac96-774b-bcce-b302099a8057' },
      null,
      []
    ]) {
      const res = await call(params)
      expect(res.ok ? 'ok' : res.error.code, JSON.stringify(params)).toBe('INVALID_PARAMS')
    }
  })

  it('[ADR-019] the zod-inferred SupplierEntryView equals the 14 section 3.6 type', () => {
    const schemas: Readonly<Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>> =
      HOST_METHOD_SCHEMAS
    expect(schemas['suppliers.launchable'], 'B-M37 has no contract schemas').toBeDefined()

    expectTypeOf<HostMethods['suppliers.launchable']['params']>().toEqualTypeOf<{
      refresh?: boolean
    }>()
    expectTypeOf<HostMethods['suppliers.launchable']['result']>().toEqualTypeOf<
      SupplierEntryView[]
    >()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['suppliers.launchable']['params']>
    >().toEqualTypeOf<HostMethods['suppliers.launchable']['params']>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['suppliers.launchable']['result']>
    >().toEqualTypeOf<SupplierEntryView[]>()
    expectTypeOf<z.infer<typeof supplierEntryViewSchema>>().toEqualTypeOf<SupplierEntryView>()
  })

  it('[ADR-011] an entry of a gated provider carries answerChannel gated-off and its gating integration', async () => {
    const res = await served([GATED])({})

    expect(res.ok, 'suppliers.launchable answered an error').toBe(true)
    if (!res.ok) return
    const result = supplierEntryViewSchema.array().parse(res.result)
    expect(result).toEqual([
      {
        providerId: 'opencode',
        label: 'OpenCode',
        permissionModes: ['read-only', 'full-access'],
        installed: true,
        publicLaunch: 'enabled',
        answerChannel: 'gated-off',
        gatingIntegration: 'opencode-permissions',
        models: [{ value: 'model-a', label: 'Model A', efforts: ['low', 'high'] }],
        offeredModes: ['read-only', 'full-access']
      }
    ])
    expect(result[0]?.offeredModes).not.toContain('ask-first')
  })
})
