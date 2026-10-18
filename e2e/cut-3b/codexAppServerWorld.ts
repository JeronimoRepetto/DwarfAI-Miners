import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.ts'
import type { IsolatedProfile } from '../_harness/launchApp.ts'
import { dwarfsOf, launchesOf, uuidv7 } from '../cut-3a/claudeStreamWorld.ts'

/**
 * The step-3b fixture world (ISSUE-002; `17` §1.9): the interactive Codex stub of `codexAppServerStub.mjs` installed as
 * the only `codex` the app can find. The mine and the snapshot reads are the 3a world's (`../cut-3a/claudeStreamWorld.ts`):
 * the window is the person's, so the case reads through the renderer's own `window.api`.
 *
 * - The stub folder holds `codex.cmd` (Windows) and `codex` (POSIX), each running the folder's `codex.mjs` entry, which
 *   runs the stub with the folder as its world. A Windows `.cmd` shim is read for its quoted node entry, never run
 *   through `cmd.exe` (ADR-029 row 8): the Host's Codex driver starts that entry with the person's `node`.
 * - {@link codexOnlyPath}: the app's whole `PATH` is the stub folder, node's folder and the OS's own tools, so a `codex`
 *   or a `codex-acp` installed on the machine running the case is never found.
 */

/** The Codex catalog id, from the one list (R12: never a hand-typed literal outside it). */
export const CODEX = CATALOG_PROVIDER_IDS[1]

/** The replies of the stub (`codexAppServerStub.mjs` REPLIES), as a case expects them. */
export const REPLIES = {
  first: 'Hello from the Codex stub.',
  plain: 'Noted.',
  allowed: 'The marker file is written.',
  denied: 'The marker file was not written.'
} as const

/** A turn whose text holds this makes the stub ask to run its command (`codexAppServerStub.mjs` ASK_MARKER). */
export const ASK_MARKER = 'marker file'

const STUB_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'codexAppServerStub.mjs'
)

/** One server run of the stub, as it wrote it down. */
export interface CodexRun {
  readonly pid: number
  readonly kind: 'launch' | 'resume'
  readonly threadId: string
  readonly argv: readonly string[]
  readonly envNames: readonly string[]
  readonly tokenInEnv: boolean
  readonly tokenInArgv: boolean
}

export interface CodexAppServerWorld {
  /** The stub folder. */
  readonly dir: string
  /** Every server run of the stub so far. */
  runs(): CodexRun[]
}

/** Installs the interactive Codex stub in `profile`. */
export function createCodexAppServerWorld(profile: IsolatedProfile): CodexAppServerWorld {
  const dir = path.join(profile.root, 'codex-app-server-stub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'codex.mjs'),
    [
      `import { runCodexAppServerStub } from ${JSON.stringify(pathToFileURL(STUB_MODULE).href)}`,
      'runCodexAppServerStub(import.meta.dirname)',
      ''
    ].join('\n')
  )
  writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex.mjs" %*\r\n')
  const posix = path.join(dir, 'codex')
  writeFileSync(
    posix,
    '#!/bin/sh\ncase "$0" in\n  */*) dir=${0%/*} ;;\n  *) dir=. ;;\nesac\nexec node "$dir/codex.mjs" "$@"\n'
  )
  chmodSync(posix, 0o755)
  return {
    dir,
    runs: () => {
      const runs = path.join(dir, 'runs')
      if (!existsSync(runs)) return []
      return readdirSync(runs)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(runs, name), 'utf8')) as CodexRun)
    }
  }
}

/** The app's whole `PATH` for a case of this world: the stub, node, and the OS tools the Host and today's runtime use. */
export function codexOnlyPath(world: CodexAppServerWorld): string {
  const node = path.dirname(process.execPath)
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32')
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0')
    return [world.dir, node, system, powershell].join(path.delimiter)
  }
  return [world.dir, node, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
}

/**
 * Launches a Codex dwarf into `mineId` through A-35 (`launchAgent`, the `14` `LaunchParams`) and waits until the Host
 * settles the launch with its dwarf, and that dwarf idle after its first turn. The snapshot's `launches` section lists
 * only in-flight and failed launches (`14` §3.7), so a succeeded launch is one that left it while a new Codex dwarf of
 * the mine arrived in the `dwarfs` section.
 */
export async function launchCodex(
  window: Page,
  mineId: string,
  prompt = 'Say hello.'
): Promise<{ launchId: string; dwarfId: string }> {
  const before = new Set((await dwarfsOf(window)).map((d) => d.id))
  const accepted = (await window.evaluate(
    `window.api.launchAgent(${JSON.stringify({
      mineId,
      way: { kind: 'supplier', providerId: CODEX },
      prompt,
      jevOn: false,
      jevAutoAccept: false,
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { launchId: string } }
  expect(accepted, 'A-35 accepts the Codex launch: ' + JSON.stringify(accepted)).toMatchObject({
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
          (d) => d.mineId === mineId && d.providerId === CODEX && !before.has(d.id)
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

/** The one server run the Host launched, once the stub wrote it down. */
export function launchedRun(world: CodexAppServerWorld): CodexRun {
  const runs = world.runs().filter((run) => run.kind === 'launch')
  if (runs.length !== 1)
    throw new Error(`expected one launch run of the stub, found ${runs.length}`)
  return runs[0]!
}
