// L3: TerminalConsoleRaiser and its per-OS chain (ADR-031 items 1, 2, 4; ADR-003 item 12; 05 R17;
// 18 §4.2 T-11) with the spawn, the focus and the launcher files injected.
import { describe, expect, it } from 'vitest'
import type { ConsoleTarget } from '@dwarfai/contracts'
import {
  consoleLaunchChain,
  WINDOWS_ARGUMENT_VARIABLES,
  WINDOWS_CONSOLE_PROGRAM,
  WINDOWS_PROGRAM_VARIABLE
} from './consoleLaunch'
import { TerminalConsoleRaiser, type SpawnFn, type SpawnOptions } from './TerminalConsoleRaiser'

const TOKEN_FILE = '/data/run/viewers/01920000-0000-7000-9000-00000000c0de.token'
const COMMAND = {
  program: '/Applications/DwarfAI Miners.app/Contents/MacOS/DwarfAI Miners',
  args: ['/app/out/host/dwarfai-viewer.js', TOKEN_FILE],
  cwd: '/data'
}
const LOG: ConsoleTarget = { mode: 'log', command: COMMAND, credentialFile: TOKEN_FILE }
const FOCUS: ConsoleTarget = { ...LOG, mode: 'focus-terminal', focus: { pid: 4242, startTime: 70 } }

interface Call {
  command: string
  args: string[]
  options: SpawnOptions
}

/** A spawn that records each call; `starts` names the commands that start, the rest fail. */
function recordingSpawn(starts: (command: string) => boolean) {
  const calls: Call[] = []
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    const ok = starts(command)
    return {
      once(event, listener) {
        if ((event === 'spawn' && ok) || (event === 'error' && !ok)) {
          queueMicrotask(() => listener(ok ? undefined : new Error('ENOENT')))
        }
      },
      unref() {}
    }
  }
  return { spawn, calls }
}

const files = () => {
  const written: Array<{ path: string; content: string }> = []
  const removed: string[] = []
  return {
    written,
    removed,
    directory: () => '/tmp',
    randomHex: () => '0123456789abcdef',
    write: (path: string, content: string) => {
      written.push({ path, content })
      return Promise.resolve()
    },
    remove: (path: string) => {
      removed.push(path)
      return Promise.resolve()
    }
  }
}

describe('TerminalConsoleRaiser', () => {
  it('[US-MSG-007.AC06, ADR-003] every platform starts the viewer with the token file path as its only credential argument, no shell, and ELECTRON_RUN_AS_NODE', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const { spawn, calls } = recordingSpawn(() => true)
      const launcher = files()
      const raiser = new TerminalConsoleRaiser({
        platform,
        env: { PATH: '/bin' },
        spawn,
        launcherFiles: launcher
      })

      expect(await raiser.raise(LOG), platform).toBe('raised')
      expect(calls, platform).toHaveLength(1)
      const call = calls[0] as Call
      expect(call.options).toEqual({
        cwd: '/data',
        env: expect.objectContaining({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }) as unknown,
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      // What reaches the terminal: the argv (and, on macOS, the launcher file), nothing else.
      const carried = [
        ...call.args,
        ...Object.values(call.options.env),
        ...launcher.written.map((w) => w.content)
      ]
      expect(carried.join('\n'), platform).toContain(TOKEN_FILE)
      expect(carried.join('\n'), platform).not.toMatch(/[0-9a-f]{64}/)
    }
  })

  it('[ADR-031] Windows runs the fixed PowerShell program, the paths only in its variables', () => {
    const [candidate] = consoleLaunchChain({ platform: 'win32', command: COMMAND })

    expect(candidate?.command).toBe('powershell.exe')
    expect(candidate?.args.at(-2)).toBe('-EncodedCommand')
    expect(Buffer.from(candidate?.args.at(-1) ?? '', 'base64').toString('utf16le')).toBe(
      WINDOWS_CONSOLE_PROGRAM
    )
    expect(candidate?.args.join(' ')).not.toContain(TOKEN_FILE)
    expect(candidate?.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      [WINDOWS_PROGRAM_VARIABLE]: COMMAND.program,
      [WINDOWS_ARGUMENT_VARIABLES[0]]: COMMAND.args[0],
      [WINDOWS_ARGUMENT_VARIABLES[1]]: TOKEN_FILE
    })
  })

  // 18 §4.2 T-11 (kept out of the title: not a catalog id).
  it('[ADR-031] macOS types only /bin/sh <launcher>; the launcher quotes the argv exactly and removes itself', async () => {
    const { spawn, calls } = recordingSpawn(() => true)
    const launcher = files()
    const tricky = { ...COMMAND, args: [COMMAND.args[0] as string, "/data/it's $(here)/v.token"] }

    await new TerminalConsoleRaiser({ platform: 'darwin', spawn, launcherFiles: launcher }).raise({
      ...LOG,
      command: tricky
    })

    expect(calls[0]?.command).toBe('osascript')
    expect(calls[0]?.args[1]).toBe(
      'tell application "Terminal" to do script "/bin/sh /tmp/dwarfai-viewer-0123456789abcdef.sh"'
    )
    expect(launcher.written[0]?.content).toBe(
      [
        '#!/bin/sh',
        'rm -f -- "$0"',
        `exec 'env' 'ELECTRON_RUN_AS_NODE=1' '${COMMAND.program}' '/app/out/host/dwarfai-viewer.js' '/data/it'\\''s $(here)/v.token'`,
        ''
      ].join('\n')
    )
  })

  it('[FM-054] a terminal that cannot be launched reports failed, trying each candidate once', async () => {
    const { spawn, calls } = recordingSpawn(() => false)
    const raiser = new TerminalConsoleRaiser({ platform: 'linux', spawn })

    expect(await raiser.raise(LOG)).toBe('failed')
    expect(calls.map((c) => c.command)).toEqual([
      'x-terminal-emulator',
      'gnome-terminal',
      'konsole',
      'xfce4-terminal',
      'xterm'
    ])
    expect(calls[1]?.args.slice(0, 3)).toEqual(['--', 'env', 'ELECTRON_RUN_AS_NODE=1'])
  })

  it('[FM-054] on macOS a launcher that never ran is removed again', async () => {
    const { spawn } = recordingSpawn(() => false)
    const launcher = files()

    expect(
      await new TerminalConsoleRaiser({ platform: 'darwin', spawn, launcherFiles: launcher }).raise(
        LOG
      )
    ).toBe('failed')
    expect(launcher.removed).toEqual(['/tmp/dwarfai-viewer-0123456789abcdef.sh'])
  })

  it('[NFR-PLAT-10] a focus-terminal target raises that process window and reports raised, launching nothing', async () => {
    const { spawn, calls } = recordingSpawn(() => true)
    const focused: number[] = []
    const raiser = new TerminalConsoleRaiser({
      platform: 'win32',
      spawn,
      focus: (pid) => {
        focused.push(pid)
        return Promise.resolve(true)
      }
    })

    expect(await raiser.raise(FOCUS)).toBe('raised')
    expect(focused).toEqual([4242])
    expect(calls).toEqual([])
  })

  it('[ADR-031] a window that cannot be raised, a focus that throws or a target missing its parts is failed', async () => {
    const { spawn, calls } = recordingSpawn(() => true)
    const no = new TerminalConsoleRaiser({
      platform: 'linux',
      spawn,
      focus: () => Promise.resolve(false)
    })
    const throws = new TerminalConsoleRaiser({
      platform: 'linux',
      spawn,
      focus: () => Promise.reject(new Error('x'))
    })

    expect(await no.raise(FOCUS)).toBe('failed')
    expect(await throws.raise(FOCUS)).toBe('failed')
    expect(await no.raise({ mode: 'focus-terminal' })).toBe('failed')
    expect(await no.raise({ mode: 'log' })).toBe('failed')
    expect(calls).toEqual([])
  })

  it('[S-031-1, S-031-3] an attach target is not built in v1: failed, nothing run', async () => {
    const { spawn, calls } = recordingSpawn(() => true)

    expect(
      await new TerminalConsoleRaiser({ platform: 'linux', spawn }).raise({
        ...LOG,
        mode: 'attach'
      })
    ).toBe('failed')
    expect(calls).toEqual([])
  })
})
