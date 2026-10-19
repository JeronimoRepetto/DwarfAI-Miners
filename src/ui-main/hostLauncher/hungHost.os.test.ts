// L8 OS lane (17 §1.8; ADR-002 D9 steps 2 and 4; ADR-014 item 2; TC-052-04): the Node hung-Host end against the real
// Host of this checkout (out/host/main.js, built here), started the way the launcher starts it, with a temporary data
// folder. The identity file is the one the real Host wrote, so the UI's boot id and start-time reads are checked
// against the Host's own. Every Host started is killed in the `finally`, and the temporary folder removed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeHungHostEnder } from './nodeHostLauncher'
import { buildRealHost, startRealHost, type RealHost } from './testing/realHost'

const WINDOWS = process.platform === 'win32'
const CASE_TIMEOUT_MS = 120_000

let entry = ''
let root = ''

beforeAll(async () => {
  entry = await buildRealHost()
  root = WINDOWS ? mkdtempSync(path.join(tmpdir(), 'dwarfai-052-os-')) : mkdtempSync('/tmp/dw052-')
}, CASE_TIMEOUT_MS)

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A data folder and the POSIX home and runtime folders of one case, all under the temporary root. */
function caseFolders(name: string): { hostDataDir: string; env: Record<string, string> } {
  const hostDataDir = path.join(root, name, 'host')
  mkdirSync(hostDataDir, { recursive: true })
  const env: Record<string, string> = WINDOWS
    ? {}
    : { HOME: path.join(root, name, 'home'), XDG_RUNTIME_DIR: path.join(root, name, 'xdg') }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { hostDataDir, env }
}

/** Whether `host` exits within `ms`. */
function exitedWithin(host: RealHost, ms: number): Promise<boolean> {
  return Promise.race([
    host.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ])
}

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))(
  'the Node hung-Host end against the real Host',
  () => {
    it(
      '[ADR-002, ADR-014] a Host whose identity file matches is ended, that one process, and its exit is observed',
      async () => {
        const { hostDataDir, env } = caseFolders('match')
        let host: RealHost | undefined
        try {
          host = await startRealHost({ entry, hostDataDir, env })
          const ender = createNodeHungHostEnder({ hostDataDir, uiEnv: { ...process.env, ...env } })

          expect(await ender.endHungHost()).toEqual({ outcome: 'ended' })
          expect(await exitedWithin(host, 5_000)).toBe(true)
        } finally {
          await host?.kill()
        }
      },
      CASE_TIMEOUT_MS
    )

    it(
      '[ADR-002, S12.B14] an identity file whose start time is off by more than 2 000 ms, or a missing one, signals nothing',
      async () => {
        const { hostDataDir, env } = caseFolders('mismatch')
        let host: RealHost | undefined
        try {
          host = await startRealHost({ entry, hostDataDir, env })
          const file = path.join(hostDataDir, 'run', 'host.identity')
          const identity = JSON.parse(readFileSync(file, 'utf8')) as { processStartTimeMs: number }
          writeFileSync(
            file,
            JSON.stringify({
              ...identity,
              processStartTimeMs: identity.processStartTimeMs - 10_000
            })
          )
          const ender = createNodeHungHostEnder({ hostDataDir, uiEnv: { ...process.env, ...env } })

          expect(await ender.endHungHost()).toEqual({ outcome: 'identity-mismatch' })
          expect(host.alive).toBe(true)

          rmSync(file)
          expect(await ender.endHungHost()).toEqual({ outcome: 'identity-missing' })
          expect(host.alive).toBe(true)
        } finally {
          await host?.kill()
        }
      },
      CASE_TIMEOUT_MS
    )
  }
)
