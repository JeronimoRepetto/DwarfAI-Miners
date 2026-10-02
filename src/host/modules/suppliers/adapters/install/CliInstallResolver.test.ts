import { describe, expect, it } from 'vitest'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { createInstallDetection, detectForDriver } from '../../application/detection'
import { layMachine } from '../../testing/cliResolverMachine'
import { PROBE_TIMEOUT_MS } from './CliInstallResolver'

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

describe('CliInstallResolver', () => {
  it('[C-02, FM-055] a driver whose binary does not resolve reports not-installed and no process is started from a bundled path', async () => {
    const machine = layMachine({ platform: 'win32', installs: [] })
    // What a packaged app could carry: an SDK's per-platform runtime and an adapter's shim.
    const resources = 'C:\\Users\\j\\AppData\\Local\\Programs\\DwarfAI\\resources'
    machine.fs.addFile(
      `${resources}\\app.asar.unpacked\\node_modules\\@vendor\\agent-runtime-win32-x64\\claude.exe`,
      'bundled',
      1
    )
    machine.fs.addFile(`${resources}\\node_modules\\.bin\\claude-agent-acp.exe`, 'bundled', 1)
    const detection = createInstallDetection({
      resolver: machine.resolver,
      fs: machine.fs,
      scheduler: new FakeScheduler(machine.clock)
    })

    const detected = await detectForDriver(detection, {
      binaries: ['claude'],
      adapterBinaries: ['claude-agent-acp']
    })

    expect(detected).toEqual({ kind: 'not-installed' })
    expect(await detection.detect(['claude'])).toEqual({ kind: 'not-installed' })
    expect(await machine.resolver.resolve(['claude-agent-acp'])).toBeNull()
    expect(machine.spawned()).toEqual([])
  })

  it('[ADR-009] a --version that does not answer within the probe timeout leaves the version unknown and ends the probe by identity', async () => {
    const machine = layMachine({
      platform: 'linux',
      installs: [{ binary: 'slow', layout: 'path', target: '/opt/tools/bin/slow', version: 'x' }]
    })
    machine.control.script((spec) =>
      spec.executable === '/opt/tools/bin/slow' ? 'hang' : undefined
    )

    let answer: unknown = 'pending'
    void machine.resolver.resolve(['slow']).then((resolved) => (answer = resolved))
    await settle()
    machine.clock.advance(PROBE_TIMEOUT_MS - 1)
    await settle()
    expect(answer).toBe('pending')

    machine.clock.advance(1)
    await settle()
    expect(answer).toEqual({ path: '/opt/tools/bin/slow' })
    expect(PROBE_TIMEOUT_MS).toBe(5_000)
    expect(machine.control.fake.signals.length).toBeGreaterThan(0)
  })

  it('[ADR-009, FM-055] a shim this resolver cannot read is skipped and the search goes on to the next install', async () => {
    const machine = layMachine({
      platform: 'win32',
      installs: [
        {
          binary: 'tool',
          layout: 'local-bin',
          target: 'C:\\Users\\j\\.local\\bin\\tool.exe',
          version: 'tool 1.0.0'
        }
      ]
    })
    // Earlier on PATH: a wrapper that forwards to another batch file, which is never followed.
    machine.fs.addFile('C:\\Tools\\bin\\tool.cmd', '@call "%~dp0\\other.cmd" %*\r\n', 1)

    expect(await machine.resolver.resolve(['tool'])).toEqual({
      path: 'C:\\Users\\j\\.local\\bin\\tool.exe',
      version: 'tool 1.0.0'
    })
  })

  it('[ADR-009] two entries that lead to the same file are checked once (realpath de-duplication)', async () => {
    const machine = layMachine({
      platform: 'darwin',
      installs: [
        {
          binary: 'tool',
          layout: 'homebrew',
          target: '/opt/homebrew/Cellar/tool/1.0.0/bin/tool',
          version: 'tool 1.0.0',
          quarantined: true
        }
      ]
    })
    // The same program also linked from a PATH directory.
    machine.fs.addFile('/opt/tools/bin/tool', 'link', 1)
    machine.links.set('/opt/tools/bin/tool', '/opt/homebrew/Cellar/tool/1.0.0/bin/tool')

    expect(await machine.resolver.resolve(['tool'])).toBeNull()
    const quarantineReads = machine
      .spawned()
      .filter((spawn) => spawn.executable === '/usr/bin/xattr')
    expect(quarantineReads).toHaveLength(1)
    expect(machine.spawned().some((s) => s.executable.endsWith('/tool'))).toBe(false)
  })

  it('[ADR-009, ADR-017] a probe child gets only the allowlisted environment', async () => {
    const machine = layMachine({
      platform: 'linux',
      installs: [{ binary: 'tool', layout: 'path', target: '/opt/tools/bin/tool', version: 't 1' }]
    })

    await machine.resolver.resolve(['tool'])

    const [probe] = machine.spawned()
    expect(probe?.args).toEqual(['--version'])
    expect(probe?.env).toEqual({ PATH: machine.env['PATH'], HOME: '/home/j' })
  })
})
