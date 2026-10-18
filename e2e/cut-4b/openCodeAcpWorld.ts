import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IsolatedProfile } from '../_harness/launchApp.ts'

/**
 * The step-4b fixture world of the person's OpenCode CLI (ISSUE-238; `17` §1.9): the stub `opencode`
 * (`opencodeAcpStub.mjs`, ACP over stdio as `opencode acp`) installed in the profile's own folder, never the
 * developer's, and what each run of it wrote down (its argv and environment names, and the answer it got to its one
 * permission request).
 */

const STUB_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencodeAcpStub.mjs')

/** The stub's replies (`opencodeAcpStub.mjs` REPLIES), as a case expects them. */
export const OPENCODE_REPLIES = {
  allowed: 'Wrote notes.md.',
  denied: 'Left notes.md alone.',
  next: 'Noted.'
} as const

export interface OpenCodeRun {
  readonly pid: number
  readonly argv: readonly string[]
  readonly envNames: readonly string[]
  readonly tokenInEnv: boolean
}

export interface OpenCodeWorld {
  readonly dir: string
  /** Each `opencode acp` run the Host started (not the `--help` and `--version` reads). */
  runs(): OpenCodeRun[]
  /** The option the client chose for the permission request of the run `pid`, once it answered. */
  answerOf(pid: number): string | null
}

/**
 * Installs the stub `opencode` in `profile`: `opencode.cmd` (Windows, read by the resolver for its quoted node entry and
 * started by the Host's driver with the person's `node`, never through `cmd.exe`) and `opencode` (POSIX), each running
 * `opencode.mjs`.
 */
export function createOpenCodeWorld(profile: IsolatedProfile): OpenCodeWorld {
  const dir = path.join(profile.root, 'opencode-stub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'opencode.mjs'),
    [
      `import { runOpenCodeAcpStub } from ${JSON.stringify(pathToFileURL(STUB_MODULE).href)}`,
      'runOpenCodeAcpStub(import.meta.dirname)',
      ''
    ].join('\n')
  )
  writeFileSync(path.join(dir, 'opencode.cmd'), '@echo off\r\nnode "%~dp0opencode.mjs" %*\r\n')
  const posix = path.join(dir, 'opencode')
  writeFileSync(
    posix,
    '#!/bin/sh\ncase "$0" in\n  */*) dir=${0%/*} ;;\n  *) dir=. ;;\nesac\nexec node "$dir/opencode.mjs" "$@"\n'
  )
  chmodSync(posix, 0o755)
  const runs = path.join(dir, 'runs')
  return {
    dir,
    runs: () =>
      existsSync(runs)
        ? readdirSync(runs)
            .filter((name) => /^\d+\.json$/.test(name))
            .map((name) => JSON.parse(readFileSync(path.join(runs, name), 'utf8')) as OpenCodeRun)
        : [],
    answerOf: (pid) => {
      const file = path.join(runs, `${pid}.answers.jsonl`)
      if (!existsSync(file)) return null
      const last = readFileSync(file, 'utf8').trim().split('\n').at(-1)
      return last === undefined ? null : (JSON.parse(last) as { optionId: string }).optionId
    }
  }
}

/** The app's whole `PATH`: the stub, node, and the OS tools the Host and today's runtime use. */
export function openCodeOnlyPath(world: OpenCodeWorld): string {
  const node = path.dirname(process.execPath)
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32')
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0')
    return [world.dir, node, system, powershell].join(path.delimiter)
  }
  return [world.dir, node, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
}
