// L8 OS lane (17 §1.8): the revert child of `--revert-integrations` (ADR-016 item 7; ISSUE-225) as
// UI main starts it on this OS — a real process from an absolute executable (this test runner's
// own Node, standing in for the app executable under ELECTRON_RUN_AS_NODE), the environment of
// spawnHost.ts with the flag after the entry, its exit code passed through, and a child that does
// not exit ended by its identity (ADR-014 item 2) through the hung-Host end. Runs on every OS in
// `pnpm test:os`. Temp folders only; no real Host, no home folder (privacy-guard).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeRevertChildStarter } from './nodeHostLauncher'
import { buildRevertSpawn, REVERT_INTEGRATIONS_FLAG, type RevertChild } from './revertIntegrations'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A Host data folder and a tiny entry: it writes what it was started with, then `script` runs. */
function entry(script: string): { hostDataDir: string; entryPath: string; seen: () => Seen } {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-225-child-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const entryPath = join(root, 'main.cjs')
  writeFileSync(
    entryPath,
    `const fs = require('node:fs')
const dwarfai = Object.keys(process.env).filter((name) => name.toUpperCase().startsWith('DWARFAI_'))
fs.writeFileSync('seen.json', JSON.stringify({
  execPath: process.execPath,
  argv: process.argv.slice(2),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  dwarfai,
  cwd: process.cwd()
}))
${script}
`
  )
  return {
    hostDataDir: root,
    entryPath,
    seen: () => JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8')) as Seen
  }
}

interface Seen {
  execPath: string
  argv: string[]
  runAsNode: string | null
  dwarfai: string[]
  cwd: string
}

async function started(hostDataDir: string, entryPath: string): Promise<RevertChild> {
  const child = await createNodeRevertChildStarter()(
    buildRevertSpawn({
      execPath: process.execPath,
      hostEntry: entryPath,
      hostDataDir,
      uiEnv: { ...process.env, DWARFAI_HOOK_TOKEN: 'never-passed', DWARFAI_LOG: 'info' }
    })
  )
  if (child === null) throw new Error('the revert child did not start')
  return child
}

const until = async (condition: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('the revert child on this OS (ADR-016 item 7; ADR-002 D1)', () => {
  it('[ADR-016, ADR-002] the revert child runs the absolute executable with ELECTRON_RUN_AS_NODE, the flag and no DWARFAI token, and its exit code passes through', async () => {
    const { hostDataDir, entryPath, seen } = entry('process.exit(7)')

    const child = await started(hostDataDir, entryPath)

    expect(await child.exited).toBe(7)
    const what = seen()
    expect(isAbsolute(process.execPath)).toBe(true)
    expect(what.execPath).toBe(process.execPath)
    expect(what.argv).toEqual([REVERT_INTEGRATIONS_FLAG])
    expect(what.runAsNode).toBe('1')
    // DWARFAI_HOST_DATA_DIR and the inherited log level only (spawnHost.ts); never a token.
    expect(what.dwarfai.sort()).toEqual(['DWARFAI_HOST_DATA_DIR', 'DWARFAI_LOG'])
  })

  it('[ADR-016, ADR-014] a revert child that does not exit is ended by its identity and never reports exit code 0', async () => {
    const { hostDataDir, entryPath } = entry('setInterval(() => {}, 1000)')
    const child = await started(hostDataDir, entryPath)
    let code: number | null | undefined
    void child.exited.then((value) => (code = value))
    await until(() => {
      try {
        readFileSync(join(hostDataDir, 'seen.json'))
        return true
      } catch {
        return false
      }
    })

    expect(await child.end()).toBe(true)
    await until(() => code !== undefined)
    expect(code).not.toBe(0)
  }, 30_000)
})
