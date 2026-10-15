// layer: L3
// The Host's maintenance tick (09 §7.1: "All sweeps run in the Host's maintenance tick (at boot after `ready`, then
// every 6 hours)"; #1290) and the sweeps host/main.ts hands it: the closed-asks sweep (askSweep.ts; 09 §7.1 row
// `asks`, `ask_answers`; ADR-010, PO #91) over a template-database copy, and none over a newer file, which the Host
// opens read-only and never writes (ADR-005 item 5). FakeClock and FakeScheduler: no real timer.
import { describe, expect, it } from 'vitest'
import type { AskId } from '../kernel/domain/values'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { CLOSED_ASK_RETENTION_MS } from '../modules/asking/adapters/askSweep'
import { permissionAsk } from '../modules/asking/testing/askRepository.contract'
import { ASK_T0, seededAskDb } from '../modules/asking/testing/sqliteAskDb'
import {
  hostMaintenanceSweeps,
  MAINTENANCE_EVERY_MS,
  startMaintenanceTick
} from './hostMaintenance'

function tickWorld() {
  const clock = new FakeClock(ASK_T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const runs: string[] = []
  return { clock, scheduler, log, runs }
}

describe('the Host maintenance tick (#1290)', () => {
  it('[ADR-010] runs every sweep once when started after ready, then again every 6 hours', () => {
    const { clock, scheduler, log, runs } = tickWorld()
    startMaintenanceTick({
      scheduler,
      log,
      sweeps: [
        { subsystem: 'asking', run: () => (runs.push('asking'), 0) },
        { subsystem: 'attention', run: () => (runs.push('attention'), 0) }
      ]
    })

    expect(runs).toEqual(['asking', 'attention'])

    clock.advance(MAINTENANCE_EVERY_MS - 1)
    expect(runs).toHaveLength(2)

    clock.advance(1)
    expect(runs).toEqual(['asking', 'attention', 'asking', 'attention'])
    expect(MAINTENANCE_EVERY_MS).toBe(6 * 60 * 60 * 1000)
  })

  it('[ADR-010] a sweep that throws is logged failed, and the other sweeps and the next tick still run', () => {
    const { clock, scheduler, log, runs } = tickWorld()
    startMaintenanceTick({
      scheduler,
      log,
      sweeps: [
        {
          subsystem: 'asking',
          run: () => {
            runs.push('asking')
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
          }
        },
        { subsystem: 'attention', run: () => (runs.push('attention'), 3) }
      ]
    })
    clock.advance(MAINTENANCE_EVERY_MS)

    expect(runs).toEqual(['asking', 'attention', 'asking', 'attention'])
    expect(scheduler.taskErrors).toEqual([])
    expect(log.byEvent('maintenance.sweep')).toEqual([
      expect.objectContaining({
        level: 'error',
        subsystem: 'asking',
        outcome: 'failed',
        errCode: 'SQLITE_BUSY'
      }),
      expect.objectContaining({ level: 'info', subsystem: 'attention', outcome: 'ok', count: 3 }),
      expect.objectContaining({ level: 'error', subsystem: 'asking', outcome: 'failed' }),
      expect.objectContaining({ level: 'info', subsystem: 'attention', outcome: 'ok', count: 3 })
    ])
  })

  it('[ADR-010] once stopped nothing runs again and no task is left', () => {
    const { clock, scheduler, log, runs } = tickWorld()
    const tick = startMaintenanceTick({
      scheduler,
      log,
      sweeps: [{ subsystem: 'asking', run: () => (runs.push('asking'), 0) }]
    })

    tick.stop()
    clock.advance(MAINTENANCE_EVERY_MS)

    expect(runs).toEqual(['asking'])
    expect(scheduler.nextDueAt()).toBeNull()
  })

  it('[ADR-010] the Host sweeps delete an ask closed more than 7 days ago and keep a live one', () => {
    const { db, runner, clock, open, dwarfs } = seededAskDb()
    const asks = open()
    const closed = permissionAsk(1, dwarfs[0])
    const live = permissionAsk(2, dwarfs[1])
    runner.inTransaction(() => {
      asks.save(closed)
      asks.save(live)
    })
    runner.inTransaction(() => asks.save({ ...closed, state: 'cancelled', closedAt: clock.now() }))
    clock.advance(CLOSED_ASK_RETENTION_MS + 1)

    const sweeps = hostMaintenanceSweeps({ db, transactions: runner, clock, readOnly: false })
    for (const sweep of sweeps) sweep.run()

    expect(sweeps.map((sweep) => sweep.subsystem)).toEqual(['asking'])
    expect(asks.byId(closed.id as AskId)).toBeNull()
    expect(asks.byId(live.id as AskId)?.state).toBe('open')
  })

  it('[ADR-005] a database opened read-only is never swept', () => {
    const { db, runner, clock } = seededAskDb()

    expect(hostMaintenanceSweeps({ db, transactions: runner, clock, readOnly: true })).toEqual([])
  })
})
