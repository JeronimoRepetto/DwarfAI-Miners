// L8 OS lane (17 §1.8; ADR-002 D5; 13 FM-129): the versioned copy made where production makes it, inside Electron.
// UI main is an Electron process, whose `node:fs` reads an `.asar` archive as a folder; the runtime folder the copy is
// made from holds one (`resources/default_app.asar` in development, the app's own `app.asar` once packaged), so the
// copy, its manifest check and the collection of old copies must treat it as the one file it is. The launcher's own
// copy code (versionedCopy.ts with its Node operations), bundled for the run, is executed by the installed Electron
// binary with ELECTRON_RUN_AS_NODE=1, which keeps Electron's asar layer; the test reads the outcome it prints. The
// temporary folder, copy included, is removed at the end. Regression test of the COPY_FAILED the cut-0 E2E case met
// (ISSUE-051).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { buildManifest, serializeManifest } from './hostManifest'
import { copySourceOf, type CopyPlatform } from './versionedCopy'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const PLATFORM: CopyPlatform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
const CASE_TIMEOUT_MS = 240_000

const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-051-asar-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** The copy run, as UI main runs it: ensureVersionedCopy over nodeCopyOps, then the collection of old copies. */
const ENTRY = `
import { ensureVersionedCopy, nodeCopyOps } from ${JSON.stringify(path.join(HERE, 'versionedCopy.ts'))}
import { collectVersionedCopies } from ${JSON.stringify(path.join(HERE, 'versionedCopyGc.ts'))}
const [sourceDir, manifestPath, copyRoot, platform] = process.argv.slice(2)
const log = { record: () => {} }
const outcome = await ensureVersionedCopy({
  version: '0.0.0-asar', sourceDir, manifestPath, root: copyRoot, platform, pid: process.pid,
  ops: nodeCopyOps, log, clock: { now: Date.now }
})
await collectVersionedCopies({ root: copyRoot, inUse: '0.0.0-asar', pid: process.pid, ops: nodeCopyOps, log })
process.stdout.write(JSON.stringify({ outcome, asar: typeof process.versions.electron === 'string' }))
`

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))(
  'versioned copy inside Electron',
  () => {
    it(
      "[ADR-002] the versioned copy made inside Electron copies the runtime's asar archive as one file and passes its manifest check",
      async () => {
        const sourceDir = copySourceOf(ELECTRON, PLATFORM)
        const manifestPath = path.join(root, 'host-manifest.json')
        writeFileSync(manifestPath, serializeManifest(await buildManifest(sourceDir)))
        const entryFile = path.join(root, 'entry.ts')
        writeFileSync(entryFile, ENTRY)
        await build({
          configFile: false,
          logLevel: 'silent',
          resolve: {
            alias: { '@dwarfai/contracts': path.join(REPO_ROOT, 'src', 'contracts', 'index.ts') }
          },
          ssr: { noExternal: true },
          build: {
            ssr: entryFile,
            outDir: path.join(root, 'bundle'),
            emptyOutDir: true,
            minify: false,
            target: 'node22',
            rollupOptions: { output: { format: 'es', entryFileNames: 'copy.mjs' } }
          }
        })
        const copyRoot = path.join(root, 'copies')
        const run = spawnSync(
          ELECTRON,
          [path.join(root, 'bundle', 'copy.mjs'), sourceDir, manifestPath, copyRoot, PLATFORM],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            windowsHide: true,
            timeout: CASE_TIMEOUT_MS - 30_000
          }
        )
        const report = JSON.parse(run.stdout || '{}') as {
          outcome?: { ok: boolean; errCode?: string; contentDir?: string }
          asar?: boolean
        }
        expect(report.asar, 'the copy ran inside Electron').toBe(true)
        expect(report.outcome).toMatchObject({ ok: true })
        const archive = path.join('resources', 'default_app.asar')
        if (PLATFORM !== 'darwin') {
          const copied = statSync(path.join(report.outcome?.contentDir ?? '', archive))
          expect(copied.isFile()).toBe(true)
          expect(copied.size).toBe(statSync(path.join(sourceDir, archive)).size)
        }
      },
      CASE_TIMEOUT_MS
    )
  }
)
