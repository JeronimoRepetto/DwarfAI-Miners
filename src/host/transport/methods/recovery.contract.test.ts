// layer: L6
// L6 (17 §1.6): B-M35 `launching.retryRecovery`, B-M36 `launching.dismissRecovery` (14 §2.3, §3.4
// `RecoveryActionParams`, frozen; ADR-019 runtime validation) through the seam-B dispatcher, and
// B-F21 `host.recovered` (14 §2.4, §3.5, §3.6 `HostRecoveryReportView`; 14 §4.3 rule 5) as the
// launching wiring's route publishes it (wiring/routes/launching.ts `routeRecovery`). The module's
// own behaviour is the L2 flow (wiring/flows/recoveryReport.test.ts).
import { describe, expect, it } from 'vitest'
import {
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import type { DwarfId, EventId, HostEpoch } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import type { LaunchingEvent, RecoveryReportView } from '../../modules/launching'
import { routeRecovery } from '../../wiring/routes/launching'
import { Dispatcher } from '../dispatcher'
import { registerLaunchingDismissRecovery } from './launchingDismissRecovery'
import { registerLaunchingRetryRecovery } from './launchingRetryRecovery'

const EPOCH = 'epoch-0174' as HostEpoch
const OTHER_EPOCH = 'epoch-0173'
const REQUEST_ID = '01890a5d-ac96-774b-bcce-b30209917402'
const DWARF = '01890a5d-ac96-774b-bcce-b30209917403' as DwarfId
const UI = { role: 'ui' as const, clientId: 'c-ui' }

const VIEW: RecoveryReportView = {
  hostEpoch: EPOCH,
  at: 1_790_000_000_000,
  resumed: [],
  unrecovered: [{ dwarfId: DWARF, reason: 'stale-ref' }],
  state: 'pending-display'
}

function served() {
  const clock = new FakeClock(1_790_000_000_000)
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const calls: Array<[string, string, string]> = []
  const known = (hostEpoch: string) => hostEpoch === EPOCH
  registerLaunchingRetryRecovery(dispatcher, {
    recovery: {
      retryRecovery: async (hostEpoch, requestId) => {
        calls.push(['retry', hostEpoch, requestId])
        return known(hostEpoch)
          ? { ok: true, value: { ...VIEW, state: 'settled', settledAt: 1, unrecovered: [] } }
          : { ok: false, error: 'no-report' }
      }
    }
  })
  registerLaunchingDismissRecovery(dispatcher, {
    recovery: {
      dismissRecovery: (hostEpoch, requestId) => {
        calls.push(['dismiss', hostEpoch, requestId])
        return known(hostEpoch) ? { ok: true, value: undefined } : { ok: false, error: 'no-report' }
      }
    }
  })
  return { dispatcher, calls }
}

describe('launching.retryRecovery, launching.dismissRecovery and host.recovered (14 §3.4, §3.5)', () => {
  it('[ADR-019] launching.retryRecovery and launching.dismissRecovery params are strict and answer no-report for an epoch without an unsettled report', async () => {
    const { dispatcher, calls } = served()
    for (const method of ['launching.retryRecovery', 'launching.dismissRecovery'] as const) {
      const { params } = HOST_METHOD_SCHEMAS[method]
      expect(params.safeParse({ hostEpoch: EPOCH, requestId: REQUEST_ID }).success).toBe(true)
      expect(params.safeParse({ hostEpoch: EPOCH }).success).toBe(false)
      expect(
        params.safeParse({ hostEpoch: EPOCH, requestId: REQUEST_ID, dwarfIds: [DWARF] }).success
      ).toBe(false)
      const extra = await dispatcher.dispatch(
        {
          id: `${method}-extra`,
          method,
          params: { hostEpoch: EPOCH, requestId: REQUEST_ID, auto: true }
        },
        UI
      )
      expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(calls).toEqual([])

    const retryNone = await dispatcher.dispatch(
      {
        id: '1',
        method: 'launching.retryRecovery',
        params: { hostEpoch: OTHER_EPOCH, requestId: REQUEST_ID }
      },
      UI
    )
    expect(retryNone).toMatchObject({ ok: true, result: { ok: false, error: 'no-report' } })
    const dismissNone = await dispatcher.dispatch(
      {
        id: '2',
        method: 'launching.dismissRecovery',
        params: { hostEpoch: OTHER_EPOCH, requestId: '01890a5d-ac96-774b-bcce-b30209917404' }
      },
      UI
    )
    expect(dismissNone).toMatchObject({ ok: true, result: { ok: false, error: 'no-report' } })

    const retried = await dispatcher.dispatch(
      {
        id: '3',
        method: 'launching.retryRecovery',
        params: { hostEpoch: EPOCH, requestId: '01890a5d-ac96-774b-bcce-b30209917405' }
      },
      UI
    )
    expect(retried).toMatchObject({ ok: true, result: { ok: true, value: { state: 'settled' } } })
    expect(
      HOST_METHOD_SCHEMAS['launching.retryRecovery'].result.safeParse(
        (retried as { result: unknown }).result
      ).success
    ).toBe(true)
    const dismissed = await dispatcher.dispatch(
      {
        id: '4',
        method: 'launching.dismissRecovery',
        params: { hostEpoch: EPOCH, requestId: '01890a5d-ac96-774b-bcce-b30209917406' }
      },
      UI
    )
    expect(dismissed).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    // Only a ui connection may act on the report (roles.ts).
    const viewer = await dispatcher.dispatch(
      {
        id: '5',
        method: 'launching.dismissRecovery',
        params: { hostEpoch: EPOCH, requestId: '01890a5d-ac96-774b-bcce-b30209917407' }
      },
      { role: 'viewer', clientId: 'c-v' }
    )
    expect(viewer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[ADR-015] host.recovered carries the HostRecoveryReportView and is written to the first ui connection', () => {
    const bus = new RecordingEventBus<LaunchingEvent>()
    let shown = 0
    let ui = false
    const published: Array<{ name: HostFrameName; data: unknown }> = []
    routeRecovery({
      events: bus,
      recovery: {
        report: () => (shown === 0 ? VIEW : { ...VIEW, state: 'shown', shownAt: 5 }),
        view: () => VIEW,
        shown: () => {
          shown += 1
        },
        retryRecovery: async () => ({ ok: false, error: 'no-report' })
      },
      crew: { commands: { sessionClosed: () => undefined } },
      frames: {
        publishFrame: <F extends HostFrameName>(name: F, data: HostFrameData[F]) =>
          published.push({ name, data }),
        connections: () => (ui ? [{ role: 'ui' as const }] : [{ role: 'notifier' as const }])
      }
    })
    const recovered = {
      type: 'HostRecovered' as const,
      v: 1 as const,
      id: '01890a5d-ac96-774b-bcce-b30209917408' as EventId,
      at: 1,
      hostEpoch: EPOCH,
      payload: { report: VIEW }
    }

    // No ui connection yet: nothing is written; the snapshot `recovery` section carries it.
    bus.publish(recovered)
    expect(published).toEqual([])
    expect(shown).toBe(0)

    ui = true
    bus.publish({ ...recovered, id: '01890a5d-ac96-774b-bcce-b30209917409' as EventId })
    expect(published.map((f) => f.name)).toEqual(['host.recovered'])
    expect(HOST_FRAME_SCHEMAS['host.recovered'].safeParse(published[0]?.data).success).toBe(true)
    expect(published[0]?.data).toEqual({ report: VIEW })
    expect(shown).toBe(1)
    // A view field the contract does not list never reaches the wire.
    expect(
      HOST_FRAME_SCHEMAS['host.recovered'].safeParse({ report: { ...VIEW, retried: true } }).success
    ).toBe(false)
  })
})
