// L8 OS lane (17 §1.8): the real resolver over the real file system and the real ProcessControl,
// against a stub CLI written to a temp directory, one describe per OS. Runs only in `pnpm test:os`.
// The stub is a tiny node script (on Windows behind an npm-style `.cmd` shim, which the resolver
// must read and never run); it prints a version and exits. No provider CLI is ever started.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeScheduler } from '../../../../platform/clock/NodeScheduler'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeProcessControl } from '../../../../platform/process/NodeProcessControl'
import { createHostInstallResolver } from './hostInstallResolver'

const VERSION = 'stubcli 1.2.3'
const SCRIPT = `process.stdout.write(process.argv.includes('--version') ? '${VERSION}\\n' : '')\n`

let dir = ''

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dwarfai-resolver-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function resolverFor(env: Record<string, string>) {
  const scheduler = new NodeScheduler({ onTaskError: () => {} })
  return createHostInstallResolver({
    fs: new NodeFs(),
    processControl: new NodeProcessControl({ scheduler }),
    scheduler,
    env,
    home: dir // no package-manager directory exists under it
  })
}

describe.runIf(process.platform === 'win32')('CliInstallResolver on Windows', () => {
  it('[ADR-009] the real resolver finds a stub CLI on PATH and reports its version', async () => {
    const entry = join(dir, 'node_modules', 'stubcli', 'cli.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, SCRIPT)
    writeFileSync(
      join(dir, 'stubcli.cmd'),
      `@ECHO off\r\nnode "%~dp0\\node_modules\\stubcli\\cli.js" %*\r\n`
    )
    const resolver = resolverFor({
      Path: [dir, dirname(process.execPath)].join(delimiter),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows'
    })

    expect(await resolver.resolve(['stubcli'])).toEqual({ path: entry, version: VERSION })
    expect(await resolver.resolve(['not-a-cli-anywhere'])).toBeNull()
  }, 30_000)
})

describe.runIf(process.platform !== 'win32')('CliInstallResolver on macOS and Linux', () => {
  it('[ADR-009] the real resolver finds a stub CLI on PATH and reports its version', async () => {
    const entry = join(dir, 'stubcli')
    writeFileSync(entry, `#!${process.execPath}\n${SCRIPT}`)
    chmodSync(entry, 0o755)
    const resolver = resolverFor({
      PATH: `${dir}${delimiter}/usr/bin:/bin`,
      HOME: dir,
      SHELL: '/bin/sh'
    })

    expect(await resolver.resolve(['stubcli'])).toEqual({ path: entry, version: VERSION })
  }, 30_000)
})
