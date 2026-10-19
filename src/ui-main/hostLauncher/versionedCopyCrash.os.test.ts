// L8 OS lane (17 §1.8; ADR-002 D5; ADR-027 item 2; 13 FM-129): an interrupted versioned copy is never used. The
// launcher's own copy code (ensureVersionedCopy over the Node copy operations), bundled for the run, copies a source
// folder in a process of its own, and the test kills that process (a crash: nothing of its own runs) while it copies
// and at its final rename. Each time `host/<version>/` is absent, never partial, and the next start removes the
// leftover temporary folder and makes a verified copy. Where the copy waits for the kill, the Node operation itself
// has already run: the wait only fixes where the crash lands. The rules are proven at L2 (versionedCopy.test.ts);
// the temporary folder, copies included, is removed at the end.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildManifest,
  HOST_MANIFEST_FILE,
  serializeManifest,
  verifyManifest,
  type HostManifest
} from './hostManifest'
import { bundleEntry, NodeScript, repoImport } from './testing/osProcess'

const CASE_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 60_000
const VERSION = '1.2.3'
/** Enough files that the copy takes a while: 20 folders of 20 files of 32 KiB, 12.8 MB in all. */
const FOLDERS = 20
const FILES_PER_FOLDER = 20
const FILE_BYTES = 32 * 1024
const PLATFORM =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

/**
 * One launcher start's copy step. `crashAt` makes it wait, for the kill, right where the crash is meant to land:
 * `copying` once the real copy has started (and after it, should the kill come late), `renaming` at the final
 * rename, after the copy was verified and an outdated copy moved aside; `none` runs it through and prints the outcome.
 * AMENDED (fix/dev-copy-root): an outdated copy is renamed aside rather than deleted in place, so `renaming` waits at
 * the rename into `host/<version>/`, the final one, and not at that first rename.
 */
const COPIER = `
import { ensureVersionedCopy, nodeCopyOps } from ${repoImport('src', 'ui-main', 'hostLauncher', 'versionedCopy.ts')}

setTimeout(() => process.exit(9), 120_000)
const [sourceDir, manifestPath, root, platform, crashAt] = process.argv.slice(2)
const waitForTheKill = (step) => {
  console.log(step)
  return new Promise(() => {})
}
const ops = {
  async copyTree(from, to) {
    if (crashAt !== 'copying') return nodeCopyOps.copyTree(from, to)
    console.log('copying')
    await nodeCopyOps.copyTree(from, to)
    return waitForTheKill('copied')
  },
  rename: (from, to) =>
    crashAt === 'renaming' && to.endsWith('${VERSION}') ? waitForTheKill('renaming') : nodeCopyOps.rename(from, to),
  removeTree: (target) => nodeCopyOps.removeTree(target),
  // ADDED (fix/dev-copy-root): the probe for a copy a running process holds, before an outdated copy is moved aside.
  busyFile: (dir) => nodeCopyOps.busyFile(dir)
}
const outcome = await ensureVersionedCopy({
  version: '${VERSION}', sourceDir, manifestPath, root, platform, pid: process.pid, ops,
  log: { record: () => {} }, clock: { now: Date.now }
})
console.log(JSON.stringify(outcome))
process.exit(0)
`

let root = ''
let script = ''
let sourceDir = ''
let manifestPath = ''
let manifest: HostManifest

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'dwarfai-copy-crash-os-'))
  script = await bundleEntry(COPIER, path.join(root, 'bundle'), 'copier')
  sourceDir = path.join(root, 'app')
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    const dir = path.join(sourceDir, `part-${folder}`)
    mkdirSync(dir, { recursive: true })
    for (let file = 0; file < FILES_PER_FOLDER; file += 1) {
      writeFileSync(path.join(dir, `file-${file}.bin`), randomBytes(FILE_BYTES))
    }
  }
  manifest = await buildManifest(sourceDir)
  manifestPath = path.join(root, 'host-manifest.json')
  writeFileSync(manifestPath, serializeManifest(manifest))
}, CASE_TIMEOUT_MS)

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** Runs one copy step under `copyRoot`; for a crash, kills it once `ready` says it is where the crash lands. */
async function runCopy(
  copyRoot: string,
  crashAt: 'copying' | 'renaming' | 'none',
  ready: (script: NodeScript) => Promise<void> = () => Promise.resolve()
): Promise<{ pid: number; outcome: unknown }> {
  const copier = new NodeScript(script, [sourceDir, manifestPath, copyRoot, PLATFORM, crashAt])
  try {
    if (crashAt === 'none') {
      const line = await copier.line((text) => text.startsWith('{'), STEP_TIMEOUT_MS)
      return { pid: copier.pid, outcome: JSON.parse(line) }
    }
    await ready(copier)
    await copier.kill()
    return { pid: copier.pid, outcome: null }
  } finally {
    await copier.kill()
  }
}

/** Waits until the copy wrote its first file anywhere under the copy root. */
async function untilAFileIsCopied(copyRoot: string, copier: NodeScript): Promise<void> {
  await copier.line((line) => line === 'copying', STEP_TIMEOUT_MS)
  const deadline = Date.now() + STEP_TIMEOUT_MS
  const copied = (): boolean =>
    existsSync(copyRoot) &&
    readdirSync(copyRoot, { recursive: true }).some((name) => String(name).endsWith('.bin'))
  while (!copied()) {
    if (Date.now() > deadline) throw new Error('the copy never wrote a file')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** The next start: it must remove every leftover and make a fresh copy that verifies against the manifest. */
async function nextStartMakesAVerifiedCopy(copyRoot: string): Promise<void> {
  const { outcome } = await runCopy(copyRoot, 'none')
  expect(outcome).toMatchObject({ ok: true, reused: false })
  expect(readdirSync(copyRoot)).toEqual([VERSION])
  // The copy holds its stored manifest beside the copied files (versionedCopy.ts step 3).
  expect(
    await verifyManifest(path.join(copyRoot, VERSION), manifest, { exclude: [HOST_MANIFEST_FILE] })
  ).toEqual({ ok: true })
}

describe('an interrupted versioned copy is never used (ADR-002 D5)', () => {
  it(
    '[ADR-002, FM-129] a copy killed while it copies leaves only its temporary folder; host/<version>/ never appears, and the next start removes the leftover and makes a verified copy',
    async () => {
      const copyRoot = path.join(root, 'while-copying')
      const { pid } = await runCopy(copyRoot, 'copying', (copier) =>
        untilAFileIsCopied(copyRoot, copier)
      )

      expect(existsSync(path.join(copyRoot, VERSION))).toBe(false)
      expect(readdirSync(copyRoot)).toEqual([`${VERSION}.tmp-${pid}`])
      await nextStartMakesAVerifiedCopy(copyRoot)
    },
    CASE_TIMEOUT_MS
  )

  it(
    '[ADR-002, FM-129] a copy killed at its rename, after the outdated copy was moved aside, leaves no host/<version>/ at all, never a partial one; the next start makes a verified copy',
    async () => {
      const copyRoot = path.join(root, 'at-rename')
      const outdated = path.join(copyRoot, VERSION)
      mkdirSync(outdated, { recursive: true })
      writeFileSync(path.join(outdated, 'host-manifest.json'), '{"format":1,"files":[]}')

      const { pid } = await runCopy(copyRoot, 'renaming', async (copier) => {
        await copier.line((line) => line === 'renaming', STEP_TIMEOUT_MS)
      })

      expect(existsSync(outdated)).toBe(false)
      // AMENDED (fix/dev-copy-root): the outdated copy waits aside as a .tmp- leftover too, removed at the next start.
      expect(readdirSync(copyRoot).sort()).toEqual([
        `${VERSION}.tmp-${pid}`,
        `${VERSION}.tmp-${pid}-old`
      ])
      await nextStartMakesAVerifiedCopy(copyRoot)
    },
    CASE_TIMEOUT_MS
  )
})
