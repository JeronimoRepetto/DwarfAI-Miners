// layer: L3
// A "Let Jev choose" launch that fails with a Jev cause always stores its `jev_reason` (ISSUE-182,
// coordinator ruling on #1413): the `launches` CHECK refuses a Jev cause without one (09 §4.3,
// `failure_cause NOT IN ('jev-unreachable', 'jev-could-not-choose') OR jev_reason IS NOT NULL`),
// which left such a launch in `routing` for good (and holding the upgrade drain). The launch use case
// runs over the SQLite launching stores of a template copy (17 §1.3), so every row meets the real
// CHECKs; the advisor is an inline double (16 §2.8) answering what each case names.
import { describe, expect, it } from 'vitest'
import type { DwarfId, HostEpoch } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import type { MineView } from '../../../mines'
import { createLaunching, type AbortableLaunchAdvisor, type LaunchingEvent } from '../..'
import { FakeSessionStarter } from '../../testing/FakeSessionStarter'
import {
  MINE,
  MINE_FOLDER,
  T0,
  seedMine,
  sqliteLaunchingStores
} from '../../testing/sqliteLaunchingDb'

const DWARF = '00000000-0000-7000-8000-0000000182e9' as DwarfId

function host(advisor: AbortableLaunchAdvisor) {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  seedMine(db, runner)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const stores = sqliteLaunchingStores({ db, scope: runner, clock, ids })
  const bus = new RecordingEventBus<LaunchingEvent>()
  const log = new RecordingDiagnosticsLog()
  const launching = createLaunching({
    launches: stores.launches,
    processes: stores.processes,
    records: stores.records,
    transactions: runner,
    starter: new FakeSessionStarter({ clock, scheduler, supplierLabel: 'Simulated' }),
    advisor,
    suppliers: {
      registry: { drivers: () => [] },
      launchDriver: async () => undefined,
      catalogue: { entry: () => null },
      bindings: { bind: () => undefined }
    },
    mines: {
      get: (id) => (id === MINE ? ({ id: MINE, state: 'active' } as MineView) : null),
      folderOf: (id) => (id === MINE ? MINE_FOLDER : null)
    },
    crew: { arrive: () => DWARF, sessionClosed: () => undefined },
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: 'epoch-182' as HostEpoch,
    installId: '00000000-0000-7000-8000-0000000182fe',
    log
  })
  const launch = async () => {
    const accepted = await launching.commands.launch({
      mineId: MINE,
      way: { kind: 'jev' },
      prompt: 'Chart the lower tunnels',
      jevOn: true,
      jevAutoAccept: false
    })
    // The continuation runs on the scheduler after the answer (application/launch.ts).
    for (let step = 0; step < 20; step += 1) {
      clock.advance(10)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    }
    return db.all('SELECT state, failure_cause, jev_reason FROM launches WHERE id = ?', [
      accepted.launchId
    ])
  }
  return { launch, bus, log }
}

const answering = (answer: Awaited<ReturnType<AbortableLaunchAdvisor['suggest']>>) =>
  ({ suggest: () => Promise.resolve(answer) }) as AbortableLaunchAdvisor

describe('a Jev launch cause always stores its reason', () => {
  it('[ADR-020, S5.15] an advisor error with its reason fails the launch with that jev_reason', async () => {
    const error = { ok: false, error: 'jev-could-not-choose', reason: 'no-launchable-provider' }
    const h = host(answering(error as never))

    expect(await h.launch()).toEqual([
      {
        state: 'failed',
        failure_cause: 'jev-could-not-choose',
        jev_reason: 'no-launchable-provider'
      }
    ])
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[ADR-020, S5.14] an advisor error that names no reason still settles: never left in routing', async () => {
    const h = host(answering({ ok: false, error: 'jev-unreachable' }))

    expect(await h.launch()).toEqual([
      { state: 'failed', failure_cause: 'jev-unreachable', jev_reason: 'unreachable' }
    ])
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[ADR-020, S5.15] a could-not-choose error that names no reason still settles with a jev_reason', async () => {
    const h = host(answering({ ok: false, error: 'jev-could-not-choose' }))

    const [row] = await h.launch()
    expect(row).toMatchObject({ state: 'failed', failure_cause: 'jev-could-not-choose' })
    expect(row?.['jev_reason']).not.toBeNull()
    expect(h.log.byEvent('uncaught')).toEqual([])
  })

  it('[ADR-020, S5.14] an advisor call that rejects fails the launch jev-unreachable with reason unreachable', async () => {
    const rejecting = { suggest: () => Promise.reject(new Error('socket hang up')) }
    const h = host(rejecting as unknown as AbortableLaunchAdvisor)

    expect(await h.launch()).toEqual([
      { state: 'failed', failure_cause: 'jev-unreachable', jev_reason: 'unreachable' }
    ])
  })
})
