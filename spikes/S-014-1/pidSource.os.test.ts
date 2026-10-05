// L8 OS lane (17 §1.8, §4) for spike S-014-1 (ADR-014 item 2): the candidate pid source against real processes of
// this OS. The processes are stubs (`stub/codex.cjs`, the sleeper), never provider CLIs. Runs on every OS through
// `pnpm test:os`; CI runs it on Windows, macOS and Linux. If the spike passes, this harness stays as the identity test
// ADR-014 switches to (TC-319-03).
//
// Modes (environment):
//   S0141_MODE=real   the maintainer-machine measurement (17 §5.5): the person starts the real provider CLI in a
//                     throwaway folder; the test lists the processes, attributes the session and records the outcome
//                     without asserting it. Needs S0141_STEMS (comma-separated, e.g. `codex`), S0141_CWD (the
//                     throwaway folder) and S0141_SESSION_START (the session's first record, ISO 8601 or epoch ms).
//                     Only stems, counts, outcomes and millisecond gaps are recorded: never a pid, a path or a name.
//   S0141_REPORT      a file to write the JSON report to (the stub run's, or the real run's); or SPIKE_REPORT_DIR, which
//                     writes <dir>/S-014-1-<platform>-<mode>.json (CI uploads that folder as spike-evidence-<os>).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { NodeProcessControl } from '../../src/host/platform/process/NodeProcessControl'
import type { ProcessIdentity } from '../../src/host/kernel/domain/processIdentity'
import {
  ATTRIBUTION_WINDOW_MS,
  attributeSession,
  isProviderProcess,
  listProcesses,
  sameFolder,
  stemsOf,
  type Attribution,
  type ObservedSession,
  type ProcessFacts,
  type ProviderMatcher
} from './pidSource'

const here = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(here, 'stub', 'codex.cjs')
const SLEEPER = path.resolve(here, '..', '..', 'fixtures', 'bin', 'sleeper', 'sleeper.mjs')
const CODEX: ProviderMatcher = { stems: ['codex'] }
const mode = process.env['S0141_MODE'] ?? 'stub'
const reportDir = process.env['SPIKE_REPORT_DIR']
const reportFile =
  process.env['S0141_REPORT'] ??
  (reportDir ? path.resolve(reportDir, `S-014-1-${process.platform}-${mode}.json`) : undefined)

const started: ChildProcessWithoutNullStreams[] = []

/** Starts a process in `cwd`; resolves once it printed its first line (the stub's `ready`), or, for a process that
 * prints nothing (the sleeper), once it spawned. */
function start(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  readyOn: 'line' | 'spawn' = 'line'
): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    stdio: 'pipe',
    windowsHide: true
  })
  started.push(child)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    if (readyOn === 'spawn') child.once('spawn', () => resolve(child.pid as number))
    else child.stdout.once('data', () => resolve(child.pid as number))
  })
}

/** The session a Codex observer would read from a stub's `session_meta` line. */
function readSession(file: string): ObservedSession {
  const line = JSON.parse(readFileSync(file, 'utf8').split('\n')[0] as string) as {
    payload: { cwd: string; timestamp: string }
  }
  return { cwd: line.payload.cwd, startedAtMs: Date.parse(line.payload.timestamp) }
}

/** This boot's id, as the production probe reads it. */
async function bootIdOf(control: NodeProcessControl): Promise<string> {
  const self = await control.probe(process.pid)
  if (self === 'absent' || self === 'unknown') throw new Error(`the probe of this process: ${self}`)
  return self.bootId
}

function writeReport(report: object): void {
  if (reportFile === undefined || reportFile === '') return
  mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true })
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
}

const shape = (attribution: Attribution): string =>
  attribution.kind === 'identity'
    ? 'identity'
    : `no-identity:${attribution.reason}:${attribution.candidates}`

/** Ends every started process (stdin end, then a kill after 5 s) and waits for each exit. */
async function stopAll(): Promise<void> {
  await Promise.all(
    started.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 5_000)
      await exited
      clearTimeout(timer)
    })
  )
}

describe.runIf(mode === 'stub')('S-014-1 pid source over stub processes (L8)', () => {
  let root = ''
  afterAll(async () => {
    // A running process holds its working folder on Windows: end them all before the folder goes.
    await stopAll()
    if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  it('[S-014-1, ADR-014] the pid source attributes exactly one provider process to one observed fixture session or reports no identity', async () => {
    // macOS reports a working folder by its real path (/private/var/…), so the folders are named that way.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dwarfai-s0141-')))
    const folder = (name: string): string => {
      const dir = path.join(root, name)
      mkdirSync(dir)
      return dir
    }
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(folder) as [string, string, string, string]
    const sessionFile = (dir: string, name = 'session.jsonl'): string => path.join(dir, name)

    // a: a provider wrapper with its same-stem child, beside a non-provider process in the same folder.
    // b: one provider process. c: two provider processes started together. d: no provider process at all.
    const pidA = await start([STUB], a, { S0141_SESSION_FILE: sessionFile(a), S0141_CHILD: '1' })
    await start([SLEEPER, 'sleep', '30000'], a, {}, 'spawn')
    const pidB = await start([STUB], b, { S0141_SESSION_FILE: sessionFile(b) })
    await Promise.all([
      start([STUB], c, { S0141_SESSION_FILE: sessionFile(c, 'one.jsonl') }),
      start([STUB], c, { S0141_SESSION_FILE: sessionFile(c, 'two.jsonl') })
    ])
    await start([SLEEPER, 'sleep', '30000'], d, {}, 'spawn')

    const control = new NodeProcessControl()
    const bootId = await bootIdOf(control)
    const listedAt = Date.now()
    const rows = await listProcesses(process.platform, CODEX)
    const listingMs = Date.now() - listedAt

    const sessionA = readSession(sessionFile(a))
    const sessionB = readSession(sessionFile(b))
    const sessionC = readSession(sessionFile(c, 'one.jsonl'))
    // A session in b whose first record lies a minute after b's process started: not that process's session.
    const staleB: ObservedSession = { cwd: b, startedAtMs: sessionB.startedAtMs + 60_000 }
    const sessionD: ObservedSession = { cwd: d, startedAtMs: Date.now() }

    const outcomes = {
      a: attributeSession(sessionA, rows, CODEX, bootId),
      b: attributeSession(sessionB, rows, CODEX, bootId),
      c: attributeSession(sessionC, rows, CODEX, bootId),
      staleB: attributeSession(staleB, rows, CODEX, bootId),
      d: attributeSession(sessionD, rows, CODEX, bootId)
    }
    const startOf = (pid: number): number | null =>
      rows.find((row) => row.pid === pid)?.startTimeMs ?? null
    writeReport({
      spike: 'S-014-1',
      mode,
      platform: process.platform,
      osRelease: release(),
      node: process.versions.node,
      windowMs: ATTRIBUTION_WINDOW_MS,
      listingMs,
      processesListed: rows.length,
      providerRowsListed: rows.filter((row) => isProviderProcess(row, CODEX)).length,
      providerRowsWithCwd: rows.filter((row) => isProviderProcess(row, CODEX) && row.cwd !== null)
        .length,
      sessionStartAfterProcessStartMs: {
        a: sessionA.startedAtMs - (startOf(pidA) ?? Number.NaN),
        b: sessionB.startedAtMs - (startOf(pidB) ?? Number.NaN)
      },
      outcomes: Object.fromEntries(
        Object.entries(outcomes).map(([key, value]) => [key, shape(value)])
      )
    })

    // One identity each for a (the wrapper, never its child) and b, re-proved by the production probe.
    for (const [name, outcome, pid] of [
      ['a', outcomes.a, pidA],
      ['b', outcomes.b, pidB]
    ] as const) {
      expect(outcome, `session ${name} is attributed to its own root process`).toEqual({
        kind: 'identity',
        identity: expect.objectContaining({ pid, bootId })
      })
      const probed = await control.probe(pid)
      expect(probed, `the probe of session ${name}'s process`).not.toBe('absent')
      expect(
        control.sameProcess(
          probed as ProcessIdentity,
          (outcome as { identity: ProcessIdentity }).identity
        ),
        `the attributed identity of session ${name} is the running process (ADR-015 item 1)`
      ).toBe(true)
    }
    expect(outcomes.c, 'two provider processes in one folder within the window').toEqual({
      kind: 'no-identity',
      reason: 'ambiguous',
      candidates: 2
    })
    expect(outcomes.staleB, 'a session whose start lies outside the window').toEqual({
      kind: 'no-identity',
      reason: 'no-candidate',
      candidates: 0
    })
    expect(outcomes.d, 'a folder with no provider process').toEqual({
      kind: 'no-identity',
      reason: 'no-candidate',
      candidates: 0
    })
  }, 60_000)
})

describe.runIf(mode === 'real')(
  'S-014-1 pid source over a real provider CLI (real-CLI lane, 17 §5.5)',
  () => {
    it('[S-014-1] records whether the pid source attributes the real provider session, without asserting it', async () => {
      const stems = (process.env['S0141_STEMS'] ?? '').split(',').map((stem) => stem.trim())
      const cwd = process.env['S0141_CWD'] ?? ''
      const startText = process.env['S0141_SESSION_START'] ?? ''
      const startedAtMs = /^\d+$/.test(startText) ? Number(startText) : Date.parse(startText)
      expect(stems.filter(Boolean), 'S0141_STEMS names the provider').not.toEqual([])
      expect(cwd, 'S0141_CWD names the throwaway folder').not.toBe('')
      expect(Number.isFinite(startedAtMs), 'S0141_SESSION_START is an instant').toBe(true)
      const matcher: ProviderMatcher = { stems: stems.filter(Boolean) }

      const control = new NodeProcessControl()
      const bootId = await bootIdOf(control)
      const rows = await listProcesses(process.platform, matcher)
      const outcome = attributeSession({ cwd, startedAtMs }, rows, matcher, bootId)
      const providerRows = rows.filter((row) => isProviderProcess(row, matcher))
      const byPid = new Map(rows.map((row) => [row.pid, row]))
      const inFolder = providerRows.filter(
        (row) => row.cwd !== null && sameFolder(row.cwd, cwd, process.platform)
      )
      const describeRow = (row: ProcessFacts): object => ({
        stems: stemsOf(row),
        parentIsProvider:
          byPid.has(row.ppid) && isProviderProcess(byPid.get(row.ppid) as ProcessFacts, matcher),
        cwdRead: row.cwd !== null,
        sessionStartAfterProcessStartMs:
          row.startTimeMs === null ? null : startedAtMs - row.startTimeMs
      })
      writeReport({
        spike: 'S-014-1',
        mode,
        platform: process.platform,
        osRelease: release(),
        node: process.versions.node,
        stems: matcher.stems,
        windowMs: ATTRIBUTION_WINDOW_MS,
        processesListed: rows.length,
        providerRows: providerRows.length,
        providerRowsWithCwd: providerRows.filter((row) => row.cwd !== null).length,
        providerRowsInFolder: inFolder.map(describeRow),
        outcome: shape(outcome)
      })
      expect(['identity', 'no-identity']).toContain(outcome.kind)
    }, 60_000)
  }
)
