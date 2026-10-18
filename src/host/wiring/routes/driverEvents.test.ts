// layer: L2
// The routes of a launched session's driver events (05 §4; 08 §4; 15 §1.4; ISSUE-182), each
// through the target module's public API: entries → conversation `ingest('live-stream')`, usage →
// ledger `creditUsage(…, 'driver')`, `ask.opened` / `ask.resolved` → asking `open` /
// `resolveExternally`, `turn.ended` → conversation `recordTurnEnd`, `exited` → the
// `DriverSessionExited` route, a driver error → mines `checkFolder` for the dwarf's mine, and the
// status and activity records → crew `recordActivity`. Recording doubles only.
import { describe, expect, it } from 'vitest'
import type { TurnEnded, UsageObservation } from '../../kernel/domain/sharedContracts'
import type { DwarfId, MineId, ProviderId } from '../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { AskInput, SessionRef, SuppliedEvent } from '../../modules/suppliers'
import { routeDriverEvents } from './driverEvents'

const DWARF = '00000000-0000-7000-8000-0000000182e1' as DwarfId
const MINE = '00000000-0000-7000-8000-0000000182e2' as MineId
const REF: SessionRef = { providerId: 'claude' as ProviderId, providerSessionId: 'session-182' }

function world(options: { failIngest?: boolean } = {}) {
  const calls: unknown[] = []
  const log = new RecordingDiagnosticsLog()
  const sink = routeDriverEvents({
    conversation: {
      ingest: (dwarfId, entries, origin) => {
        if (options.failIngest === true) throw new Error('the message log is locked')
        calls.push({ ingest: { dwarfId, entries, origin } })
      },
      recordTurnEnd: (end) => calls.push({ recordTurnEnd: end })
    },
    crew: {
      commands: {
        recordActivity: (dwarfId, kind) => calls.push({ recordActivity: { dwarfId, kind } })
      },
      queries: { get: (dwarfId) => (dwarfId === DWARF ? { mineId: MINE } : null) }
    },
    asking: {
      open: (dwarfId, input) => {
        calls.push({ open: { dwarfId, input } })
        return {} as never
      },
      resolveExternally: (dwarfId, providerRequestId, by) =>
        calls.push({ resolveExternally: { dwarfId, providerRequestId, by } })
    },
    ledger: {
      creditUsage: (o, path) => {
        calls.push({ creditUsage: { o, path } })
        return 'stored'
      }
    },
    mines: {
      checkFolder: async (mineId) => {
        calls.push({ checkFolder: mineId })
        return {} as never
      }
    },
    exits: { deliver: (delivery) => calls.push({ exited: delivery.event }) },
    log
  })
  const deliver = (event: SuppliedEvent): void => sink.deliver({ dwarfId: DWARF, ref: REF, event })
  return { calls, deliver, log }
}

const ENTRY = {
  sourceKey: 'claude:session-182:msg-1',
  role: 'dwarf' as const,
  text: 'The north face is marked.',
  providerTime: null
}

describe('driver event routes', () => {
  it('[C-05, S7.04] a driver entry is ingested as a live-stream entry of the bound dwarf and counts as its activity', () => {
    const { calls, deliver } = world()
    deliver({ t: 'message', record: ENTRY })
    expect(calls).toEqual([
      { ingest: { dwarfId: DWARF, entries: [ENTRY], origin: 'live-stream' } },
      { recordActivity: { dwarfId: DWARF, kind: 'message' } }
    ])
  })

  it('[ADR-021] a driver turn end is recorded by conversation with the dwarf suppliers stamped', () => {
    const { calls, deliver } = world()
    const end = { dwarfId: DWARF, kind: 'concluded', turnKey: 't-1' } as unknown as TurnEnded
    deliver({ t: 'turn.ended', end })
    expect(calls).toEqual([{ recordTurnEnd: end }])
  })

  it('[ADR-006] a driver usage observation is credited on the driver path', () => {
    const { calls, deliver } = world()
    const observation = { dwarfId: DWARF, sourceKey: 'u-1' } as unknown as UsageObservation
    deliver({ t: 'usage', observation })
    expect(calls).toEqual([{ creditUsage: { o: observation, path: 'driver' } }])
  })

  it('[ADR-010] a driver ask opens a driver-channel ask for the bound dwarf and its resolution resolves it externally', () => {
    const { calls, deliver } = world()
    const ask = {
      kind: 'permission',
      providerRequestId: 'tool-use-1',
      channel: 'driver',
      payload: { toolName: 'Bash', requestText: 'ls' },
      options: { hasAllowOnce: true, hasRejectOnce: true }
    } as unknown as AskInput
    deliver({ t: 'ask.opened', ask })
    deliver({ t: 'ask.resolved', providerRequestId: 'tool-use-1', by: 'cancelled' })
    expect(calls).toEqual([
      { open: { dwarfId: DWARF, input: ask } },
      {
        resolveExternally: { dwarfId: DWARF, providerRequestId: 'tool-use-1', by: 'cancelled' }
      }
    ])
  })

  it('[S1.08] a working status is the turn start of the dwarf, an idle one moves nothing', () => {
    const { calls, deliver } = world()
    deliver({ t: 'status', value: 'working' })
    deliver({ t: 'status', value: 'idle' })
    expect(calls).toEqual([{ recordActivity: { dwarfId: DWARF, kind: 'turn-started' } }])
  })

  it('[S15.13] a driver exit goes to the DriverSessionExited route', () => {
    const { calls, deliver } = world()
    deliver({ t: 'exited', code: 0 })
    expect(calls).toEqual([{ exited: { t: 'exited', code: 0 } }])
  })

  it('[S3.12] a driver error checks the folder of the dwarf mine', () => {
    const { calls, deliver, log } = world()
    deliver({
      t: 'error',
      cause: { kind: 'provider-error', detail: 'overloaded', retryable: true }
    })
    expect(calls).toEqual([{ checkFolder: MINE }])
    // The cause class only, never the provider's detail (ADR-026).
    expect(log.byEvent('driver.error')).toEqual([
      expect.objectContaining({ causeClass: 'provider-error' })
    ])
    expect(JSON.stringify(log.entries)).not.toContain('overloaded')
  })

  it('[S7.04] a route that throws is logged and the next event of the session is still routed', () => {
    const { calls, deliver, log } = world({ failIngest: true })
    deliver({ t: 'message', record: ENTRY })
    deliver({ t: 'exited', code: 0 })
    expect(calls).toEqual([{ exited: { t: 'exited', code: 0 } }])
    expect(log.byEvent('uncaught')).toHaveLength(1)
  })
})
