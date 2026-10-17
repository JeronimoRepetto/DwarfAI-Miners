// The LaunchRecordStore conformance suite (16 §4.5 `runLaunchRecordStoreContract`; 17 §1.3): run on
// the in-memory double and on the SQLite adapter. One record per owned session keyed by its launch;
// `live` = no `endedAt`; `markStoppedByPerson` is idempotent and touches only the dwarf's live
// record (PO #62); an ended record never keeps a resume intent (ADR-015 item 8); a record's process
// is recorded first (16 §2.2) and read back only while its `ProcessRecord` lives; every write runs
// inside the caller's transaction (16 §2.2).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId
} from '../../../kernel/domain/values'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'

export interface LaunchRecordStoreSubject {
  store: LaunchRecordStore
  /** The process store of the same subject: a record's process is recorded there first. */
  processes: ProcessRecordStore
  /**
   * Makes a record's references exist (the SQLite half seeds the dwarf and its launch, with
   * `launched_with_let_jev_choose` as given).
   */
  owned(dwarfId: DwarfId, launchId: LaunchId, launchedWithLetJevChoose: boolean): void
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const EPOCH: HostEpoch = 'epoch-0161'
const T0: Instant = 1_790_000_000_000

let sequence = 0
const next = (): number => ++sequence
const dwarfIdOf = (n: number) =>
  `00000000-0000-7000-8d00-${n.toString(16).padStart(12, '0')}` as DwarfId
const launchIdOf = (n: number) =>
  `00000000-0000-7000-8a00-${n.toString(16).padStart(12, '0')}` as LaunchId

/** A record with its references made to exist in the subject. */
function ownedRecord(s: LaunchRecordStoreSubject, extra: Partial<LaunchRecord> = {}): LaunchRecord {
  const n = next()
  const r: LaunchRecord = {
    dwarfId: dwarfIdOf(n),
    launchId: launchIdOf(n),
    ref: { providerId: 'claude', providerSessionId: `session-${n}` },
    driverTransport: 'stream-json',
    cwd: '/work/mine-one' as FolderPath,
    launchOptions: {
      providerId: 'claude',
      model: 'model-x',
      effort: 'high',
      permissionMode: 'ask'
    },
    launchedWithLetJevChoose: false,
    resumeIntent: true,
    stoppedByPerson: false,
    hostEpoch: EPOCH,
    ...extra
  }
  s.owned(r.dwarfId, r.launchId, r.launchedWithLetJevChoose)
  return r
}

export function runLaunchRecordStoreContract(
  makeSubject: () => LaunchRecordStoreSubject | Promise<LaunchRecordStoreSubject>
): void {
  describe('LaunchRecordStore', () => {
    let subject: LaunchRecordStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const putIn = (s: LaunchRecordStoreSubject, r: LaunchRecord) =>
      s.inTransaction(() => s.store.put(r))

    it('[ADR-015] live returns exactly the records without endedAt', async () => {
      const s = await setUp()
      const running = ownedRecord(s)
      const ended = ownedRecord(s, { endedAt: T0 + 5, resumeIntent: false })
      const another = ownedRecord(s, { launchedWithLetJevChoose: true })
      for (const r of [running, ended, another]) putIn(s, r)

      expect(s.store.live()).toEqual([running, another])
      expect(s.store.all()).toEqual([running, ended, another])
    })

    it("[ADR-015] markStoppedByPerson sets stopped_by_person on the dwarf's live record and is idempotent", async () => {
      const s = await setUp()
      const target = ownedRecord(s)
      const other = ownedRecord(s)
      const ended = ownedRecord(s, { endedAt: T0 + 5, resumeIntent: false })
      for (const r of [target, other, ended]) putIn(s, r)

      s.inTransaction(() => s.store.markStoppedByPerson(target.dwarfId))
      s.inTransaction(() => s.store.markStoppedByPerson(target.dwarfId))
      s.inTransaction(() => s.store.markStoppedByPerson(ended.dwarfId))
      s.inTransaction(() => s.store.markStoppedByPerson(dwarfIdOf(next())))

      expect(s.store.all()).toEqual([{ ...target, stoppedByPerson: true }, other, ended])
    })

    it('[ADR-015] an ended record has resume_intent false', async () => {
      const s = await setUp()
      const r = ownedRecord(s)
      putIn(s, r)

      putIn(s, { ...r, endedAt: T0 + 9 })

      expect(s.store.all()).toEqual([{ ...r, endedAt: T0 + 9, resumeIntent: false }])
      expect(s.store.live()).toEqual([])
    })

    it('[ADR-015] a record reads back with every field, and a second put of the same launch updates it', async () => {
      const s = await setUp()
      const r = ownedRecord(s, {
        ref: {
          providerId: 'opencode',
          providerSessionId: 'ses-1',
          serverUrl: 'http://127.0.0.1:4096'
        },
        driverTransport: 'http-server',
        launchOptions: { providerId: 'opencode' },
        launchedWithLetJevChoose: true
      })
      putIn(s, r)
      expect(s.store.all()).toEqual([r])

      const rebound: LaunchRecord = {
        ...r,
        ref: { ...r.ref, providerSessionId: 'ses-2', previousProviderSessionId: 'ses-1' },
        hostEpoch: 'epoch-after-restart'
      }
      putIn(s, rebound)

      expect(s.store.all()).toEqual([rebound])
    })

    it("[ADR-015] a second launch's record for the same dwarf is refused", async () => {
      const s = await setUp()
      const first = ownedRecord(s)
      putIn(s, first)
      const n = next()
      s.owned(first.dwarfId, launchIdOf(n), false)

      expect(() => putIn(s, { ...first, launchId: launchIdOf(n) })).toThrow()

      expect(s.store.all()).toEqual([first])
    })

    it('[ADR-015, INV-51] a record naming an unrecorded process is refused, and an ended process reads back as none', async () => {
      const s = await setUp()
      const identity = { pid: 5100, processStartTimeMs: T0 - 3_000, bootId: 'boot-0161' }
      const r = ownedRecord(s, { process: identity })

      expect(() => putIn(s, r)).toThrow(HostInvariantError)
      expect(s.store.all()).toEqual([])

      s.inTransaction(() =>
        s.processes.put({ identity, purpose: 'session', launchId: r.launchId, hostEpoch: EPOCH })
      )
      putIn(s, r)
      expect(s.store.all()).toEqual([r])

      s.inTransaction(() => s.processes.ended(identity.pid, T0 + 60_000))
      const { process, ...withoutProcess } = r
      void process
      expect(s.store.all()).toEqual([withoutProcess])
    })

    it("[ADR-015] remove deletes the launch's record", async () => {
      const s = await setUp()
      const kept = ownedRecord(s)
      const removed = ownedRecord(s)
      putIn(s, kept)
      putIn(s, removed)

      s.inTransaction(() => s.store.remove(removed.launchId))
      s.inTransaction(() => s.store.remove(removed.launchId))

      expect(s.store.all()).toEqual([kept])
    })

    it('[ADR-015] a write outside a transaction is refused and a rolled-back put leaves nothing', async () => {
      const s = await setUp()
      const r = ownedRecord(s)

      expect(() => s.store.put(r)).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.store.put(r)
          throw new CallerFailure('the caller failed after storing')
        })
      ).toThrow(CallerFailure)
      expect(s.store.all()).toEqual([])

      putIn(s, r)
      expect(() => s.store.markStoppedByPerson(r.dwarfId)).toThrow(HostInvariantError)
      expect(() => s.store.remove(r.launchId)).toThrow(HostInvariantError)
      expect(s.store.all()).toEqual([r])
    })
  })
}
