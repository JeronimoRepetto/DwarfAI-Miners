import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { ProbeCommand } from './processProbe'
import type { EndProcessCommand } from './processEnd'
import type { SpawnFn, SpawnedProcess } from './terminalLauncher'
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

  /*
   * The exit from a session this panel launched (#217). Ending a TREE is the
   * per-OS half of it — a Windows tree kill, a POSIX process-group signal —
   * so it is selected here like every other adapter, and the argv itself is
   * asserted in processEnd's own tests.
   */
  it('ends a process tree via taskkill on Windows and a group signal elsewhere', async () => {
    const seen: EndProcessCommand[] = []
    const endRun = async (command: EndProcessCommand): Promise<void> => {
      seen.push(command)
    }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      await createPlatformAdapters(options(platform, { endRun })).processEnd.endProcessTree(4242)
    }
    expect(seen.map((command) => command.command)).toEqual(['taskkill', 'kill', 'kill'])
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

describe('createPlatformAdapters — CLI detection (#91)', () => {
  it('detects a conventionally-installed claude through the composed fs', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/claude', '#!/bin/sh\n')
    const adapters = createPlatformAdapters(options('linux', { fs }))
    expect(await adapters.cliDetector.detect('claude')).toEqual({
      cli: 'claude',
      installed: true,
      path: '/home/j/.local/bin/claude',
      source: 'convention'
    })
  })

  it('lets a config override reach the detector and win over convention', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/codex', 'convention')
    fs.addFile('/opt/codex/codex', 'override')
    const adapters = createPlatformAdapters(
      options('linux', { fs, cliOverrides: { codex: '/opt/codex/codex' } })
    )
    expect(await adapters.cliDetector.detect('codex')).toEqual({
      cli: 'codex',
      installed: true,
      path: '/opt/codex/codex',
      source: 'override'
    })
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

  /**
   * Kick's terminal tier reaches macOS and Linux (#366), and the composition is
   * what carries it there: the port needs the process-END port to signal the pid
   * and the PROBE port to verify it first, and both are the same instances every
   * other caller reads — the pid-reuse guard above all, so two answers about one
   * pid can never come from two different probes.
   *
   * Asserted through the injected runners rather than by inspecting the port:
   * what matters is that the end tier really signals, and really refuses when
   * the probe disagrees.
   */
  it('hands the POSIX port the process-end and probe ports its end tier needs', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const probed: ProbeCommand[] = []
      const probeRun = async (command: ProbeCommand) => {
        probed.push(command)
        return '' // nothing this platform's parser can read
      }
      const killed: EndProcessCommand[] = []
      const endRun = async (command: EndProcessCommand) => {
        killed.push(command)
      }
      const adapters = createPlatformAdapters(options(platform, { endRun, probeRun }))

      expect(typeof adapters.textDelivery.endConsoleSession).toBe('function')
      // Fail closed: the probe could not answer, so nothing is signalled — and
      // the probe it asked is this platform's own, through the port composed
      // here (#231).
      await expect(
        adapters.textDelivery.endConsoleSession!({
          pid: 4242,
          expectedStartMs: 1_788_001_972_136
        })
      ).resolves.toMatchObject({ delivered: false })
      expect(probed.map((command) => command.command)).toEqual([
        platform === 'darwin' ? 'ps' : 'cat'
      ])
      expect(killed).toEqual([])
    }
  })

  /*
   * And the other half of the same wiring: a pid the probe DOES vouch for is
   * signalled directly — `kill -TERM <pid>`, never `-4242`, the process group
   * only a launched session leads (#217, #366).
   *
   * The signal is made to fail so the assertion stays on the argv and the
   * grace window is never entered: this test is about what the composition
   * addresses, and the tier's own behaviour is pinned in posixTextDelivery's
   * tests with an injected clock.
   */
  it('signals the verified pid itself, through the composed end port', async () => {
    const killed: EndProcessCommand[] = []
    const endRun = async (command: EndProcessCommand) => {
      killed.push(command)
      throw new Error('kill: no such process')
    }
    const probeRun = async () => 'Sat Aug 29 11:07:36 2026\n'
    const adapters = createPlatformAdapters(options('darwin', { endRun, probeRun }))

    await expect(
      adapters.textDelivery.endConsoleSession!({
        pid: 4242,
        expectedStartMs: new Date(2026, 7, 29, 11, 7, 36).getTime()
      })
    ).resolves.toMatchObject({ delivered: false })
    expect(killed).toEqual([{ command: 'kill', args: ['-TERM', '4242'] }])
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

  /**
   * The Codex queue tier (#97) reaches its binary through the SAME detection
   * port the rest of the app uses (#91) — not through a second hardcoded path.
   * That is what makes CODEX_CLI_PATH work for it, and what keeps the queue on
   * every platform, since it spawns a CLI like the relay does.
   */
  it('resolves the codex queue binary through the CLI detection port on every platform', async () => {
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const paths: Array<string | undefined> = []
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const fs = new FakeFs()
      const binary =
        platform === 'win32' ? 'C:\\Users\\j\\.local\\bin\\codex.exe' : '/home/j/.local/bin/codex'
      fs.addFile(binary, 'codex')
      const adapters = createPlatformAdapters(options(platform, { fs, runCodexQueue }))
      await expect(
        adapters.textDelivery.queueToCodexThread!({ threadId: 'thread-1', text: 'hi' })
      ).resolves.toEqual({ delivered: true })
      paths.push(runCodexQueue.mock.calls.at(-1)?.[0].command)
    }
    expect(paths).toEqual([
      'C:\\Users\\j\\.local\\bin\\codex.exe',
      '/home/j/.local/bin/codex',
      '/home/j/.local/bin/codex'
    ])
  })

  it('honours the CODEX_CLI_PATH override for the queue binary', async () => {
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/codex', 'convention')
    fs.addFile('/opt/codex/codex', 'override')
    const adapters = createPlatformAdapters(
      options('linux', { fs, runCodexQueue, cliOverrides: { codex: '/opt/codex/codex' } })
    )
    await adapters.textDelivery.queueToCodexThread!({ threadId: 'thread-1', text: 'hi' })
    expect(runCodexQueue.mock.calls[0]?.[0].command).toBe('/opt/codex/codex')
  })

  it('refuses the queue with a reason when codex is not installed', async () => {
    const runCodexQueue = vi.fn()
    const adapters = createPlatformAdapters(options('linux', { fs: new FakeFs(), runCodexQueue }))
    const outcome = await adapters.textDelivery.queueToCodexThread!({
      threadId: 'thread-1',
      text: 'hi'
    })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
    expect(runCodexQueue).not.toHaveBeenCalled()
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
