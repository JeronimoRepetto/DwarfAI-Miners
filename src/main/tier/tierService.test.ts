import { beforeEach, describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { countSourceFiles, TierService, tierForCount, type TierThresholds } from './tierService'

const THRESHOLDS: TierThresholds = { copperAt: 25, silverAt: 100, goldAt: 400, uraniumAt: 1500 }

describe('tierForCount', () => {
  it('maps file counts to tiers at the documented boundaries', () => {
    expect(tierForCount(0, THRESHOLDS)).toBe('bronze')
    expect(tierForCount(24, THRESHOLDS)).toBe('bronze')
    expect(tierForCount(25, THRESHOLDS)).toBe('copper')
    expect(tierForCount(99, THRESHOLDS)).toBe('copper')
    expect(tierForCount(100, THRESHOLDS)).toBe('silver')
    expect(tierForCount(399, THRESHOLDS)).toBe('silver')
    expect(tierForCount(400, THRESHOLDS)).toBe('gold')
    expect(tierForCount(1499, THRESHOLDS)).toBe('gold')
    expect(tierForCount(1500, THRESHOLDS)).toBe('uranium')
  })
})

describe('countSourceFiles', () => {
  let fake: FakeFs
  const PROJECT = 'C:\\Users\\jeron\\Desktop\\Proj'

  beforeEach(() => {
    fake = new FakeFs()
    fake.addFile(`${PROJECT}\\src\\a.ts`, '')
    fake.addFile(`${PROJECT}\\src\\deep\\b.vue`, '')
    fake.addFile(`${PROJECT}\\c.py`, '')
    fake.addFile(`${PROJECT}\\README.md`, '')
    fake.addFile(`${PROJECT}\\pnpm-lock.yaml`, '')
  })

  it('counts source-ish files recursively, ignoring non-source files', async () => {
    expect(await countSourceFiles(fake, PROJECT, 3000)).toBe(3)
  })

  it('skips dependency and build directories', async () => {
    for (const skipped of ['node_modules', '.git', 'dist', 'out', '.venv', 'target']) {
      fake.addFile(`${PROJECT}\\${skipped}\\x.ts`, '')
      fake.addFile(`${PROJECT}\\${skipped}\\nested\\y.js`, '')
    }
    expect(await countSourceFiles(fake, PROJECT, 3000)).toBe(3)
  })

  it('matches extensions case-insensitively', async () => {
    fake.addFile(`${PROJECT}\\Main.TS`, '')
    expect(await countSourceFiles(fake, PROJECT, 3000)).toBe(4)
  })

  it('stops at the file cap', async () => {
    for (let i = 0; i < 30; i++) fake.addFile(`${PROJECT}\\gen\\file${i}.ts`, '')
    expect(await countSourceFiles(fake, PROJECT, 10)).toBe(10)
  })

  it('returns 0 for a missing directory', async () => {
    expect(await countSourceFiles(fake, 'C:\\nope', 3000)).toBe(0)
  })
})

describe('TierService', () => {
  let fake: FakeFs
  let clock: { now: number }
  const PROJECT = 'C:\\Users\\jeron\\Desktop\\Proj'

  function makeService(): TierService {
    return new TierService({
      fs: fake,
      thresholds: THRESHOLDS,
      ttlS: 600,
      now: () => clock.now
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    clock = { now: 1_000_000 }
    for (let i = 0; i < 30; i++) fake.addFile(`${PROJECT}\\src\\f${i}.ts`, '')
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
    for (let i = 0; i < 100; i++) fake.addFile(`${PROJECT}\\src\\g${i}.ts`, '')
    clock.now += 599_000
    expect(service.tierOf(PROJECT)).toBe('copper')
    await service.settle()
    expect(service.tierOf(PROJECT)).toBe('copper')
  })

  it('recomputes in the background after the TTL, serving the stale tier meanwhile', async () => {
    const service = makeService()
    service.tierOf(PROJECT)
    await service.settle()
    for (let i = 0; i < 100; i++) fake.addFile(`${PROJECT}\\src\\g${i}.ts`, '')
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
