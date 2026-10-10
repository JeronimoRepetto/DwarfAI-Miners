// L4 (17 §1.4): how an observed OpenCode session ends and comes back (owner amendment I,
// 2026-10-07; 13 FM-059 as amended): no OpenCode row says a session ended, so it closes once it is
// quiet for 300 s (no row or `time_updated` movement) and two process listings 30 s apart show no
// OpenCode process in its folder, or once the person archives it (`session.time_archived`); a
// closed session resumed under its own id (`opencode --session`) is a new dwarf (owner decision B,
// as 07 S4.41). A per-test `opencode.db` built from the fixture schema (17 §5.3), the kernel's
// FakeProcessControl for the listing, a FakeClock: no real OpenCode, no real process.
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { OPENCODE_PROCESS_STEMS, OpenCodeObservationAdapter } from './OpenCodeObservationAdapter'

const SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/opencode/observer/1.18.x/schema.sql'
)
const SESSION = 'ses_close_0001'
const DIRECTORY = '/home/j/work/sample-project'
const T0 = 1_790_820_000_000
const S = 1_000

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Runs `sql` on the store, as OpenCode would commit it. */
function commit(root: string, sql: string): void {
  const db = NodeSqliteDatabase.open(join(root, 'opencode.db'))
  db.exec(sql)
  db.close()
}

const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`

/** One person message (a text part) and one finished dwarf reply, created at `at`. */
function turn(at: number, n: number, session = SESSION): string {
  const user = JSON.stringify({ role: 'user', time: { created: at } })
  const reply = JSON.stringify({
    role: 'assistant',
    time: { created: at + S, completed: at + 2 * S },
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop'
  })
  return [
    `INSERT INTO message VALUES ('msg_${n}a', '${session}', ${at}, ${at}, ${quoted(user)});`,
    `INSERT INTO part VALUES ('prt_${n}a', 'msg_${n}a', '${session}', ${at}, ${at}, ${quoted(JSON.stringify({ type: 'text', text: `Question ${n}?` }))});`,
    `INSERT INTO message VALUES ('msg_${n}b', '${session}', ${at + S}, ${at + 2 * S}, ${quoted(reply)});`,
    `INSERT INTO part VALUES ('prt_${n}b', 'msg_${n}b', '${session}', ${at + S}, ${at + 2 * S}, ${quoted(JSON.stringify({ type: 'text', text: `Answer ${n}.` }))});`,
    `UPDATE session SET time_updated = ${at + 2 * S} WHERE id = '${session}';`
  ].join('\n')
}

/** A store root with one session in DIRECTORY and its first turn. */
async function storeRoot(options: { archivedAt?: number } = {}): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-opencode-close-')))
  temps.push(root)
  commit(root, await readFile(SCHEMA, 'utf8'))
  commit(
    root,
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated, time_archived)
     VALUES ('${SESSION}', 'prj_sample', NULL, 'sample-project', '${DIRECTORY}', 'A question', '1.18.31', 0, 0, 0, 0, 0, 'build', NULL, ${T0}, ${T0}, ${options.archivedAt ?? 'NULL'});\n` +
      turn(T0 + S, 1)
  )
  return root
}

/** The watch with Linux folder rules (the session's folder is a POSIX path) on every host. */
function watchOver(listing: SharedProcessListing, clock: FakeClock): ProcessGoneWatch {
  return new ProcessGoneWatch({
    listing,
    stems: OPENCODE_PROCESS_STEMS,
    clock,
    platform: 'linux',
    resolveFolder: () => Promise.resolve(null)
  })
}

function openCodeWorld(
  root: string,
  options: { ended?: Pick<EndedAgentLedger, 'has'>; startAt?: number } = {}
) {
  const clock = new FakeClock(options.startAt ?? T0 + 10 * S)
  const processes = new FakeProcessControl()
  const listing = new SharedProcessListing({ processes, stems: OPENCODE_PROCESS_STEMS, clock })
  const adapter = new OpenCodeObservationAdapter({
    providerId: 'opencode',
    storeRoot: root,
    openSnapshot: openReadOnlySnapshot,
    processWatch: watchOver(listing, clock),
    ...(options.ended === undefined ? {} : { ended: options.ended })
  })
  const cursors = new Map<string, Cursor>()
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

const base = { providerId: 'opencode', providerSessionId: SESSION }

describe('OpenCodeObservationAdapter closing (owner amendment I)', () => {
  it('[FM-059, US-OBS-005] a session first read long after its last change is quiet since that change: it closes within one confirmation of first sight', async () => {
    const { cycle, runFor } = openCodeWorld(await storeRoot(), { startAt: T0 + 7_200 * S })
    expect((await cycle()).filter((e) => e.kind === 'closed')).toEqual([])

    const closed = await runFor(PROCESS_GONE_CONFIRM_MS + 30 * S)
    expect(closed.map((e) => e.sourceEventId)).toContain('process-gone')
  })

  it('[FM-059, S4.33, INV-26] a quiet OpenCode session closes once two listings 30 s apart show no OpenCode process in its folder, never before 300 s of quiet', async () => {
    const { cycle, runFor } = openCodeWorld(await storeRoot())
    expect((await cycle()).filter((e) => e.kind === 'closed')).toEqual([])

    expect(await runFor(PROCESS_GONE_QUIET_MS - 15 * S)).toEqual([])
    const closed = await runFor(PROCESS_GONE_CONFIRM_MS + 30 * S)

    expect(closed.length).toBeGreaterThanOrEqual(1)
    expect(closed[0]).toMatchObject({
      kind: 'closed',
      sourceEventId: 'process-gone',
      identity: base,
      cwd: DIRECTORY
    })
  })

  it('[FM-059] an OpenCode process in the session folder keeps the session; one in another folder, or a Codex process, does not', async () => {
    const kept = openCodeWorld(await storeRoot())
    kept.processes.scriptProcess({ stem: 'opencode', cwd: `${DIRECTORY}/` })
    kept.processes.scriptProcess({ stem: 'opencode', cwd: '/home/j/work/other-project' })
    await kept.cycle()
    expect(await kept.runFor(PROCESS_GONE_QUIET_MS + 120 * S)).toEqual([])

    const elsewhere = openCodeWorld(await storeRoot())
    elsewhere.processes.scriptProcess({ stem: 'opencode', cwd: '/home/j/work/other-project' })
    elsewhere.processes.scriptProcess({ stem: 'codex', cwd: DIRECTORY })
    await elsewhere.cycle()
    const closed = await elsewhere.runFor(PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS + 30 * S)
    expect(closed.map((e) => e.sourceEventId)).toContain('process-gone')
  })

  it('[FM-059, INV-26] an unreadable process listing never closes an OpenCode session', async () => {
    const { processes, cycle, runFor } = openCodeWorld(await storeRoot())
    processes.scriptListing('unreadable')
    await cycle()

    expect(await runFor(PROCESS_GONE_QUIET_MS + 300 * S)).toEqual([])
  })

  it('[FM-059] a moving time_updated is activity: a session whose row keeps changing never closes, whatever the listing says', async () => {
    const root = await storeRoot()
    const { cycle, runFor, clock } = openCodeWorld(root)
    await cycle()
    for (let n = 0; n < 10; n++) {
      expect(await runFor(240 * S)).toEqual([])
      commit(root, `UPDATE session SET time_updated = ${clock.now()} WHERE id = '${SESSION}';`)
    }
  })

  it('[FM-059] an archived OpenCode session closes at once', async () => {
    const root = await storeRoot()
    const { cycle } = openCodeWorld(root)
    expect((await cycle()).filter((e) => e.kind === 'closed')).toEqual([])

    commit(root, `UPDATE session SET time_archived = ${T0 + 20 * S} WHERE id = '${SESSION}';`)
    const closed = (await cycle()).filter((e) => e.kind === 'closed')

    expect(closed).toEqual([
      expect.objectContaining({ sourceEventId: 'archived', identity: base, at: T0 + 20 * S })
    ])
  })

  it('[S4.41, FM-145, INV-36, ADR-015] a closed OpenCode session resumed under its own id arrives as a new dwarf, the closed identity gets nothing, and a Host restart derives the same identity', async () => {
    const root = await storeRoot()
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
      const listing = new SharedProcessListing({ processes, stems: OPENCODE_PROCESS_STEMS, clock })
      const adapter = new OpenCodeObservationAdapter({
        providerId: 'opencode',
        storeRoot: root,
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

    // The session arrives and is written, then its process is gone: it closes and joins the ledger.
    loop.start()
    await loop.whenIdle()
    expect(observed()).toEqual([base])
    const firstDwarf = dwarfs.bind(base, DIRECTORY as FolderPath, T0)
    await poll()
    expect(rowsOf(firstDwarf)).toHaveLength(2)
    const quiet = PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS + 30 * S
    for (let t = 0; t <= quiet; t += OBSERVATION_POLL_MS) await poll()
    expect(ended.has(base)).toBe(true)
    expect(bus.ofType('SessionClosedObserved')).toHaveLength(1)

    // S4.40 / INV-36: a late message of the closed run (no quiet gap before it) stays the closed
    // session's, which the ledger keeps from arriving or writing again.
    commit(root, turn(T0 + 60 * S, 9))
    await poll()
    await poll()
    expect(observed()).toEqual([base])
    expect(rowsOf(firstDwarf)).toHaveLength(2)

    // `opencode --session <id>` an hour later adds messages to the same session row.
    const resumedAt = T0 + 3_600 * S
    const resumed: ProviderIdentity = {
      providerId: 'opencode',
      providerSessionId: resumedSessionIdOf(SESSION, resumedAt)
    }
    commit(root, turn(resumedAt, 2))
    await poll()
    expect(observed()).toEqual([base, resumed])
    const secondDwarf = dwarfs.bind(resumed, DIRECTORY as FolderPath, T0)
    expect(secondDwarf).not.toBe(firstDwarf)
    await poll()
    expect(rowsOf(secondDwarf).map(([, key]) => key)).toEqual([
      `opencode:opencode:${SESSION}:prt_2a`,
      `opencode:opencode:${SESSION}:prt_2b`
    ])
    expect(rowsOf(firstDwarf)).toHaveLength(2)

    // A Host restart derives the same resumed identity: no new arrival, the next turn is its.
    loop.stop()
    ;({ loop } = loopOver())
    loop.start()
    await loop.whenIdle()
    commit(root, turn(resumedAt + 60 * S, 3))
    await poll()
    await poll()
    expect(observed()).toEqual([base, resumed])
    expect(
      rowsOf(secondDwarf)
        .map(([, key]) => key)
        .slice(-2)
    ).toEqual([`opencode:opencode:${SESSION}:prt_3a`, `opencode:opencode:${SESSION}:prt_3b`])
    // The restarted read looks back LOOKBACK_MS and hands turn 2 over once more, with its keys,
    // which the ingest drops (ADR-006 item 2): every key is written for exactly one dwarf.
    const dwarfsOfKey = new Map<string, Set<DwarfId>>()
    for (const [dwarfId, key] of rows()) {
      dwarfsOfKey.set(key, (dwarfsOfKey.get(key) ?? new Set()).add(dwarfId))
    }
    expect([...dwarfsOfKey.values()].every((owners) => owners.size === 1)).toBe(true)
    expect(rowsOf(firstDwarf)).toHaveLength(2)
    loop.stop()

    // Replayed from the start after a restart, every message keeps its key and its generation.
    const fresh = loopOver().adapter
    const [source] = (await fresh.discover(new NodeFs())) as [SourceFile]
    const replay = await fresh.read(source, null)
    const replayed = replay.events.flatMap((e) =>
      e.kind === 'entries' ? e.entries.map((x) => [x.sourceKey, e.identity.providerSessionId]) : []
    )
    expect(replayed).toEqual([
      [`opencode:opencode:${SESSION}:prt_1a`, SESSION],
      [`opencode:opencode:${SESSION}:prt_1b`, SESSION],
      [`opencode:opencode:${SESSION}:prt_9a`, SESSION],
      [`opencode:opencode:${SESSION}:prt_9b`, SESSION],
      [`opencode:opencode:${SESSION}:prt_2a`, resumed.providerSessionId],
      [`opencode:opencode:${SESSION}:prt_2b`, resumed.providerSessionId],
      [`opencode:opencode:${SESSION}:prt_3a`, resumed.providerSessionId],
      [`opencode:opencode:${SESSION}:prt_3b`, resumed.providerSessionId]
    ])
  })
})
