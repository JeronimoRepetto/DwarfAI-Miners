import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  BUNDLE_SIZE_CEILING_BYTES,
  sumSourceBytes,
  TierService,
  tierDebugEnabled,
  tierForBytes,
  type SkippedFile,
  type TierThresholds
} from './tierService'

const KB = 1024
const THRESHOLDS: TierThresholds = { copperKb: 100, silverKb: 500, goldKb: 2048, uraniumKb: 8192 }

describe('tierForBytes', () => {
  it('maps byte totals to tiers at the documented KB boundaries', () => {
    expect(tierForBytes(0, THRESHOLDS)).toBe('bronze')
    expect(tierForBytes(100 * KB - 1, THRESHOLDS)).toBe('bronze')
    expect(tierForBytes(100 * KB, THRESHOLDS)).toBe('copper')
    expect(tierForBytes(500 * KB - 1, THRESHOLDS)).toBe('copper')
    expect(tierForBytes(500 * KB, THRESHOLDS)).toBe('silver')
    expect(tierForBytes(2048 * KB - 1, THRESHOLDS)).toBe('silver')
    expect(tierForBytes(2048 * KB, THRESHOLDS)).toBe('gold')
    expect(tierForBytes(8192 * KB - 1, THRESHOLDS)).toBe('gold')
    expect(tierForBytes(8192 * KB, THRESHOLDS)).toBe('uranium')
  })
})

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

  it('returns 0 for a missing directory', async () => {
    expect(await sumSourceBytes(fake, 'C:\\nope', 3000)).toBe(0)
  })
})

describe('TierService', () => {
  let fake: FakeFs
  let clock: { now: number }
  const PROJECT = 'C:\\Users\\j\\Desktop\\Proj'
  // Small KB thresholds keep fixture content short while still exercising
  // real tier crossings driven by byte size rather than file count.
  const SERVICE_THRESHOLDS: TierThresholds = {
    copperKb: 1,
    silverKb: 5,
    goldKb: 20,
    uraniumKb: 100
  }

  function makeService(): TierService {
    return new TierService({
      fs: fake,
      thresholds: SERVICE_THRESHOLDS,
      ttlS: 600,
      now: () => clock.now
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    clock = { now: 1_000_000 }
    // 2000 bytes: at/above copperKb (1024 B) but below silverKb (5120 B).
    fake.addFile(`${PROJECT}\\src\\a.ts`, 'a'.repeat(2000))
  })

  it('returns bronze immediately while the first computation is pending', async () => {
    const service = makeService()
    expect(service.tierOf(PROJECT)).toBe('bronze')
    await service.settle()
    expect(service.tierOf(PROJECT)).toBe('copper')
  })

  it('caches the computed tier within the TTL', async () => {
    const service = makeService()
    service.tierOf(PROJECT)
    await service.settle()
    // project grows past the silver threshold, but the cache is still fresh
    fake.addFile(`${PROJECT}\\src\\b.ts`, 'b'.repeat(3200))
    clock.now += 599_000
    expect(service.tierOf(PROJECT)).toBe('copper')
    await service.settle()
    expect(service.tierOf(PROJECT)).toBe('copper')
  })

  it('recomputes in the background after the TTL, serving the stale tier meanwhile', async () => {
    const service = makeService()
    service.tierOf(PROJECT)
    await service.settle()
    fake.addFile(`${PROJECT}\\src\\b.ts`, 'b'.repeat(3200))
    clock.now += 601_000
    // stale value first, fresh value after the background walk resolves
    expect(service.tierOf(PROJECT)).toBe('copper')
    await service.settle()
    expect(service.tierOf(PROJECT)).toBe('silver')
  })

  it('treats paths case-insensitively (win32 semantics)', async () => {
    const service = makeService()
    service.tierOf(PROJECT)
    await service.settle()
    expect(service.tierOf(PROJECT.toUpperCase())).toBe('copper')
  })

  it('reports bronze for a missing project directory without throwing', async () => {
    const service = makeService()
    expect(service.tierOf('C:\\nope')).toBe('bronze')
    await service.settle()
    expect(service.tierOf('C:\\nope')).toBe('bronze')
  })
})

// #39: bundled and duplicated files inflated a mine's tier. AI-Tools measured
// 15 976 KB across 362 files, of which 14 MB was six byte-identical copies of
// one 2.3 MB bundled player-script.js — 87% of the mine's weight, from a file
// nobody typed. These three exclusions (size ceiling, generated-name pattern,
// duplicate content) strip that before the byte sum, the same way #37 first
// stripped release/build output.
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

  it('reports every skip with its reason, path, and (for duplicates) the original path', async () => {
    const body = 'y'.repeat(40)
    fake.addFile(`${PROJECT}\\keep.ts`, 'k'.repeat(5))
    fake.addFile(`${PROJECT}\\huge.ts`, 'x'.repeat(BUNDLE_SIZE_CEILING_BYTES + 1))
    fake.addFile(`${PROJECT}\\vendor.min.js`, 'x'.repeat(20))
    fake.addFile(`${PROJECT}\\original.ts`, body)
    fake.addFile(`${PROJECT}\\copy.ts`, body)

    const skips: SkippedFile[] = []
    await sumSourceBytes(fake, PROJECT, 3000, { onSkip: (skipped) => skips.push(skipped) })

    expect(skips).toEqual(
      expect.arrayContaining([
        { reason: 'too-large', path: `${PROJECT}\\huge.ts`, size: BUNDLE_SIZE_CEILING_BYTES + 1 },
        { reason: 'generated-name', path: `${PROJECT}\\vendor.min.js` },
        {
          reason: 'duplicate',
          path: `${PROJECT}\\copy.ts`,
          size: Buffer.byteLength(body, 'utf8'),
          duplicateOf: `${PROJECT}\\original.ts`
        }
      ])
    )
    expect(skips).toHaveLength(3)
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

describe('tierDebugEnabled', () => {
  it('stays off when the flag is absent', () => {
    expect(tierDebugEnabled({})).toBe(false)
  })

  it('stays off for the explicit off values', () => {
    expect(tierDebugEnabled({ TIER_DEBUG: '0' })).toBe(false)
    expect(tierDebugEnabled({ TIER_DEBUG: 'false' })).toBe(false)
    expect(tierDebugEnabled({ TIER_DEBUG: '' })).toBe(false)
  })

  it('turns on for 1 and true, whatever the casing', () => {
    expect(tierDebugEnabled({ TIER_DEBUG: '1' })).toBe(true)
    expect(tierDebugEnabled({ TIER_DEBUG: 'true' })).toBe(true)
    expect(tierDebugEnabled({ TIER_DEBUG: 'TRUE' })).toBe(true)
  })
})

describe('TierService debug reporting (#39)', () => {
  let fake: FakeFs
  const PROJECT = 'C:\\Users\\j\\Desktop\\Proj'
  const LOCAL_THRESHOLDS: TierThresholds = { copperKb: 1, silverKb: 5, goldKb: 20, uraniumKb: 100 }

  beforeEach(() => {
    fake = new FakeFs()
    fake.addFile(`${PROJECT}\\huge.ts`, 'x'.repeat(BUNDLE_SIZE_CEILING_BYTES + 1))
    fake.addFile(`${PROJECT}\\keep.ts`, 'a'.repeat(2000))
  })

  it('logs nothing when debug is off', async () => {
    const lines: string[] = []
    const service = new TierService({
      fs: fake,
      thresholds: LOCAL_THRESHOLDS,
      ttlS: 600,
      debug: false,
      log: (line) => lines.push(line)
    })
    service.tierOf(PROJECT)
    await service.settle()
    expect(lines).toEqual([])
  })

  it('logs a line per skipped file, plus a closing summary, when debug is on', async () => {
    const lines: string[] = []
    const service = new TierService({
      fs: fake,
      thresholds: LOCAL_THRESHOLDS,
      ttlS: 600,
      debug: true,
      log: (line) => lines.push(line)
    })
    service.tierOf(PROJECT)
    await service.settle()
    expect(lines.some((line) => line.includes('too-large') && line.includes('huge.ts'))).toBe(true)
    expect(lines.some((line) => line.includes('keep.ts'))).toBe(false)
    // One summary line closes the report so a project's weight is always explainable (#39).
    expect(lines.at(-1)).toMatch(/skipped/)
  })
})

// A hard-coded backslash in the walk turns every mine on macOS/Linux bronze:
// `${dir}\\${name}` is not a path on a POSIX filesystem, it is one filename
// containing a literal backslash character, so listDir/stat find nothing.
// This pins the fix (path.join) by shape rather than by process.platform: a
// project root with a trailing separator is realistic (path pickers hand
// those back) and hand-rolled concatenation visibly double-separates it even
// on this Windows test host, which is the same class of defect that silently
// picks the wrong separator on POSIX.
describe('sumSourceBytes: joins path segments with path.join, not a hard-coded separator', () => {
  it('does not double a trailing separator on the project root when descending into it', async () => {
    const PROJECT = 'C:\\Users\\j\\Desktop\\Proj'
    const fake = new FakeFs()
    fake.addFile(`${PROJECT}\\src\\a.ts`, 'a'.repeat(10))
    const listDirSpy = vi.spyOn(fake, 'listDir')
    const statSpy = vi.spyOn(fake, 'stat')

    await sumSourceBytes(fake, `${PROJECT}\\`, 3000)

    expect(listDirSpy).toHaveBeenCalledWith(join(PROJECT, 'src'))
    expect(statSpy).toHaveBeenCalledWith(join(PROJECT, 'src', 'a.ts'))
  })
})
