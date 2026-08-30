import { describe, expect, it, vi } from 'vitest'
import {
  createLinuxAutostart,
  createMacAutostart,
  createWindowsAutostart,
  type AutostartFsLike
} from './autostartPorts'

const PACKAGED = { executable: '/opt/DwarfAI-Miners/dwarfai-miners', args: [] }

function fakeFs(): AutostartFsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    writeFile: async (path, content) => {
      files.set(path, content)
    },
    removeFile: async (path) => {
      files.delete(path)
    },
    fileExists: async (path) => files.has(path)
  }
}

describe('createMacAutostart', () => {
  const PLIST = '/Users/j/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist'

  it('writes the LaunchAgent plist on enable', async () => {
    const fs = fakeFs()
    const autostart = createMacAutostart({ home: '/Users/j', fs })
    await autostart.enable({
      executable: '/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners',
      args: []
    })
    expect(fs.files.get(PLIST)).toContain('<key>RunAtLoad</key>')
    expect(fs.files.get(PLIST)).toContain(
      '<string>/Applications/DwarfAI-Miners.app/Contents/MacOS/DwarfAI-Miners</string>'
    )
  })

  it('reports enabled exactly when the plist is present', async () => {
    const fs = fakeFs()
    const autostart = createMacAutostart({ home: '/Users/j', fs })
    expect(await autostart.isEnabled()).toBe(false)
    await autostart.enable(PACKAGED)
    expect(await autostart.isEnabled()).toBe(true)
    await autostart.disable()
    expect(await autostart.isEnabled()).toBe(false)
  })

  it('lets a failed write reach the caller, so the first-run marker is not written', async () => {
    // ensureDefaultAutostart only writes its marker after enable() resolves;
    // swallowing the error here would make a transient failure permanent.
    const fs = fakeFs()
    fs.writeFile = () => Promise.reject(new Error('read-only volume'))
    const autostart = createMacAutostart({ home: '/Users/j', fs })
    await expect(autostart.enable(PACKAGED)).rejects.toThrow('read-only volume')
  })

  it('has no legacy migration to run', async () => {
    // The AgentName -> DwarfAI-Miners rename only ever existed in the Windows
    // registry: no macOS build shipped before it.
    const warn = vi.fn()
    const fs = fakeFs()
    await createMacAutostart({ home: '/Users/j', fs }).migrateLegacy(warn)
    expect(warn).not.toHaveBeenCalled()
    expect(fs.files.size).toBe(0)
  })
})

describe('createLinuxAutostart', () => {
  const DESKTOP = '/home/j/.config/autostart/dwarfai-miners.desktop'

  it('writes the XDG autostart entry on enable and removes it on disable', async () => {
    const fs = fakeFs()
    const autostart = createLinuxAutostart({ home: '/home/j', env: {}, fs })
    await autostart.enable(PACKAGED)
    expect(fs.files.get(DESKTOP)).toContain('Exec=/opt/DwarfAI-Miners/dwarfai-miners')
    expect(await autostart.isEnabled()).toBe(true)
    await autostart.disable()
    expect(fs.files.has(DESKTOP)).toBe(false)
  })

  it('follows XDG_CONFIG_HOME', async () => {
    const fs = fakeFs()
    const autostart = createLinuxAutostart({
      home: '/home/j',
      env: { XDG_CONFIG_HOME: '/home/j/cfg' },
      fs
    })
    await autostart.enable(PACKAGED)
    expect([...fs.files.keys()]).toEqual(['/home/j/cfg/autostart/dwarfai-miners.desktop'])
  })

  it('treats a missing entry as already disabled', async () => {
    const fs = fakeFs()
    await expect(
      createLinuxAutostart({ home: '/home/j', env: {}, fs }).disable()
    ).resolves.toBeUndefined()
  })
})

describe('createWindowsAutostart', () => {
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

  function recorder(failFor: (args: string[]) => boolean = () => false) {
    const calls: string[][] = []
    return {
      calls,
      run: async (args: string[]) => {
        calls.push(args)
        if (failFor(args)) throw new Error('reg failed')
      }
    }
  }

  it('writes the Run value on enable', async () => {
    const { calls, run } = recorder()
    await createWindowsAutostart({ run }).enable({
      executable: 'C:\\Apps\\DwarfAI-Miners.exe',
      args: []
    })
    expect(calls).toEqual([
      [
        'add',
        RUN_KEY,
        '/v',
        'DwarfAI-Miners',
        '/t',
        'REG_SZ',
        '/d',
        '"C:\\Apps\\DwarfAI-Miners.exe"',
        '/f'
      ]
    ])
  })

  it('reports a missing Run value as disabled instead of throwing', async () => {
    const { run } = recorder((args) => args[0] === 'query')
    expect(await createWindowsAutostart({ run }).isEnabled()).toBe(false)
  })

  it('deletes the Run value on disable, and tolerates it already being gone', async () => {
    const { calls, run } = recorder((args) => args[0] === 'delete')
    await expect(createWindowsAutostart({ run }).disable()).resolves.toBeUndefined()
    expect(calls[0]).toEqual(['delete', RUN_KEY, '/v', 'DwarfAI-Miners', '/f'])
  })

  it('removes the legacy AgentName value and rewrites the new one when it was on', async () => {
    const { calls, run } = recorder()
    await createWindowsAutostart({ run }).migrateLegacy(vi.fn(), PACKAGED)
    expect(calls.map((args) => `${args[0]} ${args[3]}`)).toEqual([
      'query AgentName',
      'delete AgentName',
      'add DwarfAI-Miners'
    ])
  })

  it('leaves an opted-out user opted out under the new name', async () => {
    const { calls, run } = recorder((args) => args[0] === 'query')
    await createWindowsAutostart({ run }).migrateLegacy(vi.fn(), PACKAGED)
    expect(calls.map((args) => args[0])).toEqual(['query'])
  })

  it('warns instead of throwing when the migration itself fails', async () => {
    const warn = vi.fn()
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'add') throw new Error('registry unavailable')
    })
    await createWindowsAutostart({ run }).migrateLegacy(warn, PACKAGED)
    expect(warn).toHaveBeenCalledOnce()
  })
})
