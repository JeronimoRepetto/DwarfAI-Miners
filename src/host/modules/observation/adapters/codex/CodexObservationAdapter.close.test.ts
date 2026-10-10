// L4 (17 §1.4): how an observed Codex session ends and comes back (owner amendment I, 2026-10-07;
// 13 FM-059 as amended): no Codex record says a session ended, so it closes once its rollout is
// quiet for 300 s and two process listings 30 s apart show no Codex process in its folder, or once
// the person archives it; a closed thread resumed under its own id is a new dwarf (owner decision B,
// as 07 S4.41). Synthetic rollouts in a per-test temp `CODEX_HOME` (17 §5.3), the kernel's
// FakeProcessControl for the listing, a FakeClock: no real Codex, no real process.
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, FolderPath, ProviderIdentity } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import { openReadOnlySnapshot } from '../../../../platform/sqlite/readOnlySnapshot'
import type { ObservationEvent, SessionObserved } from '../../application/events'
import { OBSERVATION_POLL_MS, ObservationLoop } from '../../application/observationLoop'
import type { EndedAgentLedger } from '../../ports/endedAgentLedger'
import { InMemoryCursorStore } from '../../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, ObservedEvent, SourceFile } from '../../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../../testing/inMemoryTransactions'
import { resumedSessionIdOf } from '../base/generations'
import {
  PROCESS_GONE_CONFIRM_MS,
  PROCESS_GONE_QUIET_MS,
  ProcessGoneWatch,
  SharedProcessListing
} from '../base/processGone'
import { CODEX_PROCESS_STEMS, CodexObservationAdapter } from './CodexObservationAdapter'

const THREAD = '01a0b000-0000-7000-8000-0000000009a1'
const CWD = 'C:\\Users\\j\\Desktop\\Sample-Project'
const T0 = Date.parse('2026-09-30T13:00:00.000Z')
const S = 1_000

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** One rollout record at `at` (ms). */
function record(at: number, type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload })}\n`
}

const meta = (at: number) =>
  record(at, 'session_meta', {
    id: THREAD,
    timestamp: new Date(at).toISOString(),
    cwd: CWD,
    cli_version: '0.153.4',
    source: 'cli'
  })
const person = (at: number, n: number) =>
  record(at, 'event_msg', { type: 'user_message', message: `Question ${n}?` })
const dwarf = (at: number, n: number) =>
  record(at, 'response_item', {
    type: 'message',
    id: `msg_${n}`,
    role: 'assistant',
    content: [{ type: 'output_text', text: `Answer ${n}.` }]
  })

/** A `CODEX_HOME` with one rollout holding `lines`, and optionally a thread registry. */
async function codexHome(
  lines: string,
  threads: Array<{ id: string; archived: 0 | 1 }> = []
): Promise<{ home: string; rollout: string }> {
  const home = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-codex-close-')))
  temps.push(home)
  const folder = join(home, 'sessions', '2026', '09', '30')
  await mkdir(folder, { recursive: true })
  const rollout = join(folder, `rollout-2026-09-30T13-00-00-${THREAD}.jsonl`)
  await writeFile(rollout, lines)
  if (threads.length > 0) {
    const db = NodeSqliteDatabase.open(join(home, 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, source TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_at_ms INTEGER)'
    )
    for (const thread of threads) {
      db.exec(
        `INSERT INTO threads (id, cwd, source, archived, created_at, created_at_ms) VALUES ('${thread.id}', '${CWD.replace(/'/g, "''")}', 'cli', ${thread.archived}, ${T0 / 1000}, ${T0})`
      )
    }
    db.close()
  }
  return { home, rollout }
}

function codexWorld(home: string, options: { ended?: Pick<EndedAgentLedger, 'has'> } = {}) {
  const clock = new FakeClock(T0 + 10 * S)
  const processes = new FakeProcessControl()
  const listing = new SharedProcessListing({ processes, stems: CODEX_PROCESS_STEMS, clock })
  const adapter = new CodexObservationAdapter({
    providerId: 'codex',
    codexHome: home,
    claimedRoots: [],
    fs: new NodeFs(),
    clock,
    openSnapshot: openReadOnlySnapshot,
    processWatch: watchOver(listing, clock),
    ...(options.ended === undefined ? {} : { ended: options.ended })
  })
  const cursors = new Map<string, Cursor>()
  /** One read of every source from its cursor, the listing it asked for then finished. */
  const cycle = async (): Promise<ObservedEvent[]> => {
    const events: ObservedEvent[] = []
    for (const source of await adapter.discover(new NodeFs())) {
      const read = await adapter.read(source, cursors.get(source.streamId) ?? null)
      cursors.set(source.streamId, read.next)
      events.push(...read.events)
    }
    await listing.settled()
    return events
  }
  /** Cycles every 15 s up to `ms` after now; the `closed` facts they stated. */
  const runFor = async (ms: number): Promise<ObservedEvent[]> => {
    const closed: ObservedEvent[] = []
    const until = clock.now() + ms
    while (clock.now() < until) {
      clock.advance(Math.min(15 * S, until - clock.now()))
      closed.push(...(await cycle()).filter((e) => e.kind === 'closed'))
    }
    return closed
  }
  return { clock, processes, adapter, cycle, runFor }
}

const base = { providerId: 'codex', providerSessionId: THREAD }

/** The watch with Windows folder rules (the synthetic folders are Windows paths) on every host. */
function watchOver(listing: SharedProcessListing, clock: FakeClock): ProcessGoneWatch {
  return new ProcessGoneWatch({
    listing,
    stems: CODEX_PROCESS_STEMS,
    clock,
    platform: 'win32',
    resolveFolder: () => Promise.resolve(null)
  })
}

describe('CodexObservationAdapter closing (owner amendment I)', () => {
  it('[FM-059, US-OBS-005] a rollout first read long after its last record is quiet since that record: it closes within one confirmation of first sight', async () => {
    const HOURS_AGO = T0 - 2 * 3_600 * S
    const { home } = await codexHome(
      meta(HOURS_AGO) + person(HOURS_AGO + S, 1) + dwarf(HOURS_AGO + 2 * S, 1)
    )
    const { cycle, runFor } = codexWorld(home)
    expect((await cycle()).filter((e) => e.kind === 'closed')).toEqual([])

    const closed = await runFor(PROCESS_GONE_CONFIRM_MS + 30 * S)
    expect(closed.map((e) => e.sourceEventId)).toContain('process-gone')
  })

  it('[FM-059, S4.33, INV-26] a quiet Codex session closes once two listings 30 s apart show no Codex process in its folder, never before 300 s of quiet', async () => {
    const { home } = await codexHome(meta(T0) + person(T0 + S, 1) + dwarf(T0 + 2 * S, 1))
    const { cycle, runFor } = codexWorld(home)
    expect((await cycle()).filter((e) => e.kind === 'closed')).toEqual([])

    expect(await runFor(PROCESS_GONE_QUIET_MS - 15 * S)).toEqual([])
    const closed = await runFor(PROCESS_GONE_CONFIRM_MS + 30 * S)

    expect(closed.length).toBeGreaterThanOrEqual(1)
    expect(closed[0]).toMatchObject({
      kind: 'closed',
      sourceEventId: 'process-gone',
      identity: base,
      cwd: CWD
    })
  })

  it('[FM-059] a Codex process in the session folder keeps the session; one in another folder does not', async () => {
    const { home } = await codexHome(meta(T0) + person(T0 + S, 1))
    const kept = codexWorld(home)
    kept.processes.scriptProcess({ stem: 'codex', cwd: CWD.toLowerCase() + '\\' })
    kept.processes.scriptProcess({ stem: 'codex', cwd: 'C:\\Users\\j\\Other' })
    await kept.cycle()
    expect(await kept.runFor(PROCESS_GONE_QUIET_MS + 120 * S)).toEqual([])

    // The process in the session's folder ends: absence must hold on two reads 30 s apart.
    kept.processes.endListed(CWD.toLowerCase() + '\\')
    const closed = await kept.runFor(PROCESS_GONE_CONFIRM_MS + 30 * S)
    expect(closed.map((e) => e.sourceEventId)).toContain('process-gone')
  })

  it('[FM-059, INV-26] an unreadable process listing never closes a Codex session', async () => {
    const { home } = await codexHome(meta(T0) + person(T0 + S, 1))
    const { processes, cycle, runFor } = codexWorld(home)
    processes.scriptListing('unreadable')
    await cycle()

    expect(await runFor(PROCESS_GONE_QUIET_MS + 300 * S)).toEqual([])
  })

  it('[FM-059] rollout growth is activity: a session that keeps writing never closes, whatever the listing says', async () => {
    const { home, rollout } = await codexHome(meta(T0) + person(T0 + S, 1))
    const { cycle, runFor, clock } = codexWorld(home)
    await cycle()
    for (let n = 2; n < 12; n++) {
      expect(await runFor(240 * S)).toEqual([])
      await appendFile(rollout, dwarf(clock.now(), n))
    }
  })

  it('[FM-059] an archived Codex thread closes at once, from its rollout and from the registry alone', async () => {
    const other = '01a0b000-0000-7000-8000-0000000009b2'
    const { home } = await codexHome(meta(T0) + person(T0 + S, 1), [
      { id: THREAD, archived: 1 },
      { id: other, archived: 1 }
    ])
    const { cycle } = codexWorld(home)

    const closed = (await cycle()).filter((e) => e.kind === 'closed')

    expect(closed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceEventId: 'archived', identity: base }),
        expect.objectContaining({
          sourceEventId: 'archived',
          identity: { providerId: 'codex', providerSessionId: other }
        })
      ])
    )
    expect(closed.every((e) => e.kind === 'closed' && e.sourceEventId === 'archived')).toBe(true)
  })

  it('[S4.41, FM-145, INV-36, ADR-015] a closed Codex thread resumed under its own id arrives as a new dwarf, the closed identity gets nothing, and a Host restart derives the same identity', async () => {
    const first = T0
    const { home, rollout } = await codexHome(
      meta(first) + person(first + S, 1) + dwarf(first + 2 * S, 1)
    )
    const clock = new FakeClock(T0 + 10 * S)
    const scheduler = new FakeScheduler(clock)
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const cursors = new InMemoryCursorStore(transactions)
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    const ended = new InMemoryEndedAgentLedger(transactions)
    const sink = new RecordingObservedBatchSink(transactions)
    for (const p of [cursors, sessions, ended, sink]) transactions.enlist(p)
    const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
    const processes = new FakeProcessControl()
    const loopOver = () => {
      const listing = new SharedProcessListing({ processes, stems: CODEX_PROCESS_STEMS, clock })
      const adapter = new CodexObservationAdapter({
        providerId: 'codex',
        codexHome: home,
        claimedRoots: [],
        fs: new NodeFs(),
        clock,
        openSnapshot: openReadOnlySnapshot,
        processWatch: watchOver(listing, clock),
        ended
      })
      return {
        adapter,
        loop: new ObservationLoop({
          adapters: [adapter],
          fs: new NodeFs(),
          cursors,
          sessions,
          sink,
          transactions,
          bus,
          clock,
          scheduler,
          ids: new SequenceIdGenerator(),
          hostEpoch: 'epoch-amend-i',
          log: new RecordingDiagnosticsLog(),
          ended
        })
      }
    }
    let { loop } = loopOver()
    const poll = async () => {
      clock.advance(OBSERVATION_POLL_MS)
      await loop.whenIdle()
    }
    const observed = () =>
      bus.published
        .filter((e): e is SessionObserved => e.type === 'SessionObserved')
        .map((e) => e.payload.identity)
    const rows = () =>
      sink.applied.flatMap((b) => b.entries.map((e) => [b.dwarfId, e.sourceKey] as const))
    const rowsOf = (dwarfId: DwarfId) => rows().filter(([id]) => id === dwarfId)

    // The thread arrives and is written, then its process is gone: it closes and joins the ledger.
    loop.start()
    await loop.whenIdle()
    expect(observed()).toEqual([base])
    const firstDwarf = dwarfs.bind(base, CWD as FolderPath, T0)
    await poll()
    expect(rowsOf(firstDwarf)).toHaveLength(2)
    const quiet = PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS + 30 * S
    for (let t = 0; t <= quiet; t += OBSERVATION_POLL_MS) await poll()
    expect(ended.has(base)).toBe(true)
    expect(bus.ofType('SessionClosedObserved')).toHaveLength(1)

    // S4.40 / INV-36: a late write of the closed run (no quiet gap before it) stays the closed
    // thread's, which the ledger keeps from arriving or writing again.
    await appendFile(rollout, dwarf(first + 62 * S, 9))
    await poll()
    await poll()
    expect(observed()).toEqual([base])
    expect(rowsOf(firstDwarf)).toHaveLength(2)

    // `codex resume <id>` an hour later appends to the same rollout under the same thread id.
    const resumedAt = first + 3_600 * S
    const resumed: ProviderIdentity = {
      providerId: 'codex',
      providerSessionId: resumedSessionIdOf(THREAD, resumedAt)
    }
    await appendFile(rollout, person(resumedAt, 2) + dwarf(resumedAt + S, 2))
    await poll()
    expect(observed()).toEqual([base, resumed])
    const secondDwarf = dwarfs.bind(resumed, CWD as FolderPath, T0)
    expect(secondDwarf).not.toBe(firstDwarf)
    await poll()
    expect(rowsOf(secondDwarf).map(([, key]) => key)).toEqual([
      expect.stringMatching(/:\d+:[0-9a-f]{40}$/),
      expect.stringMatching(/:msg_2$/)
    ])
    // INV-36: the closed identity received nothing after its close.
    expect(rowsOf(firstDwarf)).toHaveLength(2)

    // A Host restart derives the same resumed identity: no new arrival, the next record is its.
    loop.stop()
    ;({ loop } = loopOver())
    loop.start()
    await loop.whenIdle()
    await appendFile(rollout, dwarf(resumedAt + 60 * S, 3))
    await poll()
    await poll()
    expect(observed()).toEqual([base, resumed])
    expect(
      rowsOf(secondDwarf)
        .map(([, key]) => key)
        .at(-1)
    ).toMatch(/:msg_3$/)
    expect(new Set(rows().map(([, key]) => key)).size).toBe(rows().length)
    loop.stop()

    // Replayed from the start after a restart, every record keeps its key and its generation.
    const fresh = loopOver().adapter
    const [source] = (await fresh.discover(new NodeFs())) as [SourceFile]
    const replay = await fresh.read(source, null)
    const replayed = replay.events.flatMap((e) =>
      e.kind === 'entries' ? e.entries.map(() => e.identity.providerSessionId) : []
    )
    expect(replayed).toEqual([
      THREAD,
      THREAD,
      THREAD,
      resumed.providerSessionId,
      resumed.providerSessionId,
      resumed.providerSessionId
    ])
  })
})
