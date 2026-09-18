import { describe, expect, it } from 'vitest'
import type { ProbeCommand } from './processProbe'
import {
  AUTOMATION_PERMISSION_DENIED,
  TERMINAL_HOST_UNMEASURED,
  TTY_UNKNOWN,
  buildPidTtyCommand,
  buildTerminalTabTtyCommand,
  createDarwinConsoleReach,
  darwinConsoleReachFor,
  isAutomationPermissionDenied,
  parsePidTty,
  parseTerminalTabTtys
} from './darwinTabReach'

describe('buildPidTtyCommand', () => {
  it('asks ps for one pid s controlling terminal with no header', () => {
    expect(buildPidTtyCommand(4321)).toEqual({ command: 'ps', args: ['-o', 'tty=', '-p', '4321'] })
  })

  // Fail closed, the guard consoleInputWrite.ts holds for the same reason: a
  // pid that cannot name a process must never reach a command.
  it.each([0, -1, 1.5, Number.NaN])('refuses the unusable pid %p', (pid) => {
    expect(buildPidTtyCommand(pid)).toBeNull()
  })
})

describe('parsePidTty', () => {
  it('turns ps s short name into the device path AppleScript reports', () => {
    expect(parsePidTty('ttys001 \n')).toBe('/dev/ttys001')
  })

  it('reads a name ps already printed as a device path', () => {
    expect(parsePidTty('/dev/ttys001\n')).toBe('/dev/ttys001')
  })

  // `??` is ps saying the process has no controlling terminal at all — a
  // headless `claude -p` run, or a session started by a daemon. There is no tab
  // to match, and guessing one would write into a stranger s.
  it.each(['??\n', '\n', '   ', 'ttys001 ttys002\n'])('refuses %p', (stdout) => {
    expect(parsePidTty(stdout)).toBeNull()
  })
})

describe('buildTerminalTabTtyCommand', () => {
  it('asks Terminal.app for every tab s tty', () => {
    const command = buildTerminalTabTtyCommand()
    expect(command.command).toBe('osascript')
    expect(command.args[0]).toBe('-e')
    expect(command.args[1]).toContain('tell application "Terminal"')
    expect(command.args[1]).toContain('tty of every tab of every window')
  })
})

describe('parseTerminalTabTtys', () => {
  // The exact shape measured on Terminal.app 470.2: one comma-separated line.
  it('reads the comma separated list osascript prints', () => {
    expect(parseTerminalTabTtys('/dev/ttys002, /dev/ttys001, /dev/ttys000\n')).toEqual([
      '/dev/ttys002',
      '/dev/ttys001',
      '/dev/ttys000'
    ])
  })

  it('reads a single tab with no comma in it', () => {
    expect(parseTerminalTabTtys('/dev/ttys000\n')).toEqual(['/dev/ttys000'])
  })

  it('reads nothing out of empty output', () => {
    expect(parseTerminalTabTtys('\n')).toEqual([])
  })
})

describe('darwinConsoleReachFor', () => {
  // Named by reference, so there is no foreground requirement: this is the
  // whole difference from the Windows verdict, which has to raise a window.
  it('reaches its own console when a tab carries that tty', () => {
    expect(darwinConsoleReachFor('/dev/ttys001', ['/dev/ttys002', '/dev/ttys001'])).toEqual({
      reach: 'own-console',
      tty: '/dev/ttys001'
    })
  })

  it('refuses a tty no Terminal tab carries, and names the unmeasured hosts', () => {
    const verdict = darwinConsoleReachFor('/dev/ttys009', ['/dev/ttys000'])
    expect(verdict.reach).toBe('terminal-host')
    expect(verdict).toMatchObject({ error: TERMINAL_HOST_UNMEASURED })
  })

  it('refuses a session with no tty at all', () => {
    expect(darwinConsoleReachFor(null, ['/dev/ttys000'])).toEqual({
      reach: 'terminal-host',
      error: TTY_UNKNOWN
    })
  })
})

describe('isAutomationPermissionDenied', () => {
  // osascript error -1743 is TCC refusing this app permission to control
  // Terminal. Every other failure is something else and must not claim it.
  it('recognises the -1743 TCC refusal', () => {
    expect(isAutomationPermissionDenied(new Error('execution error: Not authorized (-1743)'))).toBe(
      true
    )
  })

  it.each([new Error('no tab for that tty (1)'), new Error('spawn ENOENT'), 'not an error'])(
    'does not claim %p is a permission problem',
    (error) => {
      expect(isAutomationPermissionDenied(error)).toBe(false)
    }
  )
})

describe('createDarwinConsoleReach', () => {
  function runnerFor(answers: Map<string, string | Error>) {
    const seen: ProbeCommand[] = []
    const run = async (command: ProbeCommand): Promise<string> => {
      seen.push(command)
      const answer = answers.get(command.command)
      if (answer === undefined) throw new Error(`unexpected ${command.command}`)
      if (answer instanceof Error) throw answer
      return answer
    }
    return { run, seen }
  }

  it('resolves a pid through ps and Terminal to its own console', async () => {
    const { run, seen } = runnerFor(
      new Map<string, string | Error>([
        ['ps', 'ttys001 \n'],
        ['osascript', '/dev/ttys002, /dev/ttys001\n']
      ])
    )
    expect(await createDarwinConsoleReach(run)(4321)).toEqual({
      reach: 'own-console',
      tty: '/dev/ttys001'
    })
    expect(seen.map((command) => command.command)).toEqual(['ps', 'osascript'])
  })

  it('refuses without asking Terminal when the pid has no tty', async () => {
    const { run, seen } = runnerFor(new Map<string, string | Error>([['ps', '??\n']]))
    expect(await createDarwinConsoleReach(run)(4321)).toEqual({
      reach: 'terminal-host',
      error: TTY_UNKNOWN
    })
    expect(seen.map((command) => command.command)).toEqual(['ps'])
  })

  it('refuses an unbuildable pid without running anything', async () => {
    const { run, seen } = runnerFor(new Map())
    expect(await createDarwinConsoleReach(run)(0)).toEqual({
      reach: 'terminal-host',
      error: TTY_UNKNOWN
    })
    expect(seen).toEqual([])
  })

  it('names the Automation permission when osascript is refused by TCC', async () => {
    const { run } = runnerFor(
      new Map<string, string | Error>([
        ['ps', 'ttys001\n'],
        ['osascript', new Error('execution error: Not authorized to send Apple events (-1743)')]
      ])
    )
    expect(await createDarwinConsoleReach(run)(4321)).toEqual({
      reach: 'terminal-host',
      error: AUTOMATION_PERMISSION_DENIED
    })
  })

  it('refuses on any other osascript failure without claiming a permission problem', async () => {
    const { run } = runnerFor(
      new Map<string, string | Error>([
        ['ps', 'ttys001\n'],
        ['osascript', new Error('Terminal got an error')]
      ])
    )
    expect(await createDarwinConsoleReach(run)(4321)).toEqual({
      reach: 'terminal-host',
      error: TERMINAL_HOST_UNMEASURED
    })
  })
})
