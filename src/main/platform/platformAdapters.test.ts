import { describe, expect, it, vi } from 'vitest'
import type { ProbeCommand } from '../adapters/processProbe'
import type { SpawnFn, SpawnedProcess } from '../terminalLauncher'
import { createAutostartPort, createPlatformAdapters, type Platform } from './platformAdapters'

function options(platform: Platform, overrides: Record<string, unknown> = {}) {
  return {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\j' : '/home/j',
    appPaths: {
      isPackaged: false,
      resourcesPath: '',
      appPath: platform === 'win32' ? 'C:\\repo' : '/repo'
    },
    relayModel: 'haiku',
    relayTimeoutMs: 1_000,
    nodePath: '/app/node',
    env: {},
    ...overrides
  }
}

function spawnAlways(succeeds: boolean): { spawn: SpawnFn; commands: string[] } {
  const commands: string[] = []
  const spawn: SpawnFn = (command) => {
    commands.push(command)
    const listeners = new Map<string, (error?: Error) => void>()
    const proc: SpawnedProcess = {
      once: (event, listener) => {
        listeners.set(event, listener)
      },
      unref: () => {}
    }
    queueMicrotask(() =>
      succeeds ? listeners.get('spawn')?.() : listeners.get('error')?.(new Error('ENOENT'))
    )
    return proc
  }
  return { spawn, commands }
}

describe('createPlatformAdapters — process probe', () => {
  it('probes with PowerShell on Windows and pgrep on POSIX', async () => {
    const seen: ProbeCommand[] = []
    const probeRun = async (command: ProbeCommand) => {
      seen.push(command)
      return ''
    }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      await createPlatformAdapters(
        options(platform, { probeRun })
      ).processProbe.isCodexProcessRunning()
    }
    expect(seen.map((command) => command.command)).toEqual(['powershell.exe', 'pgrep', 'pgrep'])
  })

  it('resolves a process start time via Get-Process, /proc and ps lstart per platform', async () => {
    const seen: ProbeCommand[] = []
    const probeRun = async (command: ProbeCommand) => {
      seen.push(command)
      return ''
    }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      await createPlatformAdapters(options(platform, { probeRun })).processProbe.processStartTimeMs(
        42
      )
    }
    expect(seen.map((command) => command.command)).toEqual(['powershell.exe', 'ps', 'cat'])
  })
})

describe('createPlatformAdapters — focus', () => {
  it('uses the PowerShell user32 path on Windows', async () => {
    const runShell = vi.fn().mockResolvedValue({ stdout: '[]', exitCode: 0 })
    await createPlatformAdapters(options('win32', { runShell })).focusPid(42)
    // Console-window resolution (pid-exact) runs first...
    expect(runShell.mock.calls[0]?.[0]).toContain('AttachConsole')
    // ...falling back to the ancestor-name chain walk once it reports no handle.
    expect(runShell.mock.calls[1]?.[0]).toContain('Get-CimInstance Win32_Process')
  })

  it('uses ps plus osascript on macOS', async () => {
    const seen: string[] = []
    const runCommand = async (command: ProbeCommand) => {
      seen.push(command.command)
      return command.command === 'ps' ? '  42     7 /bin/zsh\n   7     1 iTerm2\n' : ''
    }
    expect(await createPlatformAdapters(options('darwin', { runCommand })).focusPid(42)).toBe(true)
    expect(seen).toEqual(['ps', 'osascript'])
  })

  it('refuses to focus on Linux without running anything', async () => {
    const runCommand = vi.fn()
    const runShell = vi.fn()
    const adapters = createPlatformAdapters(options('linux', { runCommand, runShell }))
    expect(await adapters.focusPid(42)).toBe(false)
    expect(runCommand).not.toHaveBeenCalled()
    expect(runShell).not.toHaveBeenCalled()
  })
})

describe('createPlatformAdapters — transcript viewer', () => {
  it('resolves the PowerShell viewer and opens Windows Terminal on Windows', async () => {
    const { spawn, commands } = spawnAlways(true)
    const adapters = createPlatformAdapters(options('win32', { spawn }))
    expect(adapters.viewerScriptPath).toBe('C:\\repo\\resources\\dwarf-feed-viewer.ps1')
    expect(await adapters.launchTranscriptViewer('Foreman', 'C:\\log.jsonl')).toBe(true)
    expect(commands).toEqual(['wt.exe'])
  })

  it('resolves the POSIX viewer and opens Terminal.app on macOS', async () => {
    const { spawn, commands } = spawnAlways(true)
    const adapters = createPlatformAdapters(options('darwin', { spawn }))
    expect(adapters.viewerScriptPath).toBe('/repo/resources/dwarf-feed-viewer.sh')
    expect(await adapters.launchTranscriptViewer('Foreman', '/log.jsonl')).toBe(true)
    expect(commands).toEqual(['osascript'])
  })

  it('walks the terminal chain on Linux', async () => {
    const { spawn, commands } = spawnAlways(false)
    const adapters = createPlatformAdapters(options('linux', { spawn }))
    expect(adapters.viewerScriptPath).toBe('/repo/resources/dwarf-feed-viewer.sh')
    expect(await adapters.launchTranscriptViewer('Foreman', '/log.jsonl')).toBe(false)
    expect(commands[0]).toBe('x-terminal-emulator')
    expect(commands).toHaveLength(5)
  })
})

describe('createPlatformAdapters — text delivery', () => {
  it('offers console input on Windows', () => {
    expect(createPlatformAdapters(options('win32')).textDelivery.supportsConsoleInput).toBe(true)
  })

  it('never offers console input on Linux', () => {
    expect(createPlatformAdapters(options('linux')).textDelivery.supportsConsoleInput).toBe(false)
  })

  it('keeps the macOS console-input path gated off by default', () => {
    // The osascript builders are unit-tested but not integration-verified, and
    // System Events additionally needs Accessibility permission. Until that is
    // checked on a real Mac the panel shows the honest disabled button rather
    // than a send that silently does nothing.
    expect(createPlatformAdapters(options('darwin')).textDelivery.supportsConsoleInput).toBe(false)
  })

  it('can be switched on for macOS once it has been verified', async () => {
    const seen: ProbeCommand[] = []
    const runCommand = async (command: ProbeCommand) => {
      seen.push(command)
      return command.command === 'ps' ? '  42     1 iTerm2\n' : ''
    }
    const adapters = createPlatformAdapters(
      options('darwin', { darwinConsoleInput: true, runCommand })
    )
    expect(adapters.textDelivery.supportsConsoleInput).toBe(true)

    // And it really types: the gate must not leave behind a stub that reports
    // success while running nothing.
    await expect(
      adapters.textDelivery.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    ).resolves.toEqual({ delivered: true })
    expect(seen.map((command) => command.command)).toEqual(['ps', 'osascript', 'osascript'])
    expect(seen[2]?.args[1]).toContain('keystroke "hi"')
  })

  it('keeps the relay tier available on every platform', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const adapters = createPlatformAdapters(options(platform, { runRelay }))
      await expect(
        adapters.textDelivery.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
      ).resolves.toEqual({ delivered: true })
    }
    expect(runRelay.mock.calls.map((call) => call[0].command)).toEqual([
      'C:\\Users\\j\\.local\\bin\\claude.exe',
      '/home/j/.local/bin/claude',
      '/home/j/.local/bin/claude'
    ])
  })
})

describe('createAutostartPort', () => {
  it('selects the registry, the LaunchAgent and the XDG entry per platform', async () => {
    const written: string[] = []
    const fs = {
      writeFile: async (path: string) => {
        written.push(path)
      },
      removeFile: async () => {},
      fileExists: async () => false
    }
    const regRun = vi.fn(async () => {})

    await createAutostartPort({
      platform: 'win32',
      home: 'C:\\Users\\j',
      env: {},
      regRun
    }).enable({ executable: 'C:\\App.exe', args: [] })
    await createAutostartPort({ platform: 'darwin', home: '/Users/j', env: {}, fs }).enable({
      executable: '/App',
      args: []
    })
    await createAutostartPort({ platform: 'linux', home: '/home/j', env: {}, fs }).enable({
      executable: '/App',
      args: []
    })

    expect(regRun).toHaveBeenCalledOnce()
    expect(written).toEqual([
      '/Users/j/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist',
      '/home/j/.config/autostart/dwarfai-miners.desktop'
    ])
  })
})
