// L8 OS lane (17 §1.8): the identity-checked tree kill (ADR-014 items 2–4) against real stub
// processes — a root with a child and a grandchild (fixtures/bin/tree) — one describe per OS. Runs
// only in `pnpm test:os`. Every process here is started by the test; the cleanup ends only those,
// and only after their identity still matches (never a bare pid).
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
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { NodeProcessControl, createQueryRunner } from './NodeProcessControl'
import { createSnapshotReader } from './kill/snapshot'

const TREE = fileURLToPath(new URL('../../../../fixtures/bin/tree/tree.mjs', import.meta.url))
const SLEEPER = fileURLToPath(
  new URL('../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)
const PLATFORM =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
const CAP_MS = 60_000
const OWNED = { graceMs: 3_000, group: 'owned' } as const
const FOREIGN = { graceMs: 3_000, group: 'foreign' } as const

type Role = 'terminal' | 'root' | 'child' | 'grandchild'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function killCases(): void {
  const started: ProcessIdentity[] = []
  const spawned: SpawnedProcess[] = []
  const folders: string[] = []
  const probe = new NodeProcessControl()

  afterEach(async () => {
    // Leave nothing running: end every process this test started whose identity still matches.
    for (const identity of started.splice(0)) {
      if (matchesRecorded(await probe.probe(identity.pid), identity)) {
        try {
          process.kill(identity.pid, 'SIGKILL')
        } catch {
          // it ended meanwhile
        }
      }
    }
    for (const child of spawned.splice(0)) child.stdin?.end()
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  /** The identity of a live pid this test started, remembered for the cleanup. */
  async function identityOf(pid: number): Promise<ProcessIdentity> {
    const probed = await probe.probe(pid)
    if (typeof probed === 'string') throw new Error(`stub pid ${pid} probed as ${probed}`)
    started.push(probed)
    return probed
  }

  /** Starts the stub tree from `top` and waits until every process below it recorded its pid. */
  async function startTree(
    control: NodeProcessControl,
    top: 'terminal' | 'root',
    flags: readonly string[] = []
  ): Promise<Record<Role, ProcessIdentity | undefined>> {
    const folder = mkdtempSync(join(tmpdir(), 'dwarfai-tree-'))
    folders.push(folder)
    const record = join(folder, 'pids.txt')
    const child = control.spawn({
      executable: process.execPath,
      args: [TREE, top, record, String(CAP_MS), ...flags],
      env: {},
      cwd: dirname(TREE),
      // A launched session and a terminal are both leaders of their own process group.
      processGroup: 'own',
      stdio: 'ignore'
    })
    spawned.push(child)
    const roles: Role[] =
      top === 'terminal'
        ? ['terminal', 'root', 'child', 'grandchild']
        : ['root', 'child', 'grandchild']
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
      if (roles.every((role) => pids.has(role))) break
      await sleep(50)
    }
    const tree: Record<Role, ProcessIdentity | undefined> = {
      terminal: undefined,
      root: undefined,
      child: undefined,
      grandchild: undefined
    }
    for (const role of roles) {
      const pid = pids.get(role)
      if (pid === undefined) throw new Error(`the stub tree never recorded its ${role}`)
      tree[role] = await identityOf(pid)
    }
    return tree
  }

  /** Whether the process of `identity` still runs, waiting up to `ms` for it to go. */
  async function stillRuns(identity: ProcessIdentity, ms = 3_000): Promise<boolean> {
    const deadline = Date.now() + ms
    for (;;) {
      if (!matchesRecorded(await probe.probe(identity.pid), identity)) return false
      if (Date.now() >= deadline) return true
      await sleep(100)
    }
  }

  const must = (identity: ProcessIdentity | undefined): ProcessIdentity => {
    if (identity === undefined) throw new Error('missing stub identity')
    return identity
  }

  it('[ADR-014, FM-005] killTree of a stub with a child and a grandchild ends all three and reports ended', async () => {
    const control = new NodeProcessControl()
    const tree = await startTree(control, 'root')
    const root = must(tree.root)

    expect(await control.killTree(root, OWNED)).toEqual({ kind: 'ended' })

    // `ended` only after the root's exit was observed: it is gone at once.
    expect(await probe.probe(root.pid)).toBe('absent')
    expect(await stillRuns(must(tree.child))).toBe(false)
    expect(await stillRuns(must(tree.grandchild))).toBe(false)
  }, 60_000)

  it('[ADR-014] a sibling test process outside the tree is never signalled', async () => {
    const control = new NodeProcessControl()
    const sibling = control.spawn({
      executable: process.execPath,
      args: [SLEEPER, 'sleep', String(CAP_MS)],
      env: {},
      cwd: dirname(SLEEPER),
      processGroup: 'own',
      stdio: 'pipe'
    })
    spawned.push(sibling)
    const siblingIdentity = await identityOf((await sibling.identity).pid)
    const tree = await startTree(control, 'root')

    expect(await control.killTree(must(tree.root), OWNED)).toEqual({ kind: 'ended' })

    expect(matchesRecorded(await probe.probe(siblingIdentity.pid), siblingIdentity)).toBe(true)
  }, 60_000)

  it('[ADR-014, FM-065] a grandchild re-parented before the snapshot is found by the re-scan of the recorded descendants and ended, and the user terminal holding the group survives', async () => {
    const realSnapshot = createSnapshotReader(PLATFORM, { runQuery: createQueryRunner() })
    let childToOrphan: ProcessIdentity | undefined
    // Right after the snapshot the child exits, so the grandchild is re-parented away from the
    // tree before any signal: neither the process group of a foreign session nor taskkill's own
    // parent walk reaches it, only the re-scan of the recorded descendants does.
    const control = new NodeProcessControl({
      snapshot: async () => {
        const rows = await realSnapshot()
        const orphaning = childToOrphan
        childToOrphan = undefined
        if (orphaning !== undefined) {
          process.kill(orphaning.pid, 'SIGKILL')
          while (matchesRecorded(await probe.probe(orphaning.pid), orphaning)) await sleep(50)
        }
        return rows
      }
    })
    const tree = await startTree(control, 'terminal', ['--grandchild-ignores-term'])
    childToOrphan = must(tree.child)

    expect(await control.killTree(must(tree.root), FOREIGN)).toEqual({ kind: 'ended' })

    expect(await stillRuns(must(tree.root), 0)).toBe(false)
    expect(await stillRuns(must(tree.grandchild))).toBe(false)
    const terminal = must(tree.terminal)
    expect(matchesRecorded(await probe.probe(terminal.pid), terminal)).toBe(true)
  }, 60_000)

  it(`[ADR-014] a recorded identity whose start time is off by more than 2 000 ms ends nothing`, async () => {
    const control = new NodeProcessControl()
    const tree = await startTree(control, 'root')
    const root = must(tree.root)
    const recycled = {
      ...root,
      processStartTimeMs: root.processStartTimeMs - PROCESS_START_TOLERANCE_MS - 1
    }

    expect(await control.killTree(recycled, OWNED)).toEqual({ kind: 'ended' })

    for (const role of ['root', 'child', 'grandchild'] as const) {
      const identity = must(tree[role])
      expect({ role, running: matchesRecorded(await probe.probe(identity.pid), identity) }).toEqual(
        {
          role,
          running: true
        }
      )
    }
  }, 60_000)
}

// Threat T-27 of 18 §4.4 (killing the wrong process after pid reuse) is what the identity cases
// prove; threat ids name the describe, never a test title (17 §2.2).
describe.runIf(process.platform === 'win32')('killTree on Windows (threat T-27)', killCases)
describe.runIf(process.platform === 'darwin')('killTree on macOS (threat T-27)', killCases)
describe.runIf(process.platform === 'linux')('killTree on Linux (threat T-27)', killCases)
