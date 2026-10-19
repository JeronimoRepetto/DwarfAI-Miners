// L8 Windows (17 §1.8; ADR-002 D5; ADR-027 item 2; 13 FM-129): an outdated copy of this version that a running
// process still executes from is never deleted in place. A dev Host running from `host/<version>/` kept an installed
// build of the same version from replacing that copy (COPY_EPERM, 2026-10-02): the in-place removal deleted what it
// could and failed on the running executable. The launcher's own copy code runs here over the real Node operations,
// against a process started from an executable inside the copy; the start fails COPY_IN_USE and the copy stays
// whole. The rule is proven at L2 (versionedCopy.test.ts, with the lock injected); this file proves the Windows
// premise it rests on. The process is ended and the temporary folder removed in `finally`.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { FakeLauncherClock } from './fakes/FakeLauncherClock'
import { buildManifest, serializeManifest } from './hostManifest'
import { ensureVersionedCopy, nodeCopyOps, type VersionedCopyRequest } from './versionedCopy'

const WINDOWS = process.platform === 'win32'
const CASE_TIMEOUT_MS = 120_000
const VERSION = '1.2.3'

describe.runIf(WINDOWS)('a copy a running process executes from (ADR-002 D5, Windows)', () => {
  it(
    '[ADR-027, FM-129] an outdated copy of this version that a running process executes from fails the start COPY_IN_USE and stays whole',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-copy-in-use-os-'))
      const sourceDir = path.join(root, 'app')
      mkdirSync(path.join(sourceDir, 'resources'), { recursive: true })
      writeFileSync(path.join(sourceDir, 'app.exe'), 'executable bytes')
      writeFileSync(path.join(sourceDir, 'resources', 'app.asar'), 'archive bytes v1')
      const manifestPath = path.join(root, 'host-manifest.json')
      const writeManifest = async (): Promise<void> =>
        writeFileSync(manifestPath, serializeManifest(await buildManifest(sourceDir)))
      await writeManifest()
      const copyRoot = path.join(root, 'DwarfAI', 'host')
      const copyDir = path.join(copyRoot, VERSION)
      const request = (pid: number): VersionedCopyRequest => ({
        version: VERSION,
        sourceDir,
        manifestPath,
        root: copyRoot,
        platform: 'win32',
        pid,
        ops: nodeCopyOps,
        log: new RecordingUiLog(),
        clock: new FakeLauncherClock(1_000)
      })
      let holder: ReturnType<typeof spawn> | undefined
      try {
        expect(await ensureVersionedCopy(request(111))).toMatchObject({ ok: true, reused: false })
        // A process runs from inside the copy, as a Host runs from its copy's executable.
        const executable = path.join(copyDir, 'holder.exe')
        copyFileSync(process.execPath, executable)
        holder = spawn(executable, ['-e', 'setTimeout(() => {}, 110000)'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        })
        await new Promise<void>((resolve, reject) => {
          holder?.once('spawn', () => resolve())
          holder?.once('error', reject)
        })
        const before = readdirSync(copyDir, { recursive: true }).map(String).sort()
        // Another build of the same version: the copy there is outdated for it.
        writeFileSync(path.join(sourceDir, 'resources', 'app.asar'), 'archive bytes v2')
        await writeManifest()

        const outcome = await ensureVersionedCopy(request(222))

        expect(outcome).toEqual({ ok: false, errCode: 'COPY_IN_USE' })
        expect(
          readdirSync(copyDir, { recursive: true }).map(String).sort(),
          'the copy in use is whole'
        ).toEqual(before)
        expect(readdirSync(copyRoot), 'no temporary directory is left').toEqual([VERSION])
        expect(holder.exitCode, 'the running process is untouched').toBeNull()
      } finally {
        if (holder !== undefined && holder.exitCode === null) {
          const exited = new Promise((resolve) => holder?.once('exit', resolve))
          holder.kill()
          await exited
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    },
    CASE_TIMEOUT_MS
  )
})
