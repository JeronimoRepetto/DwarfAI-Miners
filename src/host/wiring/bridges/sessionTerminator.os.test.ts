// L8 OS lane (17 §1.8): the `SessionTerminator` bridge over the real kernel `NodeProcessControl`
// (ADR-014 items 2–3, 7). An observed fixture session is a stub tree the test starts itself
// (fixtures/bin/tree): a "terminal" that starts the session's root, which starts a child and a
// grandchild. Runs only in `pnpm test:os`, one describe per OS. Every process here is the test's
// own; the cleanup ends only those whose identity still matches (never a bare pid), and waits for
// each to exit before removing its folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  matchesRecorded,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type { DwarfId, Instant, MineId, ProviderIdentity } from '../../kernel/domain/values'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { NodeProcessControl } from '../../platform/process/NodeProcessControl'
import { createSessionTerminator } from './sessionTerminator'

const TREE = fileURLToPath(new URL('../../../../fixtures/bin/tree/tree.mjs', import.meta.url))
const CAP_MS = 60_000
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId

type Role = 'terminal' | 'root' | 'child' | 'grandchild'
const ROLES: readonly Role[] = ['terminal', 'root', 'child', 'grandchild']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function terminatorCases(): void {
  const control = new NodeProcessControl()
  const started: ProcessIdentity[] = []
  const spawned: SpawnedProcess[] = []
  const folders: string[] = []

  afterEach(async () => {
    // End every process this test started whose identity still matches, then wait for each to go.
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

  /** Starts the stub "terminal" and waits until it and the session below it recorded their pids. */
  async function startObservedSession(): Promise<Record<Role, ProcessIdentity>> {
    const folder = mkdtempSync(join(tmpdir(), 'dwarfai-terminator-'))
    folders.push(folder)
    const record = join(folder, 'pids.txt')
    spawned.push(
      control.spawn({
        executable: process.execPath,
        args: [TREE, 'terminal', record, String(CAP_MS)],
        env: {},
        cwd: dirname(TREE),
        processGroup: 'own',
        stdio: 'ignore'
      })
    )
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
    return tree
  }

  it('[ADR-014] the tree of an observed fixture session is ended, child and grandchild included, and a reused pid is never signalled', async () => {
    const tree = await startObservedSession()
    const crew = inMemoryCrew()
    const identities = new Map<DwarfId, ProcessIdentity>()
    const recorded: { identity: ProviderIdentity; at: Instant }[] = []
    const terminator = createSessionTerminator({
      crew: crew.queries,
      observed: { processIdentityOf: (dwarfId) => identities.get(dwarfId) ?? null },
      processes: control,
      endedLedger: { recordEnded: (identity, at) => recorded.push({ identity, at }) },
      clock: crew.clock
    })
    const seat = (providerSessionId: string, identity: ProcessIdentity): DwarfId => {
      const dwarfId = crew.commands.arrive({
        mineId: MINE,
        identity: { providerId: 'claude', providerSessionId },
        rank: rankForDepth(0),
        status: 'idle'
      })
      identities.set(dwarfId, identity)
      return dwarfId
    }
    // A dwarf whose recorded identity names the root's pid with a start time outside the one
    // tolerance: the pid now belongs to another process, which must never be signalled.
    const reused = seat('session-reused', {
      ...tree.root,
      processStartTimeMs: tree.root.processStartTimeMs - PROCESS_START_TOLERANCE_MS - 1
    })
    const observed = seat('session-observed', tree.root)

    expect(await terminator.end(reused, 'stop-dwarf')).toEqual({ kind: 'ended' })
    for (const role of ROLES) {
      expect({
        role,
        running: matchesRecorded(await control.probe(tree[role].pid), tree[role])
      }).toEqual({ role, running: true })
    }

    expect(await terminator.end(observed, 'remove-mine')).toEqual({ kind: 'ended' })
    // `ended` only after the root's exit was observed: it is gone at once.
    expect(matchesRecorded(await control.probe(tree.root.pid), tree.root)).toBe(false)
    expect(await stillRuns(tree.child)).toBe(false)
    expect(await stillRuns(tree.grandchild)).toBe(false)
    // The person's terminal is not part of the session and survives (no group signal).
    expect(matchesRecorded(await control.probe(tree.terminal.pid), tree.terminal)).toBe(true)
    expect(recorded.map((r) => r.identity.providerSessionId)).toContain('session-observed')
  }, 60_000)
}

describe.runIf(process.platform === 'win32')('SessionTerminator bridge on Windows', terminatorCases)
describe.runIf(process.platform === 'darwin')('SessionTerminator bridge on macOS', terminatorCases)
describe.runIf(process.platform === 'linux')('SessionTerminator bridge on Linux', terminatorCases)
