import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import type { InstallResolver } from '../ports/installResolver'
import { FakeInstallResolver } from '../ports/fakes/FakeInstallResolver'
import { createInstallDetection, detectForDriver, DETECTION_BUDGET_MS } from './detection'

function setup() {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const fs = new FakeFs()
  const resolver = new FakeInstallResolver({ scheduler })
  const detection = createInstallDetection({ resolver, fs, scheduler })
  return { clock, scheduler, fs, resolver, detection }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('installed detection (ADR-009 D5)', () => {
  it('[ADR-009] the detection budget is 500 ms', () => {
    expect(DETECTION_BUDGET_MS).toBe(500)
  })

  it('[ADR-009, FM-134] an unchanged mtime answers from the cache without resolving again, and a changed one resolves again and reports the new version', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })

    expect(await s.detection.detect(['tool'])).toEqual({
      kind: 'installed',
      path: '/opt/tools/tool',
      version: '1.0.0',
      statMtimeMs: 1_000
    })
    expect(await s.detection.detect(['tool'])).toMatchObject({ version: '1.0.0' })
    expect(s.resolver.calls).toHaveLength(1) // revalidated by stat/mtime only

    // The person upgrades the CLI: new bytes, new mtime, new version (FM-134).
    s.fs.addFile('/opt/tools/tool', 'v2', 2_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '2.0.0' })

    expect(await s.detection.detect(['tool'])).toEqual({
      kind: 'installed',
      path: '/opt/tools/tool',
      version: '2.0.0',
      statMtimeMs: 2_000
    })
    expect(s.resolver.calls).toHaveLength(2)
  })

  it('[US-RES-005.AC01, FM-055] a CLI removed after it was detected is not installed on the next check', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    expect((await s.detection.detect(['tool'])).kind).toBe('installed')

    s.fs.removeFile('/opt/tools/tool')
    s.resolver.uninstall('tool')

    expect(await s.detection.detect(['tool'])).toEqual({ kind: 'not-installed' })
  })

  it('[ADR-009] a first detection slower than the budget answers not installed, and the background rescan fills the cache for the next ask', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    s.resolver.delayMs = 2_000

    let first: unknown = null
    void s.detection.detect(['tool']).then((answer) => (first = answer))
    await settle()
    s.clock.advance(DETECTION_BUDGET_MS)
    await settle()
    expect(first).toEqual({ kind: 'not-installed' }) // nothing cached yet: fail closed
    expect(s.detection.last(['tool'])).toBeNull()

    // A second ask while the rescan runs joins it rather than starting another one.
    void s.detection.detect(['tool'])
    await settle()
    expect(s.resolver.calls).toHaveLength(1)

    s.clock.advance(2_000)
    await settle()
    expect(s.detection.last(['tool'])).toMatchObject({ kind: 'installed', version: '1.0.0' })
    expect(await s.detection.detect(['tool'])).toMatchObject({ kind: 'installed' })
  })

  it('[ADR-009] a resolver that throws is reported not installed, never as an error', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const failing: InstallResolver = {
      resolve: () => Promise.reject(new Error('EACCES reading a PATH directory'))
    }
    const detection = createInstallDetection({ resolver: failing, fs: new FakeFs(), scheduler })

    await expect(detection.detect(['tool'])).resolves.toEqual({ kind: 'not-installed' })
  })

  it('[ADR-009] a driver that needs an executable adapter is installed only when the adapter resolves through the same resolver too', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    const need = { binaries: ['tool'], adapterBinaries: ['tool-acp'] }

    expect(await detectForDriver(s.detection, need)).toEqual({ kind: 'not-installed' })

    s.fs.addFile('/opt/tools/tool-acp', 'adapter', 1_000)
    s.resolver.install('tool-acp', { path: '/opt/tools/tool-acp', version: '0.4.0' })

    // The answer names the user's CLI, never the adapter (15 §1.2 `binaryPath`).
    expect(await detectForDriver(s.detection, need)).toEqual({
      kind: 'installed',
      path: '/opt/tools/tool',
      version: '1.0.0',
      statMtimeMs: 1_000
    })
    expect(s.resolver.calls).toContainEqual(['tool-acp'])
  })
})
