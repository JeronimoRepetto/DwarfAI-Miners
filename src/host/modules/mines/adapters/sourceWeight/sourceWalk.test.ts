// L1 (17 §1.1): the source-weight walk FsSourceWeightScanner runs in its worker, over a FakeFs.
// The `sumSourceBytes` cases are transplanted from src/main/tier/tierService.test.ts (17 §2.5):
// their bodies are unchanged and the local `sumSourceBytes` below calls the walk with the legacy
// signature. AMENDED for ISSUE-065: a missing root is unenterable instead of weighing 0 (07 S3.11,
// 16 §4.1). Not transplanted, because their subject is gone: `tierForBytes` (now the domain's
// `tierFor`, ISSUE-062), `TierService` with its cache and Bronze placeholder (INV-05 forbids a
// guessed tier), and the debug skip report (`onSkip`, `tierDebugEnabled`).
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import {
  BUNDLE_SIZE_CEILING_BYTES,
  SOURCE_WALK_RULES,
  sumSourceWeight,
  type SourceWalkIo
} from './sourceWalk'

/** The walk's io over a FakeFs, as the worker's io is over node:fs. */
function fakeIo(fs: FakeFs): SourceWalkIo {
  return {
    list: async (path) => {
      const listed = await fs.listDirWithSizes(path)
      return listed.ok
        ? { ok: true, value: listed.value.map(({ name, isDirectory }) => ({ name, isDirectory })) }
        : listed
    },
    size: async (path) => (await fs.stat(path))?.size ?? null,
    fingerprint: async (path, size, sampleBytes) =>
      `${size}:${createHash('sha1')
        .update(await fs.readTextHead(path, sampleBytes))
        .digest('hex')}`,
    join: (dir, name) => `${dir}\\${name}`
  }
}

/** The legacy signature, so the transplanted bodies run unchanged. */
async function sumSourceBytes(fs: FakeFs, path: string, cap: number): Promise<number> {
  const outcome = await sumSourceWeight(
    path,
    { ...SOURCE_WALK_RULES, fileCap: cap },
    fakeIo(fs),
    () => false
  )
  if (!('bytes' in outcome)) throw new Error(`unexpected outcome ${JSON.stringify(outcome)}`)
  return outcome.bytes
}

describe('sumSourceBytes', () => {
  let fake: FakeFs
  const PROJECT = 'C:\\Users\\j\\Desktop\\Proj'

  beforeEach(() => {
    fake = new FakeFs()
    fake.addFile(`${PROJECT}\\src\\a.ts`, 'x'.repeat(10))
    fake.addFile(`${PROJECT}\\src\\deep\\b.vue`, 'y'.repeat(20))
    fake.addFile(`${PROJECT}\\c.py`, 'z'.repeat(5))
    fake.addFile(`${PROJECT}\\README.md`, 'w'.repeat(9999))
    fake.addFile(`${PROJECT}\\pnpm-lock.yaml`, 'w'.repeat(9999))
  })

  it('sums the byte size of source-ish files recursively, ignoring non-source files', async () => {
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(35)
  })

  it('weighs file size, not file count: one dense file can outweigh many tiny ones', async () => {
    const dense = new FakeFs()
    dense.addFile(`${PROJECT}\\huge.ts`, 'x'.repeat(500))

    const many = new FakeFs()
    for (let i = 0; i < 50; i++) many.addFile(`${PROJECT}\\gen\\file${i}.ts`, 'x'.repeat(2))

    const denseBytes = await sumSourceBytes(dense, PROJECT, 3000)
    const manyBytes = await sumSourceBytes(many, PROJECT, 3000)

    // 50 files (many) vs 1 file (dense): file count would rank `many` far
    // higher, but byte weight is what the tier is meant to track.
    expect(denseBytes).toBeGreaterThan(manyBytes)
  })

  it('skips dependency and build directories, including release and build', async () => {
    for (const skipped of [
      'node_modules',
      '.git',
      'dist',
      'out',
      '.venv',
      'target',
      'release',
      'build'
    ]) {
      fake.addFile(`${PROJECT}\\${skipped}\\x.ts`, 'x'.repeat(1000))
      fake.addFile(`${PROJECT}\\${skipped}\\nested\\y.js`, 'x'.repeat(1000))
    }
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(35)
  })

  it('matches extensions case-insensitively', async () => {
    fake.addFile(`${PROJECT}\\Main.TS`, 'a'.repeat(7))
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(42)
  })

  it('stops at the file cap', async () => {
    // Isolated fake: uniform-LENGTH but NOT identical-content files (see the
    // #39 duplicate detection below — identical content would collapse to
    // one file and no longer test the cap at all), so the cap boundary is
    // the only variable that drives the expected sum.
    const uniform = new FakeFs()
    for (let i = 0; i < 30; i++) {
      uniform.addFile(`${PROJECT}\\gen\\file${i}.ts`, String(i).padStart(10, 'a'))
    }
    // Cap bounds files visited, not bytes: 10 files * 10 bytes, not all 30.
    expect(await sumSourceBytes(uniform, PROJECT, 10)).toBe(100)
  })

  // AMENDED for ISSUE-065 (was: 'returns 0 for a missing directory'). A folder that cannot be
  // read is not a weight: the mine becomes unenterable and the walk's result is discarded (S3.11).
  it('[S3.11] answers unenterable for a missing directory', async () => {
    await expect(
      sumSourceWeight('C:\\nope', SOURCE_WALK_RULES, fakeIo(fake), () => false)
    ).resolves.toEqual({ unenterable: 'not-found' })
  })
})

describe('sumSourceBytes: bundle and duplicate exclusion (#39)', () => {
  let fake: FakeFs
  const PROJECT = 'C:\\Users\\j\\Desktop\\Bundled'

  beforeEach(() => {
    fake = new FakeFs()
  })

  it('skips a single file over the per-file bundle-size ceiling', async () => {
    fake.addFile(`${PROJECT}\\src\\small.ts`, 'a'.repeat(100))
    fake.addFile(`${PROJECT}\\vendor\\player-script.js`, 'x'.repeat(BUNDLE_SIZE_CEILING_BYTES + 1))
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(100)
  })

  it('counts a file at exactly the ceiling, and skips one byte over it', async () => {
    const atCeiling = new FakeFs()
    atCeiling.addFile(`${PROJECT}\\a.ts`, 'a'.repeat(BUNDLE_SIZE_CEILING_BYTES))
    expect(await sumSourceBytes(atCeiling, PROJECT, 3000)).toBe(BUNDLE_SIZE_CEILING_BYTES)

    const overCeiling = new FakeFs()
    overCeiling.addFile(`${PROJECT}\\a.ts`, 'a'.repeat(BUNDLE_SIZE_CEILING_BYTES + 1))
    expect(await sumSourceBytes(overCeiling, PROJECT, 3000)).toBe(0)
  })

  it.each(['app.min.js', 'app.min.css', 'app.bundle.js', 'app-bundle.js'])(
    'skips a file matching the generated-name pattern %s',
    async (name) => {
      fake.addFile(`${PROJECT}\\src\\keep.ts`, 'a'.repeat(10))
      fake.addFile(`${PROJECT}\\dist\\${name}`, 'x'.repeat(50))
      expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(10)
    }
  )

  it('matches generated-name patterns case-insensitively', async () => {
    fake.addFile(`${PROJECT}\\dist\\APP.MIN.JS`, 'x'.repeat(50))
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(0)
  })

  it('counts byte-identical duplicates once, keyed by size and a first-block hash', async () => {
    // The real-world case: several byte-identical copies of one file, only
    // distinguished by an unrelated filename or directory.
    const body = 'const player = 1;\n'.repeat(50) // well under the ceiling
    fake.addFile(`${PROJECT}\\v1\\player-script.js`, body)
    fake.addFile(`${PROJECT}\\v2\\player-script.js`, body)
    fake.addFile(`${PROJECT}\\v3\\player-script.js`, body)
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('does not dedupe files that merely share a size when their content differs', async () => {
    fake.addFile(`${PROJECT}\\a.ts`, 'a'.repeat(30))
    fake.addFile(`${PROJECT}\\b.ts`, 'b'.repeat(30))
    expect(await sumSourceBytes(fake, PROJECT, 3000)).toBe(60)
  })

  it('still spends one file-cap slot on a file it goes on to skip', async () => {
    // The cap bounds files visited, not bytes counted (see sumSourceBytes'
    // own doc comment) — a bundle that gets skipped must not give the walk a
    // free pass to look past the cap for more real source.
    fake.addFile(`${PROJECT}\\a\\huge.ts`, 'x'.repeat(BUNDLE_SIZE_CEILING_BYTES + 1))
    fake.addFile(`${PROJECT}\\b\\small.ts`, 'a'.repeat(10))
    expect(await sumSourceBytes(fake, PROJECT, 1)).toBe(0)
  })
})

describe('sumSourceWeight (ISSUE-065)', () => {
  const ROOT = 'C:\\work\\mine'

  it('[ADR-030] checks the abort before each directory and stops without a weight', async () => {
    const fs = new FakeFs()
    fs.addFile(`${ROOT}\\a.ts`, 'a'.repeat(10))
    fs.addFile(`${ROOT}\\src\\b.ts`, 'b'.repeat(10))
    let checks = 0
    // Aborted once the root has been read: the walk must not go into `src`.
    const outcome = await sumSourceWeight(ROOT, SOURCE_WALK_RULES, fakeIo(fs), () => ++checks > 1)
    expect(outcome).toEqual({ unenterable: 'aborted' })
    expect(checks).toBe(2)
  })

  it('[S3.11] a root it cannot list is unenterable with the error; an unreadable subfolder is skipped', async () => {
    const fs = new FakeFs()
    fs.addFile(`${ROOT}\\a.ts`, 'a'.repeat(10))
    fs.addFile(`${ROOT}\\locked\\b.ts`, 'b'.repeat(10))
    fs.scriptFault(`${ROOT}\\locked`, 'EACCES')
    await expect(
      sumSourceWeight(ROOT, SOURCE_WALK_RULES, fakeIo(fs), () => false)
    ).resolves.toEqual({ bytes: 10 })

    fs.scriptFault(ROOT, 'EACCES')
    await expect(
      sumSourceWeight(ROOT, SOURCE_WALK_RULES, fakeIo(fs), () => false)
    ).resolves.toEqual({ unenterable: 'access-denied' })
  })

  it('is self-contained, so its source text runs on its own in a worker', async () => {
    const fs = new FakeFs()
    fs.addFile(`${ROOT}\\a.ts`, 'a'.repeat(10))
    // Rebuilt from its text alone: any reference to a module binding would throw here.
    const rebuilt = new Function(
      `return (${sumSourceWeight.toString()})`
    )() as typeof sumSourceWeight
    await expect(rebuilt(ROOT, SOURCE_WALK_RULES, fakeIo(fs), () => false)).resolves.toEqual({
      bytes: 10
    })
  })
})
