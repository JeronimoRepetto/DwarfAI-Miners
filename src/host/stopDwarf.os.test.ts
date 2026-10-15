// layer: L8
// L8 OS lane (17 §1.8; ADR-014 items 1–3; 07 machine 15 S15.05–S15.10; TC-171-03): "Stop dwarf…" of
// an owned session mid-turn, through crew's `stop` and the `SessionTerminator` bridge over the real
// kernel `NodeProcessControl`. The owned session is a stub tree the test launches as the Host
// launches a session — the leader of its own process group (fixtures/bin/tree: a root that starts a
// child and a grandchild). Its driver is a double whose turn is open and whose close ends nothing,
// so only the identity-checked tree kill can end the tree. Runs only in `pnpm test:os`, one describe
// per OS. Every process here is the test's own; the cleanup ends only those whose identity still
// matches (never a bare pid), and waits for each to exit before removing its folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { matchesRecorded, type ProcessIdentity } from './kernel/domain/processIdentity'
import type { DwarfId, MineId } from './kernel/domain/values'
import { RecordingEventBus } from './kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from './kernel/fakes/SequenceIdGenerator'
import type { SpawnedProcess } from './kernel/ports/processControl'
import { CrewStop, rankForDepth, type CrewEndEvent } from './modules/crew'
import { CREW_EPOCH, inMemoryCrew } from './modules/crew/testing/inMemoryCrew'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { NodeProcessControl } from './platform/process/NodeProcessControl'
import { createSessionTerminator, type OwnedSession } from './wiring/bridges/sessionTerminator'

const TREE = fileURLToPath(new URL('../../fixtures/bin/tree/tree.mjs', import.meta.url))
const CAP_MS = 60_000
const MINE = '00000000-0000-7000-8000-0000000001f1' as MineId
const REQUEST = '01890a5d-ac96-774b-bcce-000000001718'

type Role = 'root' | 'child' | 'grandchild'
const ROLES: readonly Role[] = ['root', 'child', 'grandchild']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A driver session mid-turn whose interrupt and close end nothing: the provider ignores both. */
class StubbornDriver {
  readonly calls: string[] = []
  interrupt(): Promise<void> {
    this.calls.push('interrupt')
    return Promise.resolve()
  }
  close(mode: 'detach' | 'end-thread'): Promise<{ kind: 'failed'; reason: 'timeout' }> {
    this.calls.push(`close:${mode}`)
    return Promise.resolve({ kind: 'failed', reason: 'timeout' })
  }
}

function stopCases(): void {
  const control = new NodeProcessControl()
  const started: ProcessIdentity[] = []
  const spawned: SpawnedProcess[] = []
  const folders: string[] = []

  afterEach(async () => {
    const mine = started.splice(0)
    for (const identity of mine) {
      if (matchesRecorded(await control.probe(identity.pid), identity)) {
        try {
          process.kill(identity.pid, 'SIGKILL')
        } catch {
          // it ended meanwhile
        }
      }
    }
    for (const identity of mine) await stillRuns(identity, 10_000)
    await Promise.all(spawned.splice(0).map((child) => Promise.race([child.exited, sleep(10_000)])))
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  /** Whether the process of `identity` still runs, waiting up to `ms` for it to go. */
  async function stillRuns(identity: ProcessIdentity, ms = 3_000): Promise<boolean> {
    const deadline = Date.now() + ms
    for (;;) {
      if (!matchesRecorded(await control.probe(identity.pid), identity)) return false
      if (Date.now() >= deadline) return true
      await sleep(100)
    }
  }

  /** Launches the stub session as the Host does (its own process group) and reads its tree. */
  async function launchOwnedSession(): Promise<Record<Role, ProcessIdentity>> {
    const folder = mkdtempSync(join(tmpdir(), 'dwarfai-stop-'))
    folders.push(folder)
    const record = join(folder, 'pids.txt')
    const launched = control.spawn({
      executable: process.execPath,
      args: [TREE, 'root', record, String(CAP_MS)],
      env: {},
      cwd: dirname(TREE),
      processGroup: 'own',
      stdio: 'ignore'
    })
    spawned.push(launched)
    const deadline = Date.now() + 15_000
    let pids = new Map<string, number>()
    while (Date.now() < deadline) {
      let text = ''
      try {
        text = readFileSync(record, 'utf8')
      } catch {
        // not written yet
      }
      pids = new Map(
        text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => {
            const [role, pid] = line.trim().split(' ')
            return [role as string, Number(pid)] as const
          })
      )
      if (ROLES.every((role) => pids.has(role))) break
      await sleep(50)
    }
    const tree = {} as Record<Role, ProcessIdentity>
    for (const role of ROLES) {
      const pid = pids.get(role)
      if (pid === undefined) throw new Error(`the stub tree never recorded its ${role}`)
      const probed = await control.probe(pid)
      if (typeof probed === 'string') throw new Error(`stub ${role} probed as ${probed}`)
      started.push(probed)
      tree[role] = probed
    }
    // The identity the launch recorded right after spawn (15 §1.2 `onSpawned`) is the root's.
    expect(control.sameProcess(await launched.identity, tree.root)).toBe(true)
    return tree
  }

  it('[ADR-014] Stop dwarf mid-turn ends the provider whole process tree identity-checked', async () => {
    const tree = await launchOwnedSession()
    const crew = inMemoryCrew()
    const dwarfId: DwarfId = crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'session-owned-171' },
      rank: rankForDepth(0),
      status: 'working'
    })
    crew.owned.add(dwarfId)
    const driver = new StubbornDriver()
    const session: OwnedSession = { process: tree.root, driver: () => driver }
    const terminator = createSessionTerminator({
      crew: crew.queries,
      observed: { processIdentityOf: () => null },
      processes: control,
      endedLedger: { recordEnded: () => undefined },
      clock: crew.clock,
      scheduler: new NodeScheduler({ onTaskError: () => undefined }),
      owned: () => ({ liveSessionOf: (id) => (id === dwarfId ? session : null) })
    })
    const stop = new CrewStop({
      repository: crew.repository,
      transactions: crew.transactionRunner,
      bus: new RecordingEventBus<CrewEndEvent>(),
      clock: crew.clock,
      ids: new SequenceIdGenerator(),
      hostEpoch: CREW_EPOCH,
      terminator,
      departures: crew.commands
    })
    expect(crew.queries.get(dwarfId)?.status).toBe('working')

    expect(await stop.stop(dwarfId, REQUEST)).toEqual({ ok: true, value: undefined })

    // The driver was asked first (S15.05); its close ended nothing, so the tree kill did.
    expect(driver.calls).toEqual(['interrupt', 'close:end-thread'])
    // `ended` only after the root's exit was observed: it is gone at once.
    expect(matchesRecorded(await control.probe(tree.root.pid), tree.root)).toBe(false)
    expect(await stillRuns(tree.child)).toBe(false)
    expect(await stillRuns(tree.grandchild)).toBe(false)
    expect(crew.queries.get(dwarfId)).toMatchObject({ departed: true, departureCause: 'stopped' })
  }, 60_000)
}

describe.runIf(process.platform === 'win32')('Stop dwarf on Windows', stopCases)
describe.runIf(process.platform === 'darwin')('Stop dwarf on macOS', stopCases)
describe.runIf(process.platform === 'linux')('Stop dwarf on Linux', stopCases)
