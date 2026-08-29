import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINUX_TERMINALS,
  buildDarwinTerminalCommand,
  buildFallbackArgs,
  buildLinuxTerminalCommand,
  buildPosixViewerArgv,
  buildViewerLaunchChain,
  buildWtArgs,
  launchTranscriptViewer,
  quotePosixArgv,
  resolveViewerScriptPath,
  viewerScriptName,
  type SpawnFn,
  type SpawnedProcess
} from './terminalLauncher'

describe('viewerScriptName', () => {
  it('uses the PowerShell viewer on Windows and the POSIX one elsewhere', () => {
    expect(viewerScriptName('win32')).toBe('dwarf-feed-viewer.ps1')
    expect(viewerScriptName('darwin')).toBe('dwarf-feed-viewer.sh')
    expect(viewerScriptName('linux')).toBe('dwarf-feed-viewer.sh')
  })
})

describe('resolveViewerScriptPath', () => {
  it('resolves inside process.resourcesPath once packaged', () => {
    const result = resolveViewerScriptPath(
      {
        isPackaged: true,
        resourcesPath: 'C:\\Program Files\\DwarfAI-Miners\\resources',
        appPath: 'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar'
      },
      'win32'
    )
    expect(result).toBe(
      win32.join('C:\\Program Files\\DwarfAI-Miners\\resources', 'dwarf-feed-viewer.ps1')
    )
  })

  it('resolves next to the project resources dir in dev', () => {
    const result = resolveViewerScriptPath(
      {
        isPackaged: false,
        resourcesPath: '',
        appPath: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name'
      },
      'win32'
    )
    expect(result).toBe(
      win32.join(
        'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
        'resources',
        'dwarf-feed-viewer.ps1'
      )
    )
  })

  it('builds POSIX paths for the POSIX viewer, whatever host runs the test', () => {
    expect(
      resolveViewerScriptPath(
        {
          isPackaged: true,
          resourcesPath: '/Applications/DwarfAI-Miners.app/Contents/Resources',
          appPath: '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar'
        },
        'darwin'
      )
    ).toBe('/Applications/DwarfAI-Miners.app/Contents/Resources/dwarf-feed-viewer.sh')

    expect(
      resolveViewerScriptPath(
        { isPackaged: false, resourcesPath: '', appPath: '/home/jeron/agent-name' },
        'linux'
      )
    ).toBe('/home/jeron/agent-name/resources/dwarf-feed-viewer.sh')
  })
})

describe('buildWtArgs', () => {
  it('opens a titled new tab running the viewer script against the transcript', () => {
    const args = buildWtArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-w',
      '-1',
      'new-tab',
      '--title',
      'Foreman',
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      '-Title',
      'Foreman'
    ])
  })
})

describe('buildFallbackArgs', () => {
  it('runs the viewer script directly for a standalone PowerShell window', () => {
    const args = buildFallbackArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      '-Title',
      'Foreman'
    ])
  })
})

describe('buildPosixViewerArgv', () => {
  it('runs the shipped script through sh, so no execute bit is needed', () => {
    expect(
      buildPosixViewerArgv({
        title: 'Foreman',
        viewerScriptPath: '/app/resources/dwarf-feed-viewer.sh',
        transcriptPath: '/home/jeron/.claude/projects/enc/s1.jsonl',
        nodePath: '/opt/DwarfAI-Miners/dwarfai-miners'
      })
    ).toEqual([
      'sh',
      '/app/resources/dwarf-feed-viewer.sh',
      '--path',
      '/home/jeron/.claude/projects/enc/s1.jsonl',
      '--title',
      'Foreman',
      // The viewer parses JSONL with the Node runtime the app already ships,
      // so no system Node is required on the user's machine.
      '--node',
      '/opt/DwarfAI-Miners/dwarfai-miners'
    ])
  })
})

describe('quotePosixArgv', () => {
  it('quotes every argument literally', () => {
    expect(quotePosixArgv(['sh', '/a b/c.sh', '--title', 'My Mine'])).toBe(
      "'sh' '/a b/c.sh' '--title' 'My Mine'"
    )
  })

  it('survives an argument containing a single quote', () => {
    // A project directory called `jeron's stuff` must not end the literal and
    // leave the rest of the path running as shell source.
    expect(quotePosixArgv(["jeron's stuff"])).toBe("'jeron'\\''s stuff'")
  })
})

describe('buildDarwinTerminalCommand', () => {
  const launch = buildDarwinTerminalCommand(['sh', '/app/viewer.sh', '--title', 'Foreman'])

  it('asks Terminal.app to run the command and come forward', () => {
    expect(launch.command).toBe('osascript')
    expect(launch.args[0]).toBe('-e')
    expect(launch.args[1]).toContain('tell application "Terminal" to do script')
    expect(launch.args[3]).toBe('tell application "Terminal" to activate')
  })

  it('carries the shell-quoted argv as the script to run', () => {
    expect(launch.args[1]).toContain("'sh' '/app/viewer.sh' '--title' 'Foreman'")
  })

  it('escapes the shell command line for the AppleScript literal it sits in', () => {
    // Two parsers, two escapes: the shell must see the quotes literally, and
    // AppleScript must not end its own string early on them.
    const quoted = buildDarwinTerminalCommand(['echo', 'say "hi"']).args[1] as string
    expect(quoted).toBe(`tell application "Terminal" to do script "'echo' 'say \\"hi\\"'"`)
  })
})

describe('buildLinuxTerminalCommand', () => {
  it('uses the exec flag each terminal actually accepts', () => {
    expect(buildLinuxTerminalCommand('gnome-terminal', ['sh', 'v.sh']).args).toEqual([
      '--',
      'sh',
      'v.sh'
    ])
    expect(buildLinuxTerminalCommand('xfce4-terminal', ['sh', 'v.sh']).args).toEqual([
      '-x',
      'sh',
      'v.sh'
    ])
    for (const terminal of ['x-terminal-emulator', 'konsole', 'xterm']) {
      expect(buildLinuxTerminalCommand(terminal, ['sh', 'v.sh']).args).toEqual(['-e', 'sh', 'v.sh'])
    }
  })
})

describe('buildViewerLaunchChain', () => {
  const options = {
    title: 'Foreman',
    viewerScriptPath: '/app/viewer.sh',
    transcriptPath: '/logs/s.jsonl',
    nodePath: '/app/node'
  }

  it('tries Windows Terminal before a standalone PowerShell window', () => {
    const chain = buildViewerLaunchChain({ ...options, platform: 'win32' })
    expect(chain.map((launch) => launch.command)).toEqual(['wt.exe', 'powershell.exe'])
  })

  it('has one candidate on macOS: Terminal.app through osascript', () => {
    const chain = buildViewerLaunchChain({ ...options, platform: 'darwin' })
    expect(chain.map((launch) => launch.command)).toEqual(['osascript'])
  })

  it('walks the Linux terminal chain, most portable first', () => {
    // No Linux terminal is guaranteed installed, so every candidate gets a
    // turn rather than the app declaring defeat after the first ENOENT.
    const chain = buildViewerLaunchChain({ ...options, platform: 'linux' })
    expect(chain.map((launch) => launch.command)).toEqual([...LINUX_TERMINALS])
    expect(LINUX_TERMINALS[0]).toBe('x-terminal-emulator')
  })
})

/** A fake child process the test controls: no real process is ever spawned. */
function fakeChild(): {
  proc: SpawnedProcess
  emit: (event: 'error' | 'spawn', error?: Error) => void
} {
  const listeners = new Map<string, (error?: Error) => void>()
  return {
    proc: {
      once: (event, listener) => {
        listeners.set(event, listener)
      },
      unref: () => {}
    },
    emit: (event, error) => listeners.get(event)?.(error)
  }
}

describe('launchTranscriptViewer', () => {
  it('returns true once wt.exe actually spawns, and never tries the fallback', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('spawn'))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe'])
  })

  it('falls back to a standalone PowerShell window when wt.exe is missing', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      if (command === 'wt.exe') {
        queueMicrotask(() => fake.emit('error', new Error('ENOENT')))
      } else {
        queueMicrotask(() => fake.emit('spawn'))
      }
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe', 'powershell.exe'])
  })

  it('returns false when both wt.exe and the PowerShell fallback fail to spawn', async () => {
    const spawn: SpawnFn = () => {
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('error', new Error('nope')))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(false)
  })

  it('opens Terminal.app through osascript on macOS', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('spawn'))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'darwin',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['osascript'])
  })

  it('keeps trying Linux terminals until one is actually installed', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => {
        if (command === 'konsole') fake.emit('spawn')
        else fake.emit('error', new Error('ENOENT'))
      })
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'linux',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  })

  it('returns false when no Linux terminal is installed at all', async () => {
    const spawn: SpawnFn = () => {
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('error', new Error('ENOENT')))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'linux',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(false)
  })
})
