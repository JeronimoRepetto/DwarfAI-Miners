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

const TOOL = { providerId: 'tool-provider', binaries: ['tool'] } as const

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

    expect(await s.detection.detect(TOOL)).toEqual({
      kind: 'installed',
      install: {
        providerId: 'tool-provider',
        binaryPath: '/opt/tools/tool',
        version: '1.0.0',
        resolvedVia: 'path',
        statMtimeMs: 1_000
      }
    })
    expect(await s.detection.detect(TOOL)).toMatchObject({ install: { version: '1.0.0' } })
    expect(s.resolver.calls).toHaveLength(1) // revalidated by stat/mtime only

    // The person upgrades the CLI: new bytes, new mtime, new version (FM-134).
    s.fs.addFile('/opt/tools/tool', 'v2', 2_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '2.0.0' })

    expect(await s.detection.detect(TOOL)).toEqual({
      kind: 'installed',
      install: {
        providerId: 'tool-provider',
        binaryPath: '/opt/tools/tool',
        version: '2.0.0',
        resolvedVia: 'path',
        statMtimeMs: 2_000
      }
    })
    expect(s.resolver.calls).toHaveLength(2)
  })

  it('[US-RES-005.AC01, FM-055] a CLI removed after it was detected is not installed on the next check', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    expect((await s.detection.detect(TOOL)).kind).toBe('installed')

    s.fs.removeFile('/opt/tools/tool')
    s.resolver.uninstall('tool')

    expect(await s.detection.detect(TOOL)).toEqual({ kind: 'not-installed' })
  })

  it('[ADR-009] a first detection slower than the budget answers not installed, and the background rescan fills the cache for the next ask', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    s.resolver.delayMs = 2_000

    let first: unknown = null
    void s.detection.detect(TOOL).then((answer) => (first = answer))
    await settle()
    s.clock.advance(DETECTION_BUDGET_MS)
    await settle()
    expect(first).toEqual({ kind: 'not-installed' }) // nothing cached yet: fail closed
    expect(s.detection.last(TOOL)).toBeNull()

    // A second ask while the rescan runs joins it rather than starting another one.
    void s.detection.detect(TOOL)
    await settle()
    expect(s.resolver.calls).toHaveLength(1)

    s.clock.advance(2_000)
    await settle()
    expect(s.detection.last(TOOL)).toMatchObject({
      kind: 'installed',
      install: { version: '1.0.0' }
    })
    expect(await s.detection.detect(TOOL)).toMatchObject({ kind: 'installed' })
  })

  it('[ADR-009] a resolver that throws is reported not installed, never as an error', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const failing: InstallResolver = {
      resolve: () => Promise.reject(new Error('EACCES reading a PATH directory'))
    }
    const detection = createInstallDetection({ resolver: failing, fs: new FakeFs(), scheduler })

    await expect(detection.detect(TOOL)).resolves.toEqual({ kind: 'not-installed' })
  })

  it('[ADR-009] a driver that needs an executable adapter is installed only when the adapter resolves through the same resolver too', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    const need = { ...TOOL, adapterBinaries: ['tool-acp'] }

    expect(await detectForDriver(s.detection, need)).toEqual({ kind: 'not-installed' })

    s.fs.addFile('/opt/tools/tool-acp', 'adapter', 1_000)
    s.resolver.install('tool-acp', { path: '/opt/tools/tool-acp', version: '0.4.0' })

    // The answer names the user's CLI, never the adapter (15 §1.2 `binaryPath`).
    expect(await detectForDriver(s.detection, need)).toEqual({
      kind: 'installed',
      install: {
        providerId: 'tool-provider',
        binaryPath: '/opt/tools/tool',
        version: '1.0.0',
        resolvedVia: 'path',
        statMtimeMs: 1_000
      }
    })
    expect(s.resolver.calls).toContainEqual(['tool-acp'])
  })

  it('[ADR-009, FM-055] a binary quarantined by the OS is detected as quarantined, treated as not installed, and never spawned', async () => {
    const s = setup()
    s.fs.addFile('/opt/tools/tool', 'v1', 1_000)
    s.resolver.install('tool', { path: '/opt/tools/tool', quarantined: true })

    expect(await s.detection.detect(TOOL)).toEqual({ kind: 'quarantined', path: '/opt/tools/tool' })
    expect(await detectForDriver(s.detection, { ...TOOL, adapterBinaries: [] })).toEqual({
      kind: 'quarantined',
      path: '/opt/tools/tool'
    })
    expect(s.resolver.spawned).toEqual([])

    // The person clears the quarantine: the next check resolves again and finds it installed.
    s.resolver.install('tool', { path: '/opt/tools/tool', version: '1.0.0' })
    expect(await s.detection.detect(TOOL)).toMatchObject({ kind: 'installed' })
  })

  it('[ADR-009] how the CLI was found is carried into the install (PATH, a package-manager directory, the login shell)', async () => {
    const s = setup()
    for (const [binary, resolvedVia] of [
      ['on-path', 'path'],
      ['in-pm-dir', 'package-manager-dir'],
      ['via-shell', 'login-shell-path']
    ] as const) {
      s.fs.addFile(`/opt/tools/${binary}`, 'cli', 1)
      s.resolver.install(binary, { path: `/opt/tools/${binary}`, version: '1', resolvedVia })
      expect(await s.detection.detect({ providerId: binary, binaries: [binary] })).toMatchObject({
        kind: 'installed',
        install: { providerId: binary, resolvedVia }
      })
    }
  })
})
