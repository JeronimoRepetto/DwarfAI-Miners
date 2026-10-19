// L2 (17 §1.2): `MinesCommands.checkFolder` (16 §4.1; 05 §3.1 "Folder check", AMENDMENT-2
// SC-AR-04; 07 S3.12…S3.14; 06 INV-08) and its schedule, over a FakeFs, the kernel's fake clock and
// scheduler, the repository double (the same contract as the SQLite adapter) and the recording
// bus, which refuses a publish made inside a transaction (16 §2.3). The re-measurement of a mine
// found again is the real `MineMeasurement` over the scanner double, so its
// `MineMeasurementStarted` is the one the walk publishes. Synthetic POSIX folders (privacy-guard).
//
// TC-085-01, TC-085-02.
import { describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { toMineWire } from '../../../transport/mappers/wire'
import type { MinesEvent } from '../domain/events'
import { mineIdOf, mineNameOf, openMine, transition, type Mine } from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { DEFAULT_TIER_THRESHOLDS } from '../domain/tier'
import { FakeSourceWeightScanner } from '../ports/fakes/FakeSourceWeightScanner'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import { createCheckFolder } from './checkFolder'
import { FolderCheckSchedule, MINE_FOLDER_CHECK_MS } from './folderCheckSchedule'
import { MineMeasurement } from './measure'
import { MineReadModel } from './mineQueries'

const T0 = 1_790_000_000_000

const NO_TOTALS = {
  coal: { tokens: 0 },
  bronze: { tokens: 0 },
  copper: { tokens: 0 },
  silver: { tokens: 0 },
  gold: { tokens: 0 },
  uranium: { tokens: 0 }
}

function folderCheckWorld(fs: FakeFs = new FakeFs()) {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
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
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: scope })
  const ids = new SequenceIdGenerator()
  const scanner = new FakeSourceWeightScanner(fs)
  const measurement = new MineMeasurement({
    repository,
    transactions,
    scanner,
    scheduler,
    clock,
    bus,
    ids,
    hostEpoch: 'epoch-085',
    thresholds: DEFAULT_TIER_THRESHOLDS,
    automaticWalkDelayMs: 5_000
  })
  const remeasured: MineId[] = []
  const { checkFolder } = createCheckFolder({
    repository,
    transactions,
    fs,
    clock,
    ids,
    bus,
    hostEpoch: 'epoch-085',
    remeasure: (mineId) => {
      remeasured.push(mineId)
      measurement.remeasure(mineId)
    }
  })

  let count = 0
  /** A mine stored at `/work/<name>` in `state`, its folder holding one source file. */
  const mine = (state: 'unrecorded' | 'active' | 'unenterable', measured = true): Mine => {
    count += 1
    const name = `shaft-${count}`
    fs.addFile(`/work/${name}/main.ts`, 'export const ore = 1\n')
    const born = openMine(
      {
        cause: 'first-message',
        birth: {
          id: mineIdOf(ids.uuidv7()),
          path: canonicalMinePath(`/work/${name}`, { style: 'posix', caseFold: false }),
          name: mineNameOf(name)
        }
      },
      T0
    ).mine as Mine
    const stored: Mine =
      state === 'unrecorded'
        ? born
        : {
            ...born,
            state,
            tier: measured ? 'silver' : null,
            sourceWeight: measured ? { bytes: 4_096 } : null,
            hasBeenMeasured: measured,
            ...(measured ? { measuredAt: T0 } : {}),
            ...(state === 'unenterable' ? { unenterableReason: 'not-found' } : {})
          }
    transactions.inTransaction(() => repository.save(stored))
    return stored
  }
  const save = (stored: Mine) => transactions.inTransaction(() => repository.save(stored))
  const read = new MineReadModel({ repository, presentDwarfs: repository })
  return {
    fs,
    clock,
    scheduler,
    repository,
    bus,
    scanner,
    measurement,
    remeasured,
    checkFolder,
    mine,
    save,
    read
  }
}

describe('checkFolder (16 §4.1 MinesCommands.checkFolder)', () => {
  it('[US-RES-007.AC04, S3.12, INV-08] a missing folder makes an active mine unenterable with its reason and keeps tier and ore', async () => {
    const w = folderCheckWorld()
    const shaft = w.mine('active')
    w.fs.removeDir(shaft.path)

    expect(await w.checkFolder(shaft.id)).toEqual({ ok: true, value: 'unenterable' })

    // Never removed: the same row, its tier and weight kept (the ledger's ore is keyed by it).
    expect(w.repository.byId(shaft.id)).toEqual({
      ...shaft,
      state: 'unenterable',
      unenterableReason: 'not-found'
    })
    expect(w.bus.published.map((event) => [event.type, event.payload])).toEqual([
      ['MineBecameUnenterable', { mineId: shaft.id, reason: 'not-found' }]
    ])
    // An unenterable mine is not a launch target: nothing is walked into it.
    expect(w.remeasured).toEqual([])

    // An unrecorded mine goes the same way (S3.12), and an unknown or removed one is refused.
    const fresh = w.mine('unrecorded')
    w.fs.removeDir(fresh.path)
    expect(await w.checkFolder(fresh.id)).toEqual({ ok: true, value: 'unenterable' })
    expect(w.repository.byId(fresh.id)?.state).toBe('unenterable')
    const gone = w.mine('active')
    const asked = transition(gone, { type: 'removal-requested' }, T0).mine as Mine
    w.save(transition(asked, { type: 'removal-settled', everyDwarfEnded: true }, T0).mine as Mine)
    w.fs.removeDir(gone.path)
    const published = w.bus.published.length
    expect(await w.checkFolder(gone.id)).toEqual({ ok: false, error: 'unknown-mine' })
    expect(await w.checkFolder(mineIdOf('00000000-0000-7000-8000-0000000000ff'))).toEqual({
      ok: false,
      error: 'unknown-mine'
    })
    expect(w.repository.byId(gone.id)?.state).toBe('removed')
    expect(w.bus.published).toHaveLength(published)
  })

  it("[US-MAP-003.AC03] an unenterable mine's MineWire carries state unenterable and the reason code", async () => {
    const w = folderCheckWorld()
    const shaft = w.mine('active')
    w.fs.scriptFault(shaft.path, 'EACCES')

    await w.checkFolder(shaft.id)

    const view = w.read.get(shaft.id)
    expect(view).not.toBeNull()
    const wire = toMineWire(view!, NO_TOTALS)
    expect(wire).toMatchObject({
      id: shaft.id,
      state: 'unenterable',
      unenterableReason: 'access-denied',
      tier: 'silver'
    })
  })

  it('[S3.13, S3.14] the folder found again makes the mine active when measured before, else measuring with a walk queued', async () => {
    const w = folderCheckWorld()
    const measured = w.mine('unenterable', true)
    const never = w.mine('unenterable', false)
    const release = w.scanner.hold()

    expect(await w.checkFolder(measured.id)).toEqual({ ok: true, value: 'enterable' })
    expect(await w.checkFolder(never.id)).toEqual({ ok: true, value: 'enterable' })

    // S3.13: back to active with its last tier, then the queued re-measurement (S3.10) walks it.
    // S3.14: never measured, so measuring, and its walk starts.
    expect(w.remeasured).toEqual([measured.id, never.id])
    const types = w.bus.published.map((event) => [event.type, event.payload.mineId])
    expect(types).toEqual([
      ['MineBecameEnterable', measured.id],
      ['MineMeasurementStarted', measured.id],
      ['MineBecameEnterable', never.id],
      ['MineMeasurementStarted', never.id]
    ])
    expect(w.repository.byId(never.id)).toMatchObject({ state: 'measuring', tier: null })
    expect(w.repository.byId(never.id)).not.toHaveProperty('unenterableReason')
    expect(w.repository.byId(measured.id)).toMatchObject({ state: 'measuring', tier: 'silver' })

    release()
    await w.measurement.idle()
    expect(w.repository.byId(measured.id)).toMatchObject({ state: 'active' })
    expect(w.repository.byId(never.id)).toMatchObject({ state: 'active', hasBeenMeasured: true })
  })

  it('[S3.12] a second check with no change publishes nothing', async () => {
    const w = folderCheckWorld()
    const shaft = w.mine('active')
    const present = w.mine('active')
    w.fs.removeDir(shaft.path)

    await w.checkFolder(shaft.id)
    await w.checkFolder(present.id)
    const after = w.bus.published.length

    expect(await w.checkFolder(shaft.id)).toEqual({ ok: true, value: 'unenterable' })
    expect(await w.checkFolder(present.id)).toEqual({ ok: true, value: 'enterable' })
    expect(w.bus.published).toHaveLength(after)
    expect(after).toBe(1)
  })

  it('[S3.12] mines with a present dwarf are checked every 30 000 ms of the fake clock', async () => {
    const w = folderCheckWorld()
    const busy = w.mine('active')
    const idle = w.mine('active')
    const present = new Set<MineId>([busy.id])
    const checked: MineId[] = []
    const schedule = new FolderCheckSchedule({
      scheduler: w.scheduler,
      intervalMs: MINE_FOLDER_CHECK_MS,
      minesWithPresentDwarfs: () => [...present],
      checkFolder: (mineId) => {
        checked.push(mineId)
        return w.checkFolder(mineId)
      }
    })
    expect(MINE_FOLDER_CHECK_MS).toBe(30_000)
    w.fs.removeDir(busy.path)
    w.fs.removeDir(idle.path)

    schedule.start()
    w.clock.advance(MINE_FOLDER_CHECK_MS - 1)
    expect(checked).toEqual([])
    w.clock.advance(1)
    await schedule.idle()
    expect(checked).toEqual([busy.id])
    expect(w.repository.byId(busy.id)?.state).toBe('unenterable')
    // A mine with no present dwarf is not polled: it is checked on resolution or an error route.
    expect(w.repository.byId(idle.id)?.state).toBe('active')

    w.clock.advance(MINE_FOLDER_CHECK_MS)
    await schedule.idle()
    expect(checked).toEqual([busy.id, busy.id])

    schedule.stop()
    w.clock.advance(MINE_FOLDER_CHECK_MS * 3)
    await schedule.idle()
    expect(checked).toEqual([busy.id, busy.id])
  })

  it('[S3.12, S3.13] checks of one mine never run at once: a check asked while one runs waits for it and later ones share its run', async () => {
    const fs = new FakeFs()
    const w = folderCheckWorld(fs)
    const shaft = w.mine('active')
    let reading = 0
    let most = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    fs.onBeforeRead = async () => {
      reading += 1
      most = Math.max(most, reading)
      await gate
      reading -= 1
    }
    w.fs.removeDir(shaft.path)

    const first = w.checkFolder(shaft.id)
    const second = w.checkFolder(shaft.id)
    const third = w.checkFolder(shaft.id)
    release()

    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true, value: 'unenterable' },
      { ok: true, value: 'unenterable' },
      { ok: true, value: 'unenterable' }
    ])
    expect(most).toBe(1)
    expect(w.bus.ofType('MineBecameUnenterable')).toHaveLength(1)
  })
})
