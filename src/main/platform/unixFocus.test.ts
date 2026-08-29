import { describe, expect, it, vi } from 'vitest'
import { selectFocusTargetPid } from '../focus'
import {
  DARWIN_TERMINAL_HOSTS,
  LINUX_TERMINAL_HOSTS,
  buildDarwinActivateCommand,
  buildUnixProcessQueryCommand,
  createDarwinFocus,
  createUnsupportedFocus,
  parseUnixProcessRows
} from './unixFocus'

describe('buildUnixProcessQueryCommand', () => {
  it('asks ps for every process as pid, parent pid and command', () => {
    // Header-less (`=` suffixes) so the output needs no header skipping, and
    // spawned as argv so no shell ever sees it.
    expect(buildUnixProcessQueryCommand()).toEqual({
      command: 'ps',
      args: ['-Ao', 'pid=,ppid=,comm=']
    })
  })
})

describe('parseUnixProcessRows', () => {
  it('parses padded ps output', () => {
    const rows = parseUnixProcessRows(
      ['  501     1 /usr/bin/login', ' 1234   501 zsh', ''].join('\n')
    )
    expect(rows).toEqual([
      { pid: 501, parentPid: 1, name: 'login' },
      { pid: 1234, parentPid: 501, name: 'zsh' }
    ])
  })

  it('keeps the basename of a macOS full-path comm, spaces included', () => {
    // macOS `ps -o comm=` prints the executable's whole path, and app bundles
    // routinely have spaces in it.
    const rows = parseUnixProcessRows(
      '  77   1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n'
    )
    expect(rows).toEqual([{ pid: 77, parentPid: 1, name: 'Electron' }])
  })

  it('skips malformed and empty lines instead of throwing', () => {
    expect(parseUnixProcessRows('garbage\n\n  12 x zsh\n 13 1 kitty\n')).toEqual([
      { pid: 13, parentPid: 1, name: 'kitty' }
    ])
  })
})

describe('unix terminal hosts', () => {
  it('knows the common macOS terminals', () => {
    for (const host of ['terminal', 'iterm2', 'wezterm-gui', 'alacritty', 'kitty', 'ghostty']) {
      expect(DARWIN_TERMINAL_HOSTS.has(host)).toBe(true)
    }
  })

  it('knows the common Linux terminals', () => {
    for (const host of ['gnome-terminal-server', 'konsole', 'xfce4-terminal', 'xterm', 'kitty']) {
      expect(LINUX_TERMINAL_HOSTS.has(host)).toBe(true)
    }
  })

  it('walks the ancestor chain to a macOS terminal host', () => {
    const rows = [
      { pid: 900, parentPid: 800, name: 'node' },
      { pid: 800, parentPid: 700, name: 'zsh' },
      { pid: 700, parentPid: 1, name: 'iTerm2' }
    ]
    expect(selectFocusTargetPid(rows, 900, DARWIN_TERMINAL_HOSTS)).toBe(700)
  })

  it('reports no target when the chain reaches no known terminal', () => {
    const rows = [
      { pid: 900, parentPid: 800, name: 'node' },
      { pid: 800, parentPid: 1, name: 'launchd' }
    ]
    expect(selectFocusTargetPid(rows, 900, DARWIN_TERMINAL_HOSTS)).toBeNull()
  })
})

describe('buildDarwinActivateCommand', () => {
  it('foregrounds the process with that unix id through System Events', () => {
    const activate = buildDarwinActivateCommand(700)
    expect(activate.command).toBe('osascript')
    expect(activate.args).toEqual([
      '-e',
      'tell application "System Events" to set frontmost of (first process whose unix id is 700) to true'
    ])
  })

  it('only ever interpolates a number, so nothing can be injected', () => {
    expect(buildDarwinActivateCommand(12).args[1]).toContain('unix id is 12)')
  })
})

describe('createDarwinFocus', () => {
  const psRows = [
    '  900   800 /usr/local/bin/node',
    '  800   700 /bin/zsh',
    '  700     1 iTerm2'
  ].join('\n')

  it('queries ps, walks to the terminal host and activates it', async () => {
    const seen: string[] = []
    const focus = createDarwinFocus(async (probe) => {
      seen.push([probe.command, ...probe.args].join(' '))
      return probe.command === 'ps' ? psRows : ''
    })
    expect(await focus(900)).toBe(true)
    expect(seen[0]).toBe('ps -Ao pid=,ppid=,comm=')
    expect(seen[1]).toContain('unix id is 700')
  })

  it('does not activate anything when the chain has no terminal', async () => {
    const run = vi.fn(async () => '  900   1 /usr/local/bin/node\n')
    const focus = createDarwinFocus(run)
    expect(await focus(900)).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })

  it('reports failure instead of throwing when osascript is unavailable', async () => {
    const focus = createDarwinFocus(async (probe) => {
      if (probe.command === 'ps') return psRows
      throw new Error('osascript: permission denied')
    })
    expect(await focus(900)).toBe(false)
  })
})

describe('createUnsupportedFocus', () => {
  it('always reports failure so activation falls through to the transcript viewer', async () => {
    // Linux window managers disagree far too much (wmctrl, xdotool, Wayland
    // portals, none of them present by default) to guess at. Reporting an
    // honest "no" sends the click to the terminal/feed fallback instead.
    expect(await createUnsupportedFocus()(1234)).toBe(false)
  })
})
