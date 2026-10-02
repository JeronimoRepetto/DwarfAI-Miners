// L8 OS lane (17 §1.8; ADR-002 D5; ADR-027 item 2; SP-03 decision table): the launcher makes the
// versioned copy of the Electron runtime this repository installs (the same files electron-builder
// packs around the app; SP-03 layout `electron-dist-*`) and starts the Host from it. The Host is the
// stub of fixtures/bin/fake-host, which reports the executable it runs on. Each case uses its own
// temporary folder for the copy root, the Host data folder and the manifest, and a private endpoint,
// so it never meets the owner's app or the owner's real copy root. Every Host started is ended in
// the `finally`, and the case checks that none is left running.
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HostEndpoint } from '@dwarfai/contracts'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { buildManifest, serializeManifest } from './hostManifest'
import { createNodeHostLauncher } from './index'
import { copySourceOf, type CopyPlatform } from './versionedCopy'

const WINDOWS = process.platform === 'win32'
const PLATFORM: CopyPlatform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const FAKE_HOST = path.join(REPO_ROOT, 'fixtures', 'bin', 'fake-host', 'fake-host.cjs')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const VERSION = '0.0.0-os031'
const CASE_TIMEOUT_MS = 180_000

interface FakeHostReport {
  pid: number
  execPath: string
}

function newWorld() {
  // On POSIX directly under /tmp, so the socket path fits sun_path on macOS.
  const root = WINDOWS
    ? mkdtempSync(path.join(tmpdir(), 'dwarfai-031-os-'))
    : mkdtempSync('/tmp/dw031-')
  const hostDataDir = path.join(root, 'userData', 'host')
  mkdirSync(hostDataDir, { recursive: true })
  const endpoint: HostEndpoint = WINDOWS
    ? {
        kind: 'named-pipe',
        path: `\\\\.\\pipe\\dwarfai-test-031-${randomBytes(8).toString('hex')}`
      }
    : {
        kind: 'unix-socket',
        dir: path.join(root, 'run'),
        path: path.join(root, 'run', 'host-0123456789ab.sock')
      }
  writeFileSync(
    path.join(hostDataDir, 'fake-host.json'),
    JSON.stringify({ endpoint: endpoint.path, mode: 'ready', maxLifeMs: CASE_TIMEOUT_MS })
  )
  return {
    root,
    hostDataDir,
    endpoint,
    copyRoot: path.join(root, 'DwarfAI', 'host'),
    manifest: path.join(root, 'build', 'host-manifest.json')
  }
}

function hostReports(hostDataDir: string): FakeHostReport[] {
  return readdirSync(hostDataDir)
    .filter((name) => /^fake-host-\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(hostDataDir, name), 'utf8')) as FakeHostReport)
}

/** Real paths on both sides: on macOS `/var/folders/…` is a link to `/private/var/folders/…` (SP-03). */
function isInside(file: string, folder: string): boolean {
  const real = (target: string): string => {
    try {
      return realpathSync.native(target)
    } catch {
      return path.resolve(target)
    }
  }
  const normalize = (target: string): string => (WINDOWS ? target.toLowerCase() : target)
  const relative = path.relative(normalize(real(folder)), normalize(real(file)))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ends `pid` and waits until it is gone; true when nothing is left. */
async function endProcess(pid: number): Promise<boolean> {
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (let waited = 0; waited < 5_000 && isAlive(pid); waited += 100) await sleep(100)
  return !isAlive(pid)
}

/** Removes `dir`, retrying while Windows still holds a just-ended process's files for up to 10 s. */
async function removeFolder(dir: string): Promise<boolean> {
  for (let waited = 0; waited <= 10_000; waited += 250) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(250)
    }
  }
  return false
}

describe('the Host runs from its versioned copy (ADR-002 D5, ADR-027 item 2)', () => {
  it(
    '[SP-03, ADR-002] the Host process started by the launcher runs from host/<version>/ and not from the build output',
    async () => {
      const world = newWorld()
      const survivors: number[] = []
      try {
        const sourceDir = copySourceOf(ELECTRON, PLATFORM)
        mkdirSync(path.dirname(world.manifest), { recursive: true })
        writeFileSync(world.manifest, serializeManifest(await buildManifest(sourceDir)))
        const log = new RecordingUiLog()
        const launcher = createNodeHostLauncher({
          hostDataDir: world.hostDataDir,
          execPath: ELECTRON,
          hostEntry: FAKE_HOST,
          hostManifest: world.manifest,
          log,
          client: { appVersion: VERSION, buildId: 'os-test' },
          endpoint: world.endpoint,
          build: 'dev',
          copyRoot: world.copyRoot,
          // ADDED (fix: Windows launch timeout): the launch helper the Windows spawner loads.
          prebuildsDir: path.join(REPO_ROOT, 'prebuilds')
        })

        expect(await launcher.ensureHostRunning(), JSON.stringify(log.entries)).toBe('spawned')

        const reports = hostReports(world.hostDataDir)
        expect(reports).toHaveLength(1)
        const [host] = reports
        const copyDir = path.join(world.copyRoot, VERSION)
        expect(isInside(host?.execPath ?? '', copyDir), 'the Host runs from host/<version>/').toBe(
          true
        )
        expect(isInside(host?.execPath ?? '', sourceDir), 'not from the build output').toBe(false)
        expect(readdirSync(world.copyRoot), 'no temporary directory is left').toEqual([VERSION])
        expect(log.byEvent('versioned-copy')).toMatchObject([{ outcome: 'ok', causeClass: 'copy' }])
      } finally {
        for (const report of hostReports(world.hostDataDir)) {
          if (!(await endProcess(report.pid))) survivors.push(report.pid)
        }
        const removed = await removeFolder(world.root)
        expect(survivors, 'no Host process is left running').toEqual([])
        expect(removed, 'the temporary folder is removed').toBe(true)
      }
    },
    CASE_TIMEOUT_MS
  )
})
