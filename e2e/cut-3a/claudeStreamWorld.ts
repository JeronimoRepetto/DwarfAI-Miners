import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.ts'
import { isProcessAlive, profileHostPid, type IsolatedProfile } from '../_harness/launchApp.ts'
import { processStartTimeMs } from '../_harness/processStart.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import {
  seedClaudeStubSession,
  STUB_MINE_NAME,
  STUB_SESSION_ID,
  type ClaudeStubWorld
} from '../cut-1/claudeStubWorld.ts'

/**
 * The step-3a fixture world (ISSUE-001; `17` §1.9): the interactive Claude stub of `claudeStreamStub.mjs` installed as
 * the only `claude` the app can find, a mine to launch into, and the reads a case makes through the renderer's own
 * `window.api` (the `14` seam A members the 3a switch routes; the window is the person's, so no test backdoor exists).
 *
 * - The stub folder holds `claude.cmd` (Windows) and `claude` (POSIX), each running the folder's `claude.mjs` entry,
 *   which runs the stub with the folder as its world. A Windows `.cmd` shim is read for its quoted node entry, never
 *   run through `cmd.exe` (ADR-029 row 8), so the entry sits beside it and nothing but the entry path is in the shim.
 * - {@link stubOnlyPath}: the app's whole `PATH` (`launchApp({ stubs, pathOnly: true })`) is the stub folder, node's
 *   folder and the OS's own tools, so a `claude` or a `claude-agent-acp` installed on the machine running the case is
 *   never found (the Claude catalog entry prefers `claude-agent-acp` when it resolves, `profiles.ts`).
 * - The mine is the cut-1 world's (`seedClaudeStubSession`): one observed Claude session the kit stub replayed into the
 *   profile's own `CLAUDE_CONFIG_DIR`, so the Host knows the mine `moria` and its folder.
 */

/** The Claude catalog id, from the one list (R12: never a hand-typed literal outside it). */
export const CLAUDE = CATALOG_PROVIDER_IDS[0]

const STUB_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claudeStreamStub.mjs')
const SLEEPER = path.join(STUB_BIN, 'sleeper', 'sleeper.mjs')

/** The replies of the stub (`claudeStreamStub.mjs` REPLIES), as a case expects them. */
export const REPLIES = {
  first: 'Hello from the stub session.',
  plain: 'Noted.',
  allowed: 'The marker file is written.',
  denied: 'The marker file was not written.'
} as const

/** A turn whose text holds this makes the stub ask for the Write tool (`claudeStreamStub.mjs` ASK_MARKER). */
export const ASK_MARKER = 'marker file'

/** One session run of the stub, as it wrote it down. */
export interface StubRun {
  readonly pid: number
  readonly kind: 'launch' | 'resume'
  readonly sessionId: string
}

export interface ClaudeStreamWorld {
  /** The stub folder. */
  readonly dir: string
  /** Every session run of the stub so far. */
  runs(): StubRun[]
}

/** Installs the interactive Claude stub in `profile`; `resume: 'refuse'` makes every resume run fail at once. */
export function createClaudeStreamWorld(
  profile: IsolatedProfile,
  options: { readonly resume?: 'accept' | 'refuse' } = {}
): ClaudeStreamWorld {
  const dir = path.join(profile.root, 'claude-stream-stub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'world.json'),
    JSON.stringify({ resume: options.resume ?? 'accept' })
  )
  writeFileSync(
    path.join(dir, 'claude.mjs'),
    [
      `import { runClaudeStreamStub } from ${JSON.stringify(pathToFileURL(STUB_MODULE).href)}`,
      'runClaudeStreamStub(import.meta.dirname)',
      ''
    ].join('\n')
  )
  writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude.mjs" %*\r\n')
  const posix = path.join(dir, 'claude')
  writeFileSync(
    posix,
    '#!/bin/sh\ncase "$0" in\n  */*) dir=${0%/*} ;;\n  *) dir=. ;;\nesac\nexec node "$dir/claude.mjs" "$@"\n'
  )
  chmodSync(posix, 0o755)
  return {
    dir,
    runs: () => {
      const runs = path.join(dir, 'runs')
      if (!existsSync(runs)) return []
      return readdirSync(runs)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(runs, name), 'utf8')) as StubRun)
    }
  }
}

/** The app's whole `PATH` for a case of this world: the stub, node, and the OS tools the Host and today's runtime use. */
export function stubOnlyPath(world: ClaudeStreamWorld): string {
  const node = path.dirname(process.execPath)
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32')
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0')
    return [world.dir, node, system, powershell].join(path.delimiter)
  }
  return [world.dir, node, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
}

/** A UUIDv7 (14 §1.6): the requestId of one intent. */
export function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0')
  const rest = randomUUID().replaceAll('-', '')
  const variant = ((Number.parseInt(rest[16] ?? '8', 16) & 0x3) | 0x8).toString(16)
  const v = `${hex}7${rest.slice(13, 16)}${variant}${rest.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

/** One section of the Host's snapshot, read through the renderer's own A-N01 (`window.api.getHostSnapshot`). */
export async function hostSection<T>(window: Page, section: string): Promise<T[]> {
  const answer = (await window.evaluate(
    `window.api.getHostSnapshot({ sections: [${JSON.stringify(section)}] })`
  )) as { ok: boolean; value?: { chunks: Array<{ section: string; data: unknown }> } }
  if (!answer.ok || answer.value === undefined) return []
  return answer.value.chunks.filter((chunk) => chunk.section === section).map((c) => c.data as T)
}

export interface DwarfRow {
  id: string
  mineId: string
  providerId: string
  presence: string
  processState: string
  status: string
  owned: boolean
}

export interface LaunchRow {
  launchId: string
  state: string
  providerId?: string
  wayKind: string
  dwarfId?: string
}

export interface AskRow {
  id: string
  dwarfId: string
  kind: string
  channel: string
  state: string
  providerRequestId: string
}

export const dwarfsOf = async (window: Page): Promise<DwarfRow[]> =>
  (await hostSection<DwarfRow[]>(window, 'dwarfs')).flat()

export const launchesOf = async (window: Page): Promise<LaunchRow[]> =>
  (await hostSection<LaunchRow[]>(window, 'launches')).flat()

export const asksOf = async (window: Page): Promise<AskRow[]> =>
  (await hostSection<{ asks: AskRow[] }>(window, 'asks')).flatMap((data) => data.asks)

/** The chat of one dwarf as the Host keeps it (the `tails` section). */
export async function chatOf(
  window: Page,
  dwarfId: string
): Promise<Array<{ role: string; text: string }>> {
  const tails = (
    await hostSection<Array<{ dwarfId: string; messages: Array<{ role: string; text: string }> }>>(
      window,
      'tails'
    )
  ).flat()
  return (tails.find((tail) => tail.dwarfId === dwarfId)?.messages ?? []).map((m) => ({
    role: m.role,
    text: m.text
  }))
}

/**
 * Seeds the cut-1 mine (one observed Claude session in `moria`) once the Host is up, and answers the mine's id as the
 * Host's board names it.
 */
export async function seedMine(
  window: Page,
  profile: IsolatedProfile
): Promise<{ mineId: string; world: ClaudeStubWorld }> {
  const world = seedClaudeStubSession(profile)
  let mineId: string | undefined
  // A launch enters only a mine the Host measures or holds active (07 machine 5A; `launch.ts` ENTERABLE).
  await expect
    .poll(
      async () => {
        const mines = (
          await hostSection<Array<{ id: string; name: string; state: string }>>(window, 'mines')
        )
          .flat()
          .filter((mine) => mine.name === STUB_MINE_NAME)
        mineId = mines[0]?.id
        return mines[0]?.state
      },
      { timeout: 60_000, message: 'the Host knows the mine of the seeded session, enterable' }
    )
    .toMatch(/^(measuring|active)$/)
  return { mineId: mineId!, world }
}

/**
 * Launches a Claude dwarf into `mineId` through A-35 (`launchAgent`, the `14` `LaunchParams`) and waits until the Host
 * settles the launch with its dwarf, and that dwarf idle after its first turn. The snapshot's `launches` section lists
 * only in-flight and failed launches (`14` §3.7, `launchesSection.ts`), so a succeeded launch is one that left it while
 * a new Claude dwarf of the mine arrived in the `dwarfs` section.
 */
export async function launchClaude(
  window: Page,
  mineId: string,
  prompt = 'Say hello.'
): Promise<{ launchId: string; dwarfId: string }> {
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = (await window.evaluate(
    `window.api.launchAgent(${JSON.stringify({
      mineId,
      way: { kind: 'supplier', providerId: CLAUDE },
      prompt,
      jevOn: false,
      jevAutoAccept: false,
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { launchId: string } }
  expect(accepted, 'A-35 accepts the Claude launch: ' + JSON.stringify(accepted)).toMatchObject({
    ok: true
  })
  const launchId = accepted.value!.launchId
  let dwarfId: string | undefined
  await expect
    .poll(
      async () => {
        const launch = (await launchesOf(window)).find((row) => row.launchId === launchId)
        // A failed launch names its ADR-020 cause, so a failure says why.
        if (launch !== undefined) {
          return launch.state === 'failed' ? `failed ${JSON.stringify(launch)}` : launch.state
        }
        dwarfId = (await dwarfsOf(window)).find(
          (d) => d.mineId === mineId && d.providerId === CLAUDE && !before.has(d.id)
        )?.id
        return dwarfId === undefined ? 'left the launches with no dwarf' : 'succeeded'
      },
      { timeout: 60_000, message: 'the Host settles the launch' }
    )
    .toBe('succeeded')
  await expect
    .poll(async () => (await dwarfsOf(window)).find((d) => d.id === dwarfId)?.status, {
      timeout: 60_000,
      message: 'the launched dwarf ends its first turn'
    })
    .toBe('idle')
  return { launchId, dwarfId: dwarfId! }
}

/** The pid of the stub run the Host launched for `sessionId`'s first launch, once the stub wrote it down. */
export function launchedRun(world: ClaudeStreamWorld): StubRun {
  const runs = world.runs().filter((run) => run.kind === 'launch')
  if (runs.length !== 1)
    throw new Error(`expected one launch run of the stub, found ${runs.length}`)
  return runs[0]!
}

/**
 * Kills the profile's running Host as a crash does (CH-01: SIGKILL on every OS, so a POSIX Host cannot answer with its
 * clean exit) and waits until UI main started the next one and the window reached it again.
 */
export async function killHostOnce(window: Page, profile: IsolatedProfile): Promise<void> {
  const pid = profileHostPid(profile.userDataDir)
  if (pid === null) throw new Error('no Host runs for the profile')
  process.kill(pid, 'SIGKILL')
  await expect.poll(() => isProcessAlive(pid), { timeout: 15_000 }).toBe(false)
  await expect
    .poll(
      () => {
        const next = profileHostPid(profile.userDataDir)
        return next !== null && next !== pid && isProcessAlive(next)
      },
      { timeout: 60_000, message: 'UI main starts the Host again after a crash' }
    )
    .toBe(true)
  await expect
    .poll(
      async () =>
        ((await window.evaluate('window.api.getHostConnection()')) as { state: string }).state,
      { timeout: 60_000, message: 'the window reaches the restarted Host' }
    )
    .toBe('connected')
}

/** A session the person started in their own terminal: a stub process the app never launched. */
export interface OutsideSession {
  readonly pid: number
  alive(): boolean
  dispose(): void
}

/** 100 ns ticks between 1601-01-01 and 1970-01-01 (Claude Code's registry writes `procStart` as a Windows FILETIME). */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

/**
 * Gives the seeded observed session (`seedClaudeStubSession`) a running process, as Claude Code's own session registry
 * names it (`sessions/<pid>.json`, the cut-1 legacy-launched world without its `launched_sessions` row): a stub process
 * (`fixtures/bin/sleeper`, never a provider CLI, 17 §1.8) that neither the Host nor today's runtime launched.
 */
export async function startOutsideSession(
  profile: IsolatedProfile,
  world: ClaudeStubWorld,
  maxMs = 240_000
): Promise<OutsideSession> {
  const child: ChildProcess = spawn(process.execPath, [SLEEPER, 'sleep', String(maxMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  let exited = false
  child.once('exit', () => (exited = true))
  const pid = child.pid
  if (pid === undefined) throw new Error('the outside session did not start')
  const started = await processStartTimeMs(pid)
  if (started === null) {
    child.kill()
    throw new Error('the outside session has no creation time to write down')
  }
  const sessions = path.join(profile.claudeConfigDir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    path.join(sessions, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: STUB_SESSION_ID,
      cwd: world.minePath,
      status: 'busy',
      procStart: String(BigInt(Math.round(started)) * 10_000n + FILETIME_EPOCH_OFFSET)
    })
  )
  return {
    pid,
    alive: () => !exited,
    dispose: () => {
      if (!exited) child.kill()
    }
  }
}
