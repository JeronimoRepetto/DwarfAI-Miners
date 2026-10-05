// layer: L4
// L4 (17 §1.4) observer conformance of `AntigravityObservationAdapter` over
// `fixtures/antigravity/observer/**` (15 §6 C-11, C-19, C-20, C-21; 15 §5 Antigravity row,
// AMENDMENT-13): each case is laid out in a per-test temp `~/.gemini` (17 §5.3) and read through
// the real file system; its facts are compared with the hand-written `<case>.expected.json` (the
// `-crlf` and `-with-extra` variants share their case's expectation). The conversations databases
// are built from their SQL text and read through the read-only snapshot (FM-090). The fixtures are
// synthetic (meta.json `capturedBy: ci-synthetic`): the recorded ones of ISSUE-319 replace them.
//
// Candidate decision (21 §6): `src/main/providers/antigravity/*` is replaced. Its 81 tests pass
// unchanged at the branch point (`pnpm vitest run src/main/providers/antigravity`, 2 skipped: the
// real-CLI lane), but they are written against today's snapshot `Provider.scan()`, `FsLike` and
// `FeedMessage`, not the cursor-based `ObservationAdapter` of 16 §4.3; the candidate mines no
// tokens at all (`antigravityProvider.ts:97-98`), and only src/legacy-bridge may import it (R16).
// Its rules are reimplemented here: the step log pinned to agy 1.1.26 with skip-not-throw, the
// `<USER_REQUEST>` envelope, the newest-by-timestamp workspace of `history.jsonl`, and the presence
// lock as a hint bounded by a grace on disappearance.
import { realpathSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, FolderPath } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import {
  openReadOnlySnapshot,
  type ReadOnlySnapshot,
  type ReadOnlySnapshotOpener
} from '../../../../platform/sqlite/readOnlySnapshot'
import type { ObservationEvent, SessionObserved } from '../../application/events'
import { OBSERVATION_POLL_MS, ObservationLoop } from '../../application/observationLoop'
import { InMemoryCursorStore } from '../../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../../ports/fakes/RecordingObservedBatchSink'
import type { Cursor, SourceFile } from '../../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../../testing/inMemoryTransactions'
import {
  ANTIGRAVITY_LOCK_GRACE_MS,
  AntigravityObservationAdapter,
  antigravityGeminiDirOf
} from './AntigravityObservationAdapter'
import { workspacesOfHistory } from './discovery'

type AgyRead = Awaited<ReturnType<AntigravityObservationAdapter['read']>>

const T0 = 1_790_800_000_000
const CID = '11111111-1111-4111-8111-111111111111'
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/antigravity/observer/1.1.26'
)
const TREES = ['antigravity-cli', 'antigravity', 'antigravity-acp'] as const
type Tree = (typeof TREES)[number]

const temps: string[] = []
const writers: NodeSqliteDatabase[] = []
afterEach(async () => {
  for (const db of writers.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A per-test `~/.gemini`, in its real spelling (macOS `/private/var`, Windows 8.3 names). */
async function tempGemini(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-agy-')))
  temps.push(dir)
  return dir
}

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(FIXTURES, name))
}

async function expectation(name: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse((await fixture(name)).toString('utf8')) as Record<string, unknown>
  delete parsed['$comment']
  return parsed
}

/** The transcript cases of the fixture folder, each with the expectation it is held to. */
async function transcriptCases(): Promise<Array<{ file: string; expected: string }>> {
  const names = (await readdir(FIXTURES))
    .filter((name) => name.endsWith('.jsonl') && !name.startsWith('history'))
    .sort()
  return names.map((file) => ({
    file,
    expected: `${file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')}.expected.json`
  }))
}

const DB_CASES = [
  'conversation-db',
  'conversation-db-drifted-blob',
  'conversation-db-no-gen-metadata'
] as const

function transcriptPath(gemini: string, cid = CID): string {
  return join(
    gemini,
    'antigravity-cli',
    'brain',
    cid,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
}

function lockPath(gemini: string, cid = CID): string {
  return join(gemini, 'antigravity-cli', 'presence', `${cid}.lock`)
}

function dbPath(gemini: string, tree: Tree = 'antigravity-cli', cid = CID): string {
  return join(gemini, tree, 'conversations', `${cid}.db`)
}

/** When the fixtures' conversation started: its lock is written just before its first step. */
const STARTED_AT = Date.parse('2026-09-04T19:01:00Z')

/**
 * Writes or removes the conversation's presence lock. A lock is a 0-byte file the CLI writes when a
 * session starts, so its modification time is that start (`createdAt`, the fixtures' by default).
 */
async function setLock(gemini: string, present: boolean, createdAt = STARTED_AT): Promise<void> {
  if (present) {
    await mkdir(dirname(lockPath(gemini)), { recursive: true })
    await writeFile(lockPath(gemini), '')
    await utimes(lockPath(gemini), createdAt / 1000, createdAt / 1000)
  } else {
    await rm(lockPath(gemini), { force: true })
  }
}

/** A `~/.gemini` holding one transcript case (byte for byte), the history and a held lock. */
async function storeWith(options: {
  transcript?: string
  history?: boolean
  lock?: boolean
  db?: (typeof DB_CASES)[number]
  tree?: Tree
}): Promise<string> {
  const gemini = await tempGemini()
  if (options.transcript !== undefined) {
    await mkdir(dirname(transcriptPath(gemini)), { recursive: true })
    await writeFile(transcriptPath(gemini), await fixture(options.transcript))
  }
  if (options.history !== false) {
    await mkdir(join(gemini, 'antigravity-cli'), { recursive: true })
    await writeFile(
      join(gemini, 'antigravity-cli', 'history.jsonl'),
      await fixture('history.jsonl')
    )
  }
  await setLock(gemini, options.lock !== false)
  if (options.db !== undefined) await buildDb(dbPath(gemini, options.tree), options.db)
  return gemini
}

/** A conversations database built from its SQL text, closed (no provider writing it). */
async function buildDb(path: string, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const db = NodeSqliteDatabase.open(path)
  db.exec((await fixture(`${name}.sql`)).toString('utf8'))
  db.close()
}

function adapterAt(
  gemini: string,
  extra: { clock?: FakeClock; openSnapshot?: ReadOnlySnapshotOpener } = {}
): AntigravityObservationAdapter {
  return new AntigravityObservationAdapter({
    providerId: 'antigravity',
    geminiDir: gemini,
    claimedRoots: [],
    fs: new NodeFs(),
    clock: extra.clock ?? new FakeClock(T0),
    openSnapshot: extra.openSnapshot ?? openReadOnlySnapshot
  })
}

async function sourceOf(
  adapter: AntigravityObservationAdapter,
  kind: 'transcript' | 'db'
): Promise<SourceFile> {
  const sources = (await adapter.discover(new NodeFs())).filter((s) =>
    kind === 'db' ? s.path.endsWith('.db') : s.path.endsWith('transcript.jsonl')
  )
  expect(sources).toHaveLength(1)
  return sources[0]!
}

/** An adapter whose conversation has closed: its lock is gone and the grace has passed. */
async function closedAdapter(
  gemini: string,
  extra: { openSnapshot?: ReadOnlySnapshotOpener } = {}
): Promise<{ adapter: AntigravityObservationAdapter; clock: FakeClock }> {
  await setLock(gemini, false)
  const clock = new FakeClock(T0)
  const adapter = adapterAt(gemini, { clock, ...extra })
  await adapter.discover(new NodeFs())
  clock.advance(ANTIGRAVITY_LOCK_GRACE_MS)
  return { adapter, clock }
}

/** The facts of a transcript read in the shape of `<case>.expected.json`. */
function summary(read: AgyRead) {
  const session = read.events.find((e) => e.kind === 'session')
  return {
    warnings: read.warnings.length,
    session:
      session?.kind === 'session'
        ? {
            providerSessionId: session.identity.providerSessionId,
            cwd: session.cwd,
            at: session.at
          }
        : null,
    entries: read.events.flatMap((e) =>
      e.kind === 'entries'
        ? e.entries.map((x) => ({ role: x.role, text: x.text, providerTime: x.providerTime }))
        : []
    ),
    activity: read.events.flatMap((e) => (e.kind === 'activity' ? [e.activity] : [])),
    closes: read.events.filter((e) => e.kind === 'closed').length,
    turnEnds: read.events.filter((e) => e.kind === 'turn-ended').length,
    usage: read.events.filter((e) => e.kind === 'usage')
  }
}

/** The usage of a database read in the shape of `conversation-db*.expected.json`. */
function usageSummary(read: AgyRead, adapter: AntigravityObservationAdapter) {
  return {
    warnings: read.warnings.length,
    watermark: read.next.value,
    usage: read.events.flatMap((e) =>
      e.kind === 'usage'
        ? [
            {
              unitKey: e.usage.unitKey,
              modelId: adapter.modelIdOf(e.usage.unitKey),
              fidelity: e.usage.fidelity,
              tokens: e.usage.tokens,
              sealed: e.usage.sealed,
              providerTime: e.usage.providerTime
            }
          ]
        : []
    )
  }
}

/** Every deterministic key a read produced (ADR-006 item 2, HO-37). */
function keysOf(read: AgyRead): string[] {
  return [
    ...read.events.map((e) => `${e.kind}:${e.identity.providerSessionId}:${e.sourceEventId}`),
    ...read.events.flatMap((e) => (e.kind === 'entries' ? e.entries.map((x) => x.sourceKey) : [])),
    ...read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage.sourceKey] : []))
  ]
}

/** Runs `presence-lock.json`: the closes each step's read carries. */
async function presenceRun(): Promise<{ closes: number[]; keys: string[] }> {
  const steps = (await expectation('presence-lock.json'))['steps'] as Array<{
    lock: boolean
    advanceMs: number
  }>
  const gemini = await storeWith({ transcript: 'transcript.jsonl' })
  const clock = new FakeClock(T0)
  const adapter = adapterAt(gemini, { clock })
  let cursor: Cursor | null = null
  const closes: number[] = []
  const keys: string[] = []
  for (const step of steps) {
    await setLock(gemini, step.lock)
    clock.advance(step.advanceMs)
    const source = await sourceOf(adapter, 'transcript')
    const read = await adapter.read(source, cursor)
    cursor = read.next
    closes.push(summary(read).closes)
    keys.push(...keysOf(read).filter((k) => k.startsWith('closed:')))
  }
  return { closes, keys }
}

describe('AntigravityObservationAdapter conformance (fixtures/antigravity/observer)', () => {
  it('[INV-38, FM-068] a drifted record is skipped and counted as drift and the session continues', async () => {
    for (const file of ['drifted-record.jsonl', 'drifted-record-crlf.jsonl']) {
      const gemini = await storeWith({ transcript: file })
      const adapter = adapterAt(gemini)
      const source = await sourceOf(adapter, 'transcript')
      const read = await adapter.read(source, null)
      expect(summary(read), file).toEqual(await expectation('drifted-record.expected.json'))
      // Each drift is a warning naming its byte offset and nothing the record held.
      for (const warning of read.warnings) {
        expect(warning, file).toMatch(/^unreadable line at byte \d+$/)
      }
      expect(read.next.value, file).toBe(source.size)

      // The session goes on: a step written after the drift is read from the cursor.
      const next = JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-09-04T19:01:20Z',
        content: 'Still here.'
      })
      await appendFile(transcriptPath(gemini), next + (file.includes('crlf') ? '\r\n' : '\n'))
      const after = await adapter.read(await sourceOf(adapter, 'transcript'), read.next)
      expect(
        summary(after).entries.map((e) => e.text),
        file
      ).toEqual(['Still here.'])
      expect(after.warnings, file).toEqual([])
    }
  })

  it('[C-19] every Antigravity fixture replayed twice yields identical source keys and no new event', async () => {
    const cases = await transcriptCases()
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const { file, expected } of cases) {
      const gemini = await storeWith({ transcript: file })
      const adapter = adapterAt(gemini)
      const source = await sourceOf(adapter, 'transcript')
      const first = await adapter.read(source, null)
      expect(summary(first), file).toEqual(await expectation(expected))
      expect(first.next.value, file).toBe(source.size)

      // Read again from the cursor it returned: nothing new.
      const again = await adapter.read(source, first.next)
      expect(again.events, file).toEqual([])
      expect(again.next, file).toEqual(first.next)

      // Replayed from the start by a fresh adapter (a Host restart): the same keys, in order.
      const fresh = adapterAt(gemini)
      const replay = await fresh.read(await sourceOf(fresh, 'transcript'), null)
      expect(keysOf(replay), file).toEqual(keysOf(first))
      expect(new Set(keysOf(first)).size, file).toBe(keysOf(first).length)
    }

    // The workspace map, LF and CRLF alike.
    const workspaces = (await expectation('history.expected.json'))['workspaces']
    for (const file of ['history.jsonl', 'history-crlf.jsonl']) {
      const text = (await fixture(file)).toString('utf8')
      expect(Object.fromEntries(workspacesOfHistory(text)), file).toEqual(workspaces)
      expect(Object.fromEntries(workspacesOfHistory(text)), file).toEqual(workspaces)
    }

    // The conversations databases.
    for (const name of DB_CASES) {
      const gemini = await storeWith({ db: name })
      const { adapter } = await closedAdapter(gemini)
      const source = await sourceOf(adapter, 'db')
      const first = await adapter.read(source, null)
      expect(usageSummary(first, adapter), name).toEqual(await expectation(`${name}.expected.json`))
      expect(first.next.kind, name).toBe('watermark')
      const again = await adapter.read(source, first.next)
      expect(again.events, name).toEqual([])
      const { adapter: fresh } = await closedAdapter(gemini)
      const replay = await fresh.read(await sourceOf(fresh, 'db'), null)
      expect(keysOf(replay), name).toEqual(keysOf(first))
    }

    // The presence lock sequence.
    const once = await presenceRun()
    const twice = await presenceRun()
    expect(once.closes).toEqual((await expectation('presence-lock.expected.json'))['closes'])
    expect(twice).toEqual(once)
  })

  it('[C-11] an unknown step type produces no event and no ask', async () => {
    const gemini = await storeWith({ transcript: 'drifted-record.jsonl' })
    const adapter = adapterAt(gemini)
    const read = await adapter.read(await sourceOf(adapter, 'transcript'), null)
    // Nothing of the unknown step (CHECKPOINT_SUMMARY, step 2) or the renamed one reaches a fact.
    const facts = JSON.stringify(read.events)
    expect(facts).not.toMatch(/never seen|renamed field|CHECKPOINT/)
    expect(read.events.map((e) => e.sourceEventId)).not.toContain('2')
    expect(read.events.map((e) => e.sourceEventId)).not.toContain('1')
    // No kind outside what an observed Antigravity session can say: no ask of any shape.
    const kinds = new Set(read.events.map((e) => e.kind))
    for (const kind of kinds) expect(['session', 'entries', 'activity']).toContain(kind)
    expect(adapter.capabilities().observedPermission).toBe('none')
    expect(adapter.capabilities().observedQuestion).toBe('none')

    // The harness's own steps (SYSTEM_MESSAGE, ERROR_MESSAGE) are known and say nothing either.
    const plain = await storeWith({ transcript: 'transcript.jsonl' })
    const reader = adapterAt(plain)
    const all = await reader.read(await sourceOf(reader, 'transcript'), null)
    expect(JSON.stringify(all.events)).not.toMatch(/SYSTEM_MESSAGE|tool call failed/)
    expect(all.warnings).toEqual([])
  })

  it('[C-20] with no turn-end signal the adapter declares turnEnd none and emits no TurnEnded', async () => {
    expect(adapterAt(await tempGemini()).capabilities().turnEnd).toBe('none')
    for (const { file } of await transcriptCases()) {
      const gemini = await storeWith({ transcript: file })
      const adapter = adapterAt(gemini)
      const read = await adapter.read(await sourceOf(adapter, 'transcript'), null)
      expect(
        read.events.filter((e) => e.kind === 'turn-ended'),
        file
      ).toEqual([])
    }
  })

  it('[FM-059] the presence lock disappearing emits one SessionClosedObserved', async () => {
    // The adapter: one `closed` fact, once the lock has been gone for the grace.
    const run = await presenceRun()
    expect(run.closes).toEqual((await expectation('presence-lock.expected.json'))['closes'])
    // Every read of the closed conversation states the same close, under one key.
    expect(new Set(run.keys).size).toBe(1)

    // Through the observation loop: the observed dwarf departs once.
    const gemini = await storeWith({ transcript: 'transcript.jsonl' })
    const clock = new FakeClock(T0)
    const scheduler = new FakeScheduler(clock)
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const identity = { providerId: 'antigravity', providerSessionId: CID }
    const dwarfId: DwarfId = dwarfs.bind(
      identity,
      'C:\\Users\\j\\Desktop\\Sample-Project' as FolderPath,
      T0
    )
    const cursors = new InMemoryCursorStore(transactions)
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    const sink = new RecordingObservedBatchSink(transactions)
    for (const p of [cursors, sessions, sink]) transactions.enlist(p)
    const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
    const fs = new NodeFs()
    const loop = new ObservationLoop({
      adapters: [adapterAt(gemini, { clock })],
      fs,
      cursors,
      sessions,
      sink,
      transactions,
      bus,
      clock,
      scheduler,
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0074',
      log: new RecordingDiagnosticsLog()
    })
    const poll = async () => {
      clock.advance(OBSERVATION_POLL_MS)
      await loop.whenIdle()
    }
    loop.start()
    await loop.whenIdle()
    expect(sink.applied.flatMap((b) => b.entries)).toHaveLength(4)
    expect(sink.applied.every((b) => b.dwarfId === dwarfId)).toBe(true)

    await setLock(gemini, false)
    for (
      let elapsed = 0;
      elapsed <= 3 * ANTIGRAVITY_LOCK_GRACE_MS;
      elapsed += OBSERVATION_POLL_MS
    ) {
      await poll()
    }
    loop.stop()
    const closed = bus.ofType('SessionClosedObserved')
    expect(closed).toHaveLength(1)
    expect(closed[0]!.payload.identity).toEqual(identity)
  })

  it('[ADR-014] the adapter declares usage fidelity 1 and no readable process identity', async () => {
    const adapter = adapterAt(await tempGemini())
    expect(adapter.processIdentitySource).toBe('none')
    const capabilities = adapter.capabilities()
    expect(capabilities.usage).toEqual({ fidelity: 1, rateLimits: false })
    // No pid to focus or kill: the console is the log (15 §3.2 row A2), and nothing more.
    expect(capabilities.console).toBe('log')
    expect(capabilities.interrupt).toBe(false)
    expect(capabilities.launch).toBe(false)
    // And no observed fact carries one.
    for (const { file } of await transcriptCases()) {
      const gemini = await storeWith({ transcript: file, db: 'conversation-db' })
      const { adapter: fresh } = await closedAdapter(gemini)
      const sources = await fresh.discover(new NodeFs())
      for (const source of sources) {
        const read = await fresh.read(source, null)
        expect(JSON.stringify(read), file).not.toMatch(/"pid"|processIdentity/i)
      }
    }
  })

  it('[C-21, ADR-006] each gen_metadata row of the conversations database yields one usage unit keyed conversationId gen idx with the model id', async () => {
    const expected = await expectation('conversation-db.expected.json')
    for (const tree of TREES) {
      const gemini = await storeWith({ db: 'conversation-db', tree })
      const { adapter } = await closedAdapter(gemini)
      const read = await adapter.read(await sourceOf(adapter, 'db'), null)
      expect(usageSummary(read, adapter), tree).toEqual(expected)
      for (const event of read.events) {
        expect(event.identity, tree).toEqual({ providerId: 'antigravity', providerSessionId: CID })
        if (event.kind !== 'usage') continue
        const idx = event.usage.unitKey.split(':gen:')[1]
        expect(event.sourceEventId, tree).toBe(`gen:${idx}`)
        expect(event.usage.sourceKey, tree).toBe(`antigravity:antigravity:${CID}:gen:${idx}`)
      }
    }
    // An unknown unit has no model id.
    expect(adapterAt(await tempGemini()).modelIdOf(`${CID}:gen:9`)).toBeNull()
    // The three trees sit under `~/.gemini`, which the composition resolves from the home folder.
    expect(antigravityGeminiDirOf(join('/home', 'j'))).toBe(join('/home', 'j', '.gemini'))
  })

  it('[C-21] a unit is sealed only once a higher idx exists or the session closes, and a replay credits nothing twice', async () => {
    const gemini = await storeWith({})
    const path = dbPath(gemini)
    await mkdir(dirname(path), { recursive: true })
    // The provider, writing: a WAL database whose commits stay in the WAL.
    const writer = NodeSqliteDatabase.open(path)
    writers.push(writer)
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    const sql = (await fixture('conversation-db.sql')).toString('utf8')
    const inserts = sql.split('\n').filter((line) => line.startsWith('INSERT'))
    writer.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)')
    writer.exec(inserts[0]!)
    writer.exec(inserts[1]!)

    const clock = new FakeClock(T0)
    const adapter = adapterAt(gemini, { clock })
    const units = (read: AgyRead) =>
      read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage.unitKey] : []))
    const all: string[] = []
    let cursor: Cursor | null = null
    const step = async () => {
      const read = await adapter.read(await sourceOf(adapter, 'db'), cursor)
      cursor = read.next
      for (const event of read.events)
        if (event.kind === 'usage') expect(event.usage.sealed).toBe(true)
      all.push(...units(read))
      return units(read)
    }

    // Rows 1 and 2, the conversation running: only row 1 has a higher idx.
    expect(await step()).toEqual([`${CID}:gen:1`])
    expect(await step()).toEqual([])
    // Row 3 is written: row 2 is sealed, row 3 is not yet.
    writer.exec(inserts[2]!)
    expect(await step()).toEqual([`${CID}:gen:2`])
    // The lock goes; within the grace the conversation may still be running.
    await setLock(gemini, false)
    expect(await step()).toEqual([])
    clock.advance(ANTIGRAVITY_LOCK_GRACE_MS)
    expect(await step()).toEqual([`${CID}:gen:3`])
    expect(await step()).toEqual([])
    expect(new Set(all).size).toBe(all.length)

    // A Host restart replays the database from the start: the same keys, each once.
    const { adapter: fresh } = await closedAdapter(gemini)
    const replay = await fresh.read(await sourceOf(fresh, 'db'), null)
    expect(units(replay)).toEqual(all)
    expect(replay.events.map((e) => (e.kind === 'usage' ? e.usage.sourceKey : ''))).toEqual(
      all.map((unit) => `antigravity:antigravity:${unit}`)
    )
  })

  it('[FM-068] a blob that does not decode or a database without gen_metadata yields no usage, counts as drift and the transcript side goes on', async () => {
    for (const name of [
      'conversation-db-drifted-blob',
      'conversation-db-no-gen-metadata'
    ] as const) {
      const gemini = await storeWith({ transcript: 'transcript.jsonl', db: name })
      const { adapter } = await closedAdapter(gemini)
      const db = await sourceOf(adapter, 'db')
      const read = await adapter.read(db, null)
      expect(usageSummary(read, adapter), name).toEqual(await expectation(`${name}.expected.json`))
      // Drift names no content of the blob.
      for (const warning of read.warnings) {
        expect(warning, name).not.toMatch(/synthetic|model|[0-9a-f]{2} [0-9a-f]{2}/)
      }
      // Counted once: the next cycle reads nothing new and warns no more.
      const again = await adapter.read(await sourceOf(adapter, 'db'), read.next)
      expect(again.warnings, name).toEqual([])
      expect(again.events, name).toEqual([])
      // The transcript side goes on.
      const transcript = await adapter.read(await sourceOf(adapter, 'transcript'), null)
      expect(summary(transcript).entries, name).toEqual(
        (await expectation('transcript.expected.json'))['entries']
      )
    }
  })

  it('[FM-090] the conversations database is read through the read-only snapshot and its file is never written or locked', async () => {
    const gemini = await storeWith({})
    const path = dbPath(gemini)
    const folder = dirname(path)
    await mkdir(folder, { recursive: true })
    const writer = NodeSqliteDatabase.open(path)
    writers.push(writer)
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    const sql = (await fixture('conversation-db.sql')).toString('utf8')
    const inserts = sql.split('\n').filter((line) => line.startsWith('INSERT'))
    writer.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)')
    writer.exec(inserts[0]!)
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    // Rows 2 and 3 are committed to the WAL only: `immutable` would not see them.
    writer.exec(inserts[1]!)
    writer.exec(inserts[2]!)
    writer.exec('CREATE TABLE provider_log (n INTEGER NOT NULL)')

    const opened: string[] = []
    let writtenDuringRead = 0
    const recording: ReadOnlySnapshotOpener = async (location) => {
      opened.push(location)
      const snapshot: ReadOnlySnapshot = await openReadOnlySnapshot(location)
      if (snapshot.kind !== 'open') return snapshot
      return {
        kind: 'open',
        reader: {
          all: (query, params) => {
            const rows = snapshot.reader.all(query, params)
            // The provider keeps writing while the adapter reads: never locked out.
            writer.exec(`INSERT INTO provider_log (n) VALUES (${++writtenDuringRead})`)
            return rows
          },
          close: () => snapshot.reader.close()
        }
      }
    }
    const mainBefore = await readFile(path)
    const listingBefore = (await readdir(folder)).sort()

    const { adapter } = await closedAdapter(gemini, { openSnapshot: recording })
    const read = await adapter.read(await sourceOf(adapter, 'db'), null)
    // Every committed row was read, the WAL's included, and only through the snapshot.
    expect(read.events.map((e) => e.sourceEventId)).toEqual(['gen:1', 'gen:2', 'gen:3'])
    expect(read.warnings).toEqual([])
    expect(opened.length).toBeGreaterThan(0)
    expect(new Set(opened)).toEqual(new Set([path]))
    expect(writtenDuringRead).toBeGreaterThan(0)
    // The provider's main file is byte for byte the same and nothing new sits beside it.
    expect((await readFile(path)).equals(mainBefore)).toBe(true)
    expect((await readdir(folder)).sort()).toEqual(listingBefore)

    // With no provider running there is no WAL: the snapshot reads a private copy and the folder
    // is left exactly as it was.
    writer.close()
    const closedListing = (await readdir(folder)).sort()
    const closedMain = await readFile(path)
    const { adapter: later } = await closedAdapter(gemini)
    const replay = await later.read(await sourceOf(later, 'db'), null)
    expect(replay.events.map((e) => e.sourceEventId)).toEqual(['gen:1', 'gen:2', 'gen:3'])
    expect((await readdir(folder)).sort()).toEqual(closedListing)
    expect((await readFile(path)).equals(closedMain)).toBe(true)

    // A busy database is read again next cycle, with no event and no warning.
    const { adapter: busy } = await closedAdapter(gemini, {
      openSnapshot: () => Promise.resolve({ kind: 'retry-next-cycle', code: 'SQLITE_BUSY' })
    })
    const sources = await busy.discover(new NodeFs())
    for (const source of sources.filter((s) => s.path.endsWith('.db'))) {
      const blocked = await busy.read(source, null)
      expect(blocked.events).toEqual([])
      expect(blocked.warnings).toEqual([])
      expect(blocked.next.value).toBe(0)
    }
  })
  it('[S4.41, FM-145, ADR-015] a closed Antigravity conversation resumed under the same id appears as a new dwarf and its earlier records add no rows', async () => {
    const gemini = await storeWith({ transcript: 'transcript.jsonl' })
    const cwd = 'C:\Users\j\Desktop\Sample-Project' as FolderPath
    const original = { providerId: 'antigravity', providerSessionId: CID }
    // `agy --conversation <id>` (AMENDMENT-13) an hour later: a new lock, the same id, new steps.
    const resumedAt = Date.parse('2026-09-04T20:00:00Z')
    const resumed = { providerId: 'antigravity', providerSessionId: `${CID}~resumed-1788552000` }
    const step = (index: number, at: string, source: string, type: string, content: string) =>
      JSON.stringify({ step_index: index, source, type, status: 'DONE', created_at: at, content }) +
      '\n'

    const clock = new FakeClock(T0)
    const scheduler = new FakeScheduler(clock)
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const cursors = new InMemoryCursorStore(transactions)
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    const ended = new InMemoryEndedAgentLedger(transactions)
    const sink = new RecordingObservedBatchSink(transactions)
    for (const p of [cursors, sessions, ended, sink]) transactions.enlist(p)
    const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
    const fs = new NodeFs()
    const loopOver = (adapter: AntigravityObservationAdapter) =>
      new ObservationLoop({
        adapters: [adapter],
        fs,
        cursors,
        sessions,
        sink,
        transactions,
        bus,
        clock,
        scheduler,
        ids: new SequenceIdGenerator(),
        hostEpoch: 'epoch-0074',
        log: new RecordingDiagnosticsLog(),
        ended
      })
    let loop = loopOver(adapterAt(gemini, { clock }))
    const poll = async () => {
      clock.advance(OBSERVATION_POLL_MS)
      await loop.whenIdle()
    }
    const observed = () =>
      bus.published
        .filter((e): e is SessionObserved => e.type === 'SessionObserved')
        .map((e) => e.payload.identity)
    const rows = () => sink.applied.flatMap((b) => b.entries.map((e) => [b.dwarfId, e.sourceKey]))

    // The conversation arrives, is written, then closes: its identity joins the ledger.
    loop.start()
    await loop.whenIdle()
    expect(observed()).toEqual([original])
    const first = dwarfs.bind(original, cwd, T0)
    await poll()
    expect(rows()).toHaveLength(4)
    await setLock(gemini, false)
    for (let t = 0; t <= ANTIGRAVITY_LOCK_GRACE_MS; t += OBSERVATION_POLL_MS) await poll()
    expect(ended.has(original)).toBe(true)
    expect(bus.ofType('SessionClosedObserved')).toHaveLength(1)

    // Resumed under the same id: a new identity, which the ledger does not suppress.
    await setLock(gemini, true, resumedAt)
    await appendFile(
      transcriptPath(gemini),
      step(
        13,
        '2026-09-04T20:00:05Z',
        'USER_EXPLICIT',
        'USER_INPUT',
        '<USER_REQUEST>\nAnd now?\n</USER_REQUEST>'
      ) +
        step(
          14,
          '2026-09-04T20:00:09Z',
          'MODEL',
          'PLANNER_RESPONSE',
          'Picking up where we left off.'
        )
    )
    await poll()
    expect(observed()).toEqual([original, resumed])
    const second = dwarfs.bind(resumed, cwd, T0)
    expect(second).not.toBe(first)
    await poll()
    // Only the resumed steps are the new dwarf's; nothing written before the close is written again.
    expect(rows().slice(4)).toEqual([
      [second, `antigravity:antigravity:${CID}:13`],
      [second, `antigravity:antigravity:${CID}:14`]
    ])

    // A Host restart derives the same resumed identity: no second arrival, the next step is its.
    loop.stop()
    loop = loopOver(adapterAt(gemini, { clock }))
    loop.start()
    await loop.whenIdle()
    await appendFile(
      transcriptPath(gemini),
      step(15, '2026-09-04T20:01:00Z', 'MODEL', 'PLANNER_RESPONSE', 'Done.')
    )
    await poll()
    expect(observed()).toEqual([original, resumed])
    expect(rows().slice(6)).toEqual([[second, `antigravity:antigravity:${CID}:15`]])
    loop.stop()

    // Replayed from the start after a restart, every step keeps its key and its generation.
    const fresh = adapterAt(gemini)
    const replay = await fresh.read(await sourceOf(fresh, 'transcript'), null)
    const entries = replay.events.flatMap((e) =>
      e.kind === 'entries' ? e.entries.map((x) => [e.identity.providerSessionId, x.sourceKey]) : []
    )
    expect(entries).toEqual([
      [CID, `antigravity:antigravity:${CID}:0`],
      [CID, `antigravity:antigravity:${CID}:4`],
      [CID, `antigravity:antigravity:${CID}:5`],
      [CID, `antigravity:antigravity:${CID}:12`],
      [resumed.providerSessionId, `antigravity:antigravity:${CID}:13`],
      [resumed.providerSessionId, `antigravity:antigravity:${CID}:14`],
      [resumed.providerSessionId, `antigravity:antigravity:${CID}:15`]
    ])
    expect(new Set(rows().map(([, key]) => key)).size).toBe(rows().length)
  })
})
