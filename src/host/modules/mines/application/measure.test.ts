// L2 (17 §1.2): the scoring walk of a mine (07 S3.04, S3.08–S3.11, S3.15, S3.25) over the
// scanner double walking a FakeFs, the kernel's fake clock and scheduler, the repository double
// (which runs the same contract as the SQLite adapter) and the recording bus, which refuses a
// publish made inside a transaction (16 §2.3).
import { describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { mineIdOf, mineNameOf, openMine, type MineOpening } from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { DEFAULT_TIER_THRESHOLDS } from '../domain/tier'
import { FakeSourceWeightScanner } from '../ports/fakes/FakeSourceWeightScanner'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import type { MeasurementEvent } from '../domain/events'
import { MineMeasurement } from './measure'

const T0 = 1_790_000_000_000
const DELAY_MS = 5_000
const KB = 1024

function world() {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const fs = new FakeFs()
  const scanner = new FakeSourceWeightScanner(fs)
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryMineRepository({ scope, mapSites: [], random: () => 0 })
  const bus = new RecordingEventBus<MeasurementEvent>({ transactionScope: scope })
  const ids = new SequenceIdGenerator()
  const deps = {
    repository,
    transactions,
    scanner,
    scheduler,
    clock,
    bus,
    ids,
    hostEpoch: 'epoch-065',
    thresholds: DEFAULT_TIER_THRESHOLDS,
    automaticWalkDelayMs: DELAY_MS
  }
  const measurement = new MineMeasurement(deps)

  let mines = 0
  /** A mine born as `cause` says, stored, at `/work/<name>`; its folder holds what `write` adds. */
  const create = (cause: Exclude<MineOpening, { cause: 'refused' }>['cause']): MineId => {
    mines += 1
    const name = `ore-${mines}`
    const mine = openMine(
      {
        cause,
        birth: {
          id: mineIdOf(ids.uuidv7()),
          path: canonicalMinePath(`/work/${name}`, { style: 'posix', caseFold: false }),
          name: mineNameOf(name)
        }
      },
      clock.now()
    ).mine
    if (mine === null) throw new Error('fixture opening refused')
    transactions.inTransaction(() => repository.save(mine))
    return mine.id
  }
  /** A source-ish file of exactly `kb` KB, with content of its own, in the mine's folder. */
  const write = (mineId: MineId, relative: string, kb: number): void => {
    const folder = repository.byId(mineId)?.path ?? ''
    fs.addFile(`${folder}/${relative}`, `${relative}\n`.padEnd(kb * KB, 'x'))
  }
  const types = (): string[] => bus.published.map((event) => event.type)
  return { clock, fs, scanner, repository, bus, measurement, deps, create, write, types }
}

describe('MineMeasurement (16 §4.1 MinesCommands.remeasure)', () => {
  it('[US-OBS-001.AC03, S3.01] a mine created from an observed session starts unrecorded with no tier', () => {
    const { repository, measurement, scanner, create, types } = world()
    const mineId = create('first-message')

    measurement.mineCreated(mineId)

    expect(repository.byId(mineId)).toMatchObject({
      state: 'unrecorded',
      tier: null,
      sourceWeight: null,
      hasBeenMeasured: false
    })
    expect(types()).toEqual([])
    expect(scanner.calls).toHaveLength(0)
  })

  it('[US-OBS-001.AC05, S3.08] shortly after creation the automatic walk starts measuring and publishes MineMeasurementStarted', () => {
    const { clock, repository, measurement, scanner, bus, create, write, types } = world()
    const mineId = create('first-message')
    write(mineId, 'src/a.ts', 1)
    scanner.hold()

    measurement.mineCreated(mineId)
    clock.advance(DELAY_MS - 1)
    expect(repository.byId(mineId)?.state).toBe('unrecorded')
    expect(types()).toEqual([])

    clock.advance(1)
    expect(repository.byId(mineId)?.state).toBe('measuring')
    expect(bus.ofType('MineMeasurementStarted').map((event) => event.payload)).toEqual([
      { mineId, startedAt: T0 + DELAY_MS }
    ])
    expect(scanner.calls.map((call) => call.path)).toEqual([repository.byId(mineId)?.path])
  })

  it('[S3.04] the walk of a declared mine publishes MineMeasurementStarted when it starts', () => {
    const { clock, measurement, scanner, bus, create, write } = world()
    const mineId = create('declared')
    write(mineId, 'src/a.ts', 1)
    scanner.hold()

    measurement.mineCreated(mineId)
    clock.advance(DELAY_MS)

    expect(bus.ofType('MineMeasurementStarted').map((event) => event.payload)).toEqual([
      { mineId, startedAt: T0 + DELAY_MS }
    ])
  })

  it('[US-MINES-008.AC04] a mine that was never measured has tier null while measuring', () => {
    const { clock, repository, measurement, scanner, create, write } = world()
    const declared = create('declared')
    const observed = create('first-message')
    write(declared, 'src/a.ts', 1)
    write(observed, 'src/a.ts', 1)
    scanner.hold()

    measurement.mineCreated(declared)
    measurement.mineCreated(observed)
    clock.advance(DELAY_MS)

    expect(scanner.calls).toHaveLength(2)
    for (const mineId of [declared, observed]) {
      expect(repository.byId(mineId)).toMatchObject({
        state: 'measuring',
        tier: null,
        sourceWeight: null,
        hasBeenMeasured: false
      })
    }
  })

  it('[S3.09, INV-05] a finished walk stores the weight, sets the tier from it and makes the mine active', async () => {
    const { clock, repository, measurement, bus, create, write, types } = world()
    const mineId = create('first-message')
    write(mineId, 'src/a.ts', 200)
    write(mineId, 'src/b.ts', 200)
    // Not source-ish: weighs nothing, however large.
    write(mineId, 'README.md', 5_000)

    measurement.mineCreated(mineId)
    clock.advance(DELAY_MS)
    await measurement.idle()

    // 400 KB: Copper from 350 KB (06 §4.1).
    expect(repository.byId(mineId)).toMatchObject({
      state: 'active',
      tier: 'copper',
      sourceWeight: { bytes: 400 * KB },
      hasBeenMeasured: true,
      measuredAt: T0 + DELAY_MS
    })
    expect(types()).toEqual(['MineMeasurementStarted', 'MineMeasured'])
    expect(bus.ofType('MineMeasured')[0]?.payload).toEqual({
      mineId,
      tier: 'copper',
      sourceWeight: { bytes: 400 * KB },
      measuredAt: T0 + DELAY_MS
    })
  })

  it('[S3.10] a re-measurement keeps the last tier until it finishes', async () => {
    const { clock, repository, measurement, scanner, bus, create, write } = world()
    const mineId = create('first-message')
    write(mineId, 'src/a.ts', 200)
    write(mineId, 'src/b.ts', 200)
    measurement.mineCreated(mineId)
    clock.advance(DELAY_MS)
    await measurement.idle()
    for (const name of ['c', 'd', 'e', 'f', 'g', 'h']) write(mineId, `src/${name}.ts`, 200)
    const release = scanner.hold()
    clock.advance(60_000)

    measurement.remeasure(mineId)

    expect(repository.byId(mineId)).toMatchObject({
      state: 'measuring',
      tier: 'copper',
      sourceWeight: { bytes: 400 * KB },
      hasBeenMeasured: true
    })
    expect(bus.ofType('MineMeasurementStarted').map((event) => event.payload.startedAt)).toEqual([
      T0 + DELAY_MS,
      T0 + DELAY_MS + 60_000
    ])

    release()
    await measurement.idle()
    // 1 600 KB: Silver from 1 500 KB.
    expect(repository.byId(mineId)).toMatchObject({
      state: 'active',
      tier: 'silver',
      sourceWeight: { bytes: 1_600 * KB }
    })
  })

  it('[S3.11] a walk that finds the folder unreadable makes the mine unenterable and discards the result', async () => {
    const { clock, fs, repository, measurement, bus, create, write, types } = world()
    const mineId = create('first-message')
    write(mineId, 'src/a.ts', 200)
    fs.scriptFault(repository.byId(mineId)?.path ?? '', 'EACCES')

    measurement.mineCreated(mineId)
    clock.advance(DELAY_MS)
    await measurement.idle()

    expect(repository.byId(mineId)).toMatchObject({
      state: 'unenterable',
      unenterableReason: 'access-denied',
      tier: null,
      sourceWeight: null,
      hasBeenMeasured: false
    })
    expect(types()).toEqual(['MineMeasurementStarted', 'MineBecameUnenterable'])
    expect(bus.ofType('MineBecameUnenterable')[0]?.payload).toEqual({
      mineId,
      reason: 'access-denied'
    })
  })

  it('[S3.15] removing the mine aborts a running walk', async () => {
    const { clock, repository, measurement, scanner, create, write, types } = world()
    const walking = create('first-message')
    const waiting = create('first-message')
    write(walking, 'src/a.ts', 200)
    const release = scanner.hold()
    measurement.mineCreated(walking)
    clock.advance(DELAY_MS)
    measurement.mineCreated(waiting)
    expect(scanner.calls).toHaveLength(1)
    expect(scanner.calls[0]?.signal.aborted).toBe(false)

    measurement.abort(walking)
    measurement.abort(waiting)
    release()
    clock.advance(DELAY_MS)
    await measurement.idle()

    // The running walk was aborted and its result discarded; the pending one never started.
    expect(scanner.calls[0]?.signal.aborted).toBe(true)
    expect(scanner.calls).toHaveLength(1)
    expect(types()).toEqual(['MineMeasurementStarted'])
    // The removal itself is committed by its own use case (S3.16), never by the walk.
    expect(repository.byId(walking)).toMatchObject({ state: 'measuring', tier: null })
    expect(repository.byId(waiting)?.state).toBe('unrecorded')
  })

  it('[S3.15] a Reset aborts every running walk', async () => {
    const { clock, measurement, scanner, create, write, types } = world()
    const first = create('declared')
    const second = create('first-message')
    write(first, 'src/a.ts', 200)
    write(second, 'src/a.ts', 200)
    const release = scanner.hold()
    measurement.mineCreated(first)
    measurement.mineCreated(second)
    clock.advance(DELAY_MS)
    expect(scanner.calls).toHaveLength(2)

    measurement.abortAll()
    release()
    await measurement.idle()

    expect(scanner.calls.map((call) => call.signal.aborted)).toEqual([true, true])
    // Both walks started (S3.04, S3.08); neither answered.
    expect(types()).toEqual(['MineMeasurementStarted', 'MineMeasurementStarted'])
  })

  it('[S3.25] a walk left unfinished by a Host restart starts again from scratch at boot', async () => {
    const { clock, repository, scanner, deps, create, write, types } = world()
    // The previous boot stored a measuring mine and an unrecorded one, and died mid-walk.
    const measuring = create('declared')
    const unrecorded = create('first-message')
    write(measuring, 'src/a.ts', 200)
    write(unrecorded, 'src/a.ts', 400)
    const rebooted = new MineMeasurement(deps)

    rebooted.resumeAtBoot()
    await rebooted.idle()

    expect(scanner.calls.map((call) => call.path)).toEqual([repository.byId(measuring)?.path])
    expect(repository.byId(measuring)).toMatchObject({ state: 'active', tier: 'bronze' })
    expect(repository.byId(unrecorded)?.state).toBe('unrecorded')

    // An unrecorded mine gets its automatic walk, as at creation.
    clock.advance(DELAY_MS)
    await rebooted.idle()
    expect(repository.byId(unrecorded)).toMatchObject({ state: 'active', tier: 'copper' })
    expect(types()).toEqual(['MineMeasured', 'MineMeasurementStarted', 'MineMeasured'])
  })
})
