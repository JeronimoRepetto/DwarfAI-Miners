// layer: L4
// L4 (17 §1.4) of the Claude reconciliation (15 §5 "Anti-ghost reconciliation placement" items 1–3
// and "PID + creation-time re-adoption"; 16 §4.3 `EndedAgentLedger`, `recordEnded`) over
// `fixtures/claude/observer/**`: the observation loop reads `ClaudeObservationAdapter` from a
// per-test temp Claude configuration folder (17 §5.3) laid out as Claude Code lays it out, into the
// module's in-memory doubles, and crew's route is played by hand (`bind`, `depart`).
//
// TC-072-01 (an ended identity writes again: no event, no dwarf, no mine reattachment),
// TC-072-02 (the transplanted anti-ghost and #45 rules), TC-072-03 (one tolerance constant).
//
// Candidate decision (21 §6): `claudeProvider.ts` `terminalAgents` and `procStartVerdicts` are
// replaced. Their tests (`claudeProvider.test.ts`, 223 passed unchanged at the branch point:
// `pnpm vitest run src/main/providers/claude/claudeProvider.test.ts`) drive today's registry-first
// `Provider.scan()` snapshot (launch records, in-flight agents, the pending-count ceiling), not the
// cursor-based `ObservationAdapter` of 16 §4.3, and only src/legacy-bridge may import the candidate
// (R16). They stay with the legacy provider (no test removed) and `src/host/invariants.test.ts`
// references them beside these. Their rules are reimplemented in `reconcile.ts`: an ending is read
// only from the three delivery envelopes (#28, #64), an ended agent never comes back (the ledger,
// INV-36), the nested parent from the sidecar (#391), and the #45 pid-recycle guard on the kernel's
// one tolerance.
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  matchesRecorded,
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'
import type { FolderPath, ProviderIdentity } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import type { ObservationEvent, SessionObserved } from '../../application/events'
import { OBSERVATION_POLL_MS, ObservationLoop } from '../../application/observationLoop'
import { createObservation } from '../../index'
import { InMemoryCursorStore } from '../../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../../ports/fakes/RecordingObservedBatchSink'
import { InMemoryBoundDwarfs } from '../../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../../testing/inMemoryTransactions'
import { ClaudeObservationAdapter, IDENTITY_RECHECK_MS } from './ClaudeObservationAdapter'

const T0 = 1_790_800_000_000
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/claude/observer/2.1.x'
)
const CWD = 'C:\\Users\\j\\work\\sample.project'
const POSIX_CWD = '/home/j/work/sample-project'

const ENDED_SESSION = '01a0b000-0000-7000-8000-000000000720'
const PLAIN_SESSION = '01a0b000-0000-7000-8000-000000000711'
const SUBAGENT_SESSION = '01a0b000-0000-7000-8000-000000000716'
const RESUMED_SESSION = '01a0b000-0000-7000-8000-000000000717'
const WORKER = 'a1b2c3d4e5f607181'
const NESTED = 'b2c3d4e5f6071829a'

const claude = (providerSessionId: string, providerAgentId?: string): ProviderIdentity => ({
  providerId: 'claude',
  providerSessionId,
  ...(providerAgentId === undefined ? {} : { providerAgentId })
})

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A per-test folder in its real spelling: discovery reports every source by its canonical
 * (`realpath.native`) path (FM-093), and the tests look sources up by the paths they wrote, which
 * differ when the temp root is reached through a link (macOS `/var` → `/private/var`, a Windows
 * 8.3 short name, a junction).
 */
async function tempDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-reconcile-')))
  temps.push(dir)
  return dir
}

/** Claude Code's own project-folder name: every non-alphanumeric character becomes a dash. */
function encodedFolderOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(FIXTURES, name))
}

/** Writes a session's own transcript where Claude Code writes it. */
async function placeSession(
  configDir: string,
  cwd: string,
  sessionId: string,
  bytes: Buffer | string
): Promise<string> {
  const project = join(configDir, 'projects', encodedFolderOf(cwd))
  await mkdir(project, { recursive: true })
  const path = join(project, `${sessionId}.jsonl`)
  await writeFile(path, bytes)
  return path
}

/** Writes a subagent's transcript and its sidecar where Claude Code writes them. */
async function placeSubagent(
  configDir: string,
  cwd: string,
  sessionId: string,
  agentId: string,
  bytes: Buffer,
  sidecar: Buffer
): Promise<string> {
  const subagents = join(configDir, 'projects', encodedFolderOf(cwd), sessionId, 'subagents')
  await mkdir(subagents, { recursive: true })
  const path = join(subagents, `agent-${agentId}.jsonl`)
  await writeFile(path, bytes)
  await writeFile(join(subagents, `agent-${agentId}.meta.json`), sidecar)
  return path
}

function world(configDir: string, processes?: FakeProcessControl) {
  const transactions = new InMemoryTransactions()
  const dwarfs = new InMemoryBoundDwarfs()
  const cursors = new InMemoryCursorStore(transactions)
  const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
  const ended = new InMemoryEndedAgentLedger(transactions)
  const sink = new RecordingObservedBatchSink(transactions)
  for (const participant of [cursors, sessions, ended, sink]) transactions.enlist(participant)
  const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const fs = new NodeFs()
  const adapter = new ClaudeObservationAdapter({
    providerId: 'claude',
    configDir,
    claimedRoots: [],
    fs,
    clock,
    ...(processes === undefined ? {} : { processes })
  })
  const deps = {
    adapters: [adapter],
    fs,
    cursors,
    sessions,
    ended,
    sink,
    transactions,
    bus,
    clock,
    scheduler,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0072',
    log: new RecordingDiagnosticsLog()
  }
  const loop = new ObservationLoop(deps)
  /** One poll: the clock reaches the next cycle and the cycle's reads settle. */
  const poll = async () => {
    clock.advance(OBSERVATION_POLL_MS)
    await loop.whenIdle()
  }
  const observed = () =>
    bus.published.filter((e): e is SessionObserved => e.type === 'SessionObserved')
  const observedIdentities = () => observed().map((e) => e.payload.identity)
  /** The stream position stored for the source at `path`. */
  const cursorAt = async (path: string) => {
    const source = (await adapter.discover(fs)).find((s) => s.path === path)
    expect(source, path).toBeDefined()
    return { stored: cursors.get(source!.streamId)?.value ?? null, size: source!.size }
  }
  return {
    deps,
    transactions,
    dwarfs,
    sessions,
    ended,
    sink,
    bus,
    clock,
    adapter,
    loop,
    poll,
    observed,
    observedIdentities,
    cursorAt
  }
}

describe('Claude reconciliation without ghosts (ISSUE-072)', () => {
  it('[INV-36, FM-092] a late write of an ended subagent produces no SessionObserved and no dwarf', async () => {
    const configDir = await tempDir()
    await placeSession(configDir, CWD, ENDED_SESSION, await fixture('task-notifications.jsonl'))
    const w = world(configDir)
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.observedIdentities()).toEqual([claude(ENDED_SESSION)])
    // Crew's route makes the session's dwarf; the next cycle writes the batch and its endings.
    w.dwarfs.bind(claude(ENDED_SESSION), CWD as FolderPath, T0)
    await w.poll()

    // Every ending of the three delivery envelopes joined the ledger; a quotation ended nobody (#64).
    for (const agent of ['c3d4e5f60718293ab', 'f6071829304152de6', 'e5f607182930415cd']) {
      expect(w.ended.has(claude(ENDED_SESSION, agent)), agent).toBe(true)
    }
    expect(w.ended.has(claude(ENDED_SESSION, 'd4e5f6071829304bc'))).toBe(false)
    expect(w.ended.has(claude(ENDED_SESSION))).toBe(false)

    // The ended subagent's transcript is flushed after its ending (FM-092).
    const late = await placeSubagent(
      configDir,
      CWD,
      ENDED_SESSION,
      'c3d4e5f60718293ab',
      await fixture('ended-subagent.jsonl'),
      await fixture('ended-subagent.meta.json')
    )
    const before = w.bus.published.length
    await w.poll()
    await w.poll()

    // No event of any kind for it, no dwarf, nothing written: only its cursor moved (S4.40).
    const ghost = claude(ENDED_SESSION, 'c3d4e5f60718293ab')
    const after = w.bus.published.slice(before)
    expect(after.filter((e) => JSON.stringify(e.payload).includes('c3d4e5f60718293ab'))).toEqual([])
    expect(w.observedIdentities()).not.toContainEqual(ghost)
    expect(w.dwarfs.bound(ghost)).toBeNull()
    expect(w.sessions.byIdentity(ghost)).toBeNull()
    expect(w.sink.applied.flatMap((b) => b.entries).map((e) => e.providerAgentId)).not.toContain(
      'c3d4e5f60718293ab'
    )
    const position = await w.cursorAt(late)
    expect(position.stored).toBe(position.size)
    w.loop.stop()
  })

  it('[S3.22] a late write of a session ended by Remove mine does not rediscover the removed mine', async () => {
    const configDir = await tempDir()
    const w = world(configDir)
    // Remove mine ended both sessions; the terminator bridge recorded each (ADR-014 item 7) and
    // the mine's dwarfs are gone with it.
    const at = T0 - 60_000
    w.loop.recordEnded(claude(PLAIN_SESSION), at)
    w.loop.recordEnded(claude(SUBAGENT_SESSION), at)
    w.loop.recordEnded(claude(PLAIN_SESSION), at + 1)
    expect(w.ended.records).toEqual([
      { identity: claude(PLAIN_SESSION), at },
      { identity: claude(SUBAGENT_SESSION), at }
    ])

    // The session writes late, and so does a subagent of the other one (its process tree ended
    // with its session).
    const root = await placeSession(
      configDir,
      CWD,
      PLAIN_SESSION,
      await fixture('plain-session.jsonl')
    )
    const subagent = await placeSubagent(
      configDir,
      POSIX_CWD,
      SUBAGENT_SESSION,
      WORKER,
      await fixture('subagent.jsonl'),
      await fixture('subagent.meta.json')
    )
    w.loop.start()
    await w.loop.whenIdle()
    await w.poll()

    // No SessionObserved: the route that would resolve the removed mine's folder never runs.
    expect(w.observed()).toEqual([])
    expect(w.bus.published).toEqual([])
    expect(w.sink.applied).toEqual([])
    for (const path of [root, subagent]) {
      const position = await w.cursorAt(path)
      expect(position.stored, path).toBe(position.size)
    }
    w.loop.stop()
  })

  it('[ADR-029] a nested subagent buried under same-tick attachments is found by the sidecar sweep', async () => {
    const configDir = await tempDir()
    // The worker's own transcript carries no launch record of the nested agent: only the
    // sidecar names its parent (#391).
    await placeSubagent(
      configDir,
      POSIX_CWD,
      SUBAGENT_SESSION,
      WORKER,
      await fixture('subagent.jsonl'),
      await fixture('subagent.meta.json')
    )
    await placeSubagent(
      configDir,
      POSIX_CWD,
      SUBAGENT_SESSION,
      NESTED,
      await fixture('nested-subagent.jsonl'),
      await fixture('nested-subagent.meta.json')
    )
    const w = world(configDir)
    w.loop.start()
    await w.loop.whenIdle()

    const parents = new Map(
      w.observed().map((e) => [e.payload.identity.providerAgentId, e.payload.parentIdentity])
    )
    // Depth through the parent chain (#157): the worker hangs off the session, the nested agent
    // off the worker that launched it.
    expect(parents.get(WORKER)).toEqual(claude(SUBAGENT_SESSION))
    expect(parents.get(NESTED)).toEqual(claude(SUBAGENT_SESSION, WORKER))
    w.loop.stop()
  })

  it('[ADR-029] a pid reused by another process within the tolerance is not taken for the recorded session', async () => {
    const configDir = await tempDir()
    await mkdir(join(configDir, 'sessions'), { recursive: true })
    await writeFile(
      join(configDir, 'sessions', '32896.json'),
      await fixture('session-registry.json')
    )
    // The registry's procStart, a Windows FILETIME, in epoch ms.
    const recorded = 1_788_001_972_136
    const identityWhen = async (probe: ProcessIdentity | 'absent' | 'unknown') => {
      const processes = new FakeProcessControl({ bootId: 'boot-a' })
      processes.script(32896, probe)
      const w = world(configDir, processes)
      await w.adapter.discover(w.deps.fs)
      return w.adapter.processIdentityOf(claude(PLAIN_SESSION))
    }
    const live = (startMs: number): ProcessIdentity => ({
      pid: 32896,
      processStartTimeMs: startMs,
      bootId: 'boot-a'
    })
    const taken: ProcessIdentity = live(recorded)

    // The kernel's one tolerance decides (TC-072-03): at it the pid is the session's process …
    expect(await identityWhen(live(recorded + PROCESS_START_TOLERANCE_MS))).toEqual(taken)
    expect(await identityWhen(live(recorded - PROCESS_START_TOLERANCE_MS))).toEqual(taken)
    // … one millisecond past it the pid names another process: not taken (#45).
    expect(await identityWhen(live(recorded + PROCESS_START_TOLERANCE_MS + 1))).toBeNull()
    expect(await identityWhen(live(recorded - PROCESS_START_TOLERANCE_MS - 1))).toBeNull()
    // Nothing runs on the pid: not taken.
    expect(await identityWhen('absent')).toBeNull()

    // No answer: the #45 guard stands aside (its own polarity) and keeps the registry's record …
    const unknown = await identityWhen('unknown')
    expect(unknown).toEqual({ pid: 32896, processStartTimeMs: recorded, bootId: 'boot-a' })
    // … which the kernel's #231 polarity never takes for the running process before a kill.
    expect(matchesRecorded('unknown', unknown!)).toBe(false)

    // A subagent runs inside its session's process and has no process of its own.
    const processes = new FakeProcessControl({ bootId: 'boot-a' })
    processes.script(32896, live(recorded))
    const w = world(configDir, processes)
    await w.adapter.discover(w.deps.fs)
    expect(w.adapter.processIdentityOf(claude(PLAIN_SESSION, WORKER))).toBeNull()
    expect(w.adapter.processIdentityOf(claude(SUBAGENT_SESSION))).toBeNull()
  })

  it('[ADR-014] an observed Claude dwarf answers the process identity the #45 guard took', async () => {
    const configDir = await tempDir()
    await placeSession(configDir, CWD, PLAIN_SESSION, await fixture('plain-session.jsonl'))
    await mkdir(join(configDir, 'sessions'), { recursive: true })
    await writeFile(
      join(configDir, 'sessions', '32896.json'),
      await fixture('session-registry.json')
    )
    const processes = new FakeProcessControl({ bootId: 'boot-a' })
    processes.script(32896, { pid: 32896, processStartTimeMs: 1_788_001_972_500, bootId: 'boot-a' })
    const w = world(configDir, processes)
    const observation = createObservation({ ...w.deps, processRegistries: [w.adapter] })
    const dwarfId = w.dwarfs.bind(claude(PLAIN_SESSION), CWD as FolderPath, T0)
    expect(observation.processIdentities.processIdentityOf(dwarfId)).toBeNull()

    observation.control.start()
    await observation.whenIdle()

    expect(observation.processIdentities.processIdentityOf(dwarfId)).toEqual({
      pid: 32896,
      processStartTimeMs: 1_788_001_972_136,
      bootId: 'boot-a'
    })
    observation.control.stop()
  })

  it('[C-16] a resumed session with a new id keeps the previous id as previousProviderSessionId and its replayed messages add zero rows', async () => {
    const configDir = await tempDir()
    const plain = await fixture('plain-session.jsonl')
    await placeSession(configDir, CWD, PLAIN_SESSION, plain)
    const w = world(configDir)
    w.loop.start()
    await w.loop.whenIdle()
    w.dwarfs.bind(claude(PLAIN_SESSION), CWD as FolderPath, T0)
    await w.poll()
    const keys = () => new Set(w.sink.applied.flatMap((b) => b.entries.map((e) => e.sourceKey)))
    const units = () => new Set(w.sink.applied.flatMap((b) => b.usage.map((u) => u.sourceKey)))
    const keysBefore = keys()
    const unitsBefore = units()
    expect(keysBefore.size).toBeGreaterThan(0)

    // The person resumes it in their own terminal: Claude Code writes a new session id whose
    // transcript replays the previous session's records before its own (FM-145).
    const resumed = Buffer.concat([plain, await fixture('resumed-session.jsonl')])
    const path = await placeSession(configDir, CWD, RESUMED_SESSION, resumed)
    await w.poll()

    // A new dwarf for the new id (S4.41) that keeps the link to the session it continues.
    expect(w.observedIdentities()).toEqual([claude(PLAIN_SESSION), claude(RESUMED_SESSION)])
    const source = (await w.adapter.discover(w.deps.fs)).find((s) => s.path === path)!
    const read = await w.adapter.read(source, null)
    const sessions = read.events.flatMap((e) => (e.kind === 'session' ? [e] : []))
    expect(sessions.map((e) => [e.identity, e.previousProviderSessionId])).toEqual([
      [claude(RESUMED_SESSION), PLAIN_SESSION]
    ])

    w.dwarfs.bind(claude(RESUMED_SESSION), CWD as FolderPath, T0)
    await w.poll()
    // The replayed messages carry the keys they were written with: zero new rows, zero new usage.
    const added = [...keys()].filter((k) => !keysBefore.has(k))
    expect(added).toEqual([
      `claude:claude:${RESUMED_SESSION}:00000000-0000-4000-8000-000000071701`,
      `claude:claude:${RESUMED_SESSION}:00000000-0000-4000-8000-000000071702`
    ])
    expect([...units()].filter((k) => !unitsBefore.has(k))).toEqual([
      `claude:claude:${RESUMED_SESSION}:msg_01ResumedSessionA`
    ])
    w.loop.stop()
  })

  it('[C-16, INV-36] a resumed transcript never announces the session it replays', async () => {
    const configDir = await tempDir()
    // The previous session was never observed (it predates the Host): its replayed records must
    // not make a dwarf of it.
    const resumed = Buffer.concat([
      await fixture('plain-session.jsonl'),
      await fixture('resumed-session.jsonl')
    ])
    const path = await placeSession(configDir, CWD, RESUMED_SESSION, resumed)
    const w = world(configDir)
    w.loop.start()
    await w.loop.whenIdle()
    expect(w.observedIdentities()).toEqual([claude(RESUMED_SESSION)])

    // Once the new session's dwarf exists, the whole transcript is its own, and the stream is
    // never held for a dwarf that will not come.
    w.dwarfs.bind(claude(RESUMED_SESSION), CWD as FolderPath, T0)
    await w.poll()
    expect(w.observedIdentities()).toEqual([claude(RESUMED_SESSION)])
    expect(new Set(w.sink.applied.map((b) => b.dwarfId)).size).toBe(1)
    const position = await w.cursorAt(path)
    expect(position.stored).toBe(position.size)
    w.loop.stop()
  })
})

describe('Claude sessions close once their recorded process is gone (FM-059)', () => {
  // The registry's procStart, a Windows FILETIME, in epoch ms.
  const RECORDED = 1_788_001_972_136
  const running = (startMs: number = RECORDED): ProcessIdentity => ({
    pid: 32896,
    processStartTimeMs: startMs,
    bootId: 'boot-a'
  })

  /** A registered Claude session whose recorded process runs, observed until its dwarf is present. */
  async function presentSession(configDir: string) {
    await placeSession(configDir, CWD, PLAIN_SESSION, await fixture('plain-session.jsonl'))
    await mkdir(join(configDir, 'sessions'), { recursive: true })
    await writeFile(
      join(configDir, 'sessions', '32896.json'),
      await fixture('session-registry.json')
    )
    const processes = new FakeProcessControl({ bootId: 'boot-a' })
    processes.script(32896, running())
    const w = world(configDir, processes)
    w.loop.start()
    await w.loop.whenIdle()
    w.dwarfs.bind(claude(PLAIN_SESSION), CWD as FolderPath, T0)
    await w.poll()
    expect(w.sessions.byIdentity(claude(PLAIN_SESSION))?.closedAt).toBeNull()
    const closings = () =>
      w.bus.published.flatMap((e) => (e.type === 'SessionClosedObserved' ? [e.payload] : []))
    expect(closings()).toEqual([])
    return { w, processes, closings }
  }

  it('[FM-059, S4.33] a Claude session whose recorded process was killed closes within one observation cycle although its registry entry stays', async () => {
    const { w, processes, closings } = await presentSession(await tempDir())

    // The process is ended (an identity-checked kill); Claude Code's registry entry outlives it.
    processes.script(32896, 'absent')
    await w.poll()

    expect(closings().map((c) => c.identity)).toEqual([claude(PLAIN_SESSION)])
    expect(w.sessions.byIdentity(claude(PLAIN_SESSION))?.closedAt).not.toBeNull()
    expect(w.ended.has(claude(PLAIN_SESSION))).toBe(true)
    expect(w.adapter.processIdentityOf(claude(PLAIN_SESSION))).toBeNull()

    // It closes once: later cycles state the same ending and publish nothing new (INV-36).
    await w.poll()
    await w.poll()
    expect(closings()).toHaveLength(1)
    w.loop.stop()
  })

  it('[US-OBS-005.AC01] a Claude session whose recorded process still runs stays present', async () => {
    const { w, processes, closings } = await presentSession(await tempDir())
    for (let n = 0; n < 5; n++) await w.poll()
    expect(closings()).toEqual([])
    expect(w.adapter.processIdentityOf(claude(PLAIN_SESSION))).toEqual(running())

    // A probe with no answer is no evidence that it ended: presence fails open (#45 polarity).
    processes.script(32896, 'unknown')
    for (let n = 0; n < 3; n++) await w.poll()
    expect(closings()).toEqual([])
    expect(w.sessions.byIdentity(claude(PLAIN_SESSION))?.closedAt).toBeNull()
    w.loop.stop()
  })

  it('[FM-059, ADR-014] a pid reused by another process after the session ended closes the session within the identity recheck bound', async () => {
    const { w, processes, closings } = await presentSession(await tempDir())

    // The session's process ended and another process now runs on its pid, between two cycles,
    // so the cheap existence check keeps answering running: a bare pid is no evidence of the
    // session (INV-51), only the pid with its recorded start is, read at most every
    // IDENTITY_RECHECK_MS (owner amendment H). Presence is not destructive: every kill re-checks.
    const reusedAt = w.clock.now()
    processes.script(32896, running(RECORDED + PROCESS_START_TOLERANCE_MS + 1))
    for (let n = 0; n < IDENTITY_RECHECK_MS / OBSERVATION_POLL_MS && closings().length === 0; n++) {
      await w.poll()
    }

    expect(closings().map((c) => c.identity)).toEqual([claude(PLAIN_SESSION)])
    expect(w.clock.now() - reusedAt).toBeLessThanOrEqual(IDENTITY_RECHECK_MS)
    expect(w.adapter.processIdentityOf(claude(PLAIN_SESSION))).toBeNull()
    w.loop.stop()
  })

  it('[FM-059, ADR-014] a live session is identity-checked at most once per IDENTITY_RECHECK_MS, not every cycle', async () => {
    const { w, processes, closings } = await presentSession(await tempDir())

    // 60 s of cycles: the cheap existence check runs every cycle, the start-time query does not.
    for (let n = 0; n < 60_000 / OBSERVATION_POLL_MS; n++) await w.poll()

    const queries = processes.probed.filter((pid) => pid === 32896).length
    expect(queries).toBeGreaterThanOrEqual(2)
    expect(queries).toBeLessThanOrEqual(3)
    expect(closings()).toEqual([])
    w.loop.stop()
  })

  it('[FM-059] a Claude session that left the registry closes once its recorded process is gone', async () => {
    const configDir = await tempDir()
    const { w, processes, closings } = await presentSession(configDir)

    // Its registry entry goes while its process still runs (a rewrite in flight): still present,
    // with no identity to end it by (15 §5: registry file gone → no-identity).
    await rm(join(configDir, 'sessions', '32896.json'))
    await w.poll()
    expect(closings()).toEqual([])
    expect(w.adapter.processIdentityOf(claude(PLAIN_SESSION))).toBeNull()

    processes.script(32896, 'absent')
    await w.poll()
    expect(closings().map((c) => c.identity)).toEqual([claude(PLAIN_SESSION)])
    w.loop.stop()
  })
})
