import { beforeEach, describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { sumSourceBytes, TierService, tierForBytes, type TierThresholds } from './tierService'

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
    // Isolated fake: only uniform 10-byte files, so the cap boundary is the
    // only variable — no baseline fixture bytes to muddy the expected sum.
    const uniform = new FakeFs()
    for (let i = 0; i < 30; i++) uniform.addFile(`${PROJECT}\\gen\\file${i}.ts`, 'a'.repeat(10))
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
