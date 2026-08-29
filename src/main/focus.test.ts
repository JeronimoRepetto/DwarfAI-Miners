import { describe, expect, it } from 'vitest'
import {
  buildConsoleWindowProbeCommand,
  buildFocusCommand,
  buildFocusHandleCommand,
  buildProcessQueryCommand,
  focusPid,
  parseConsoleWindowHandle,
  parseProcessRows,
  resolveFocusTarget,
  selectFocusTargetPid,
  WINDOWS_TERMINAL_HOSTS,
  type ProcessRow
} from './focus'

function row(pid: number, parentPid: number, name: string): ProcessRow {
  return { pid, parentPid, name }
}

describe('buildProcessQueryCommand', () => {
  it('queries Win32_Process for pid, parent and name as compact JSON', () => {
    const command = buildProcessQueryCommand()
    expect(command).toContain('Get-CimInstance Win32_Process')
    expect(command).toContain('ProcessId')
    expect(command).toContain('ParentProcessId')
    expect(command).toContain('ConvertTo-Json')
  })
})

describe('parseProcessRows', () => {
  it('parses an array of CIM rows', () => {
    const rows = parseProcessRows([
      { ProcessId: 100, ParentProcessId: 90, Name: 'claude.exe' },
      { ProcessId: 90, ParentProcessId: 80, Name: 'node.exe' }
    ])
    expect(rows).toEqual([row(100, 90, 'claude.exe'), row(90, 80, 'node.exe')])
  })

  it('wraps the single-object form ConvertTo-Json produces for one row', () => {
    expect(parseProcessRows({ ProcessId: 1, ParentProcessId: 0, Name: 'x.exe' })).toEqual([
      row(1, 0, 'x.exe')
    ])
  })

  it('skips malformed rows and returns [] for garbage', () => {
    expect(parseProcessRows('nope')).toEqual([])
    expect(parseProcessRows([{ ProcessId: 'x' }, null])).toEqual([])
  })
})

describe('WINDOWS_TERMINAL_HOSTS', () => {
  it('includes herdr.exe as a defensive backstop, even though its MainWindowHandle is 0', () => {
    expect(WINDOWS_TERMINAL_HOSTS.has('herdr.exe')).toBe(true)
  })
})

describe('selectFocusTargetPid', () => {
  const chain = [
    row(100, 90, 'claude.exe'),
    row(90, 85, 'node.exe'),
    row(85, 80, 'cmd.exe'),
    row(80, 1, 'WindowsTerminal.exe'),
    row(1, 0, 'wininit.exe')
  ]

  it('walks the parent chain up to the hosting terminal', () => {
    expect(selectFocusTargetPid(chain, 100)).toBe(80)
  })

  it('matches terminal host names case-insensitively', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'CONHOST.EXE')]
    expect(selectFocusTargetPid(rows, 10)).toBe(5)
  })

  it('finds VS Code as a hosting terminal', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'Code.exe')]
    expect(selectFocusTargetPid(rows, 10)).toBe(5)
  })

  it('returns null when no terminal host is in the chain', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'services.exe')]
    expect(selectFocusTargetPid(rows, 10)).toBeNull()
  })

  it('returns null for an unknown start pid', () => {
    expect(selectFocusTargetPid(chain, 999)).toBeNull()
  })

  it('survives parent-pid cycles', () => {
    const rows = [row(10, 20, 'a.exe'), row(20, 10, 'b.exe')]
    expect(selectFocusTargetPid(rows, 10)).toBeNull()
  })
})

describe('buildConsoleWindowProbeCommand', () => {
  it('attaches to the target pid console and reads its window handle', () => {
    const command = buildConsoleWindowProbeCommand(4242)
    expect(command).toContain('AttachConsole(4242)')
    expect(command).toContain('GetConsoleWindow')
  })

  it('detaches from any console this process already holds before attaching, and again after', () => {
    const command = buildConsoleWindowProbeCommand(4242)
    const firstFree = command.indexOf('FreeConsole()')
    const attach = command.indexOf('AttachConsole(4242)')
    expect(firstFree).toBeGreaterThanOrEqual(0)
    expect(attach).toBeGreaterThan(firstFree)
    // FreeConsole runs a second time after a successful attach, so it is not left dangling.
    expect(command.lastIndexOf('FreeConsole()')).toBeGreaterThan(attach)
  })

  it('prints the handle so the caller can parse it back from stdout', () => {
    expect(buildConsoleWindowProbeCommand(4242)).toContain('[Console]::Out.Write')
  })
})

describe('parseConsoleWindowHandle', () => {
  it('parses a positive handle printed by the probe command', () => {
    expect(parseConsoleWindowHandle('555555')).toBe(555555)
  })

  it('treats empty or blank output as no handle', () => {
    expect(parseConsoleWindowHandle('')).toBe(0)
    expect(parseConsoleWindowHandle('   ')).toBe(0)
  })

  it('treats a zero handle as no handle', () => {
    expect(parseConsoleWindowHandle('0')).toBe(0)
  })

  it('treats malformed output as no handle instead of throwing', () => {
    expect(parseConsoleWindowHandle('not a number')).toBe(0)
    expect(parseConsoleWindowHandle('-5')).toBe(0)
  })
})

describe('buildFocusHandleCommand', () => {
  it('drives the same hardened foreground sequence as buildFocusCommand, on an already-known handle', () => {
    const command = buildFocusHandleCommand(555555)
    expect(command).toContain('555555')
    expect(command).toContain('SetForegroundWindow')
    expect(command).toContain('ShowWindow')
    expect(command).toContain('IsIconic')
    expect(command).toContain('AttachThreadInput')
    expect(command).toContain('[Win32.Native]::GetForegroundWindow() -eq $handle')
  })

  it('does not resolve the handle through Get-Process, unlike buildFocusCommand', () => {
    expect(buildFocusHandleCommand(555555)).not.toContain('Get-Process')
  })
})

describe('resolveFocusTarget', () => {
  // These rows would resolve to pid 5 via the ancestor chain walk.
  const hostRows = [row(10, 5, 'claude.exe'), row(5, 1, 'WindowsTerminal.exe')]

  it('prefers a nonzero console handle and skips the ancestor chain walk entirely', () => {
    expect(resolveFocusTarget(999, hostRows, 10)).toEqual({ kind: 'handle', handle: 999 })
  })

  it('falls back to the ancestor chain walk when the console handle is zero', () => {
    expect(resolveFocusTarget(0, hostRows, 10)).toEqual({ kind: 'pid', pid: 5 })
  })

  it('returns null when both the console handle and the ancestor chain walk miss', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'services.exe')]
    expect(resolveFocusTarget(0, rows, 10)).toBeNull()
  })
})

describe('buildFocusCommand', () => {
  it('brings the target process window to the foreground via user32', () => {
    const command = buildFocusCommand(4242)
    expect(command).toContain('4242')
    expect(command).toContain('SetForegroundWindow')
    expect(command).toContain('ShowWindow')
    expect(command).toContain('MainWindowHandle')
  })

  it('restores a minimized window before foregrounding it', () => {
    const command = buildFocusCommand(4242)
    expect(command).toContain('IsIconic')
    // SW_RESTORE
    expect(command).toContain('ShowWindow($handle, 9)')
  })

  it('attaches to the foreground thread input to lift the SetForegroundWindow restriction', () => {
    const command = buildFocusCommand(4242)
    expect(command).toContain('AttachThreadInput')
    expect(command).toContain('GetWindowThreadProcessId')
    expect(command).toContain('GetCurrentThreadId')
    // Detaches again afterward instead of leaving the thread input attached.
    expect(command).toContain('AttachThreadInput($currentThreadId, $foregroundThreadId, $false)')
  })

  it('verifies the switch by reading GetForegroundWindow() back instead of trusting the API result', () => {
    const command = buildFocusCommand(4242)
    expect(command).toContain('GetForegroundWindow')
    expect(command).toContain('[Win32.Native]::GetForegroundWindow() -eq $handle')
  })
})

describe('focusPid', () => {
  const processJson = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 80, Name: 'claude.exe' },
    { ProcessId: 80, ParentProcessId: 1, Name: 'WindowsTerminal.exe' }
  ])

  /**
   * Builds a fake ShellRunner that dispatches on which command was sent:
   * the console-window probe (AttachConsole), the process-list query
   * (Get-CimInstance), or a foreground command (buildFocusCommand /
   * buildFocusHandleCommand) — everything else falls to that last bucket.
   */
  function fakeRunner(options: {
    consoleHandleStdout?: string
    consoleProbeExitCode?: number
    focusExitCode?: number
  }) {
    const { consoleHandleStdout = '0', consoleProbeExitCode = 0, focusExitCode = 0 } = options
    const executed: string[] = []
    const run = async (command: string) => {
      executed.push(command)
      if (command.includes('AttachConsole')) {
        return { stdout: consoleHandleStdout, exitCode: consoleProbeExitCode }
      }
      if (command.includes('Get-CimInstance')) {
        return { stdout: processJson, exitCode: 0 }
      }
      return { stdout: '', exitCode: focusExitCode }
    }
    return { executed, run }
  }

  it('resolves the console window straight from the session pid and skips the ancestor chain walk', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    // Only the console probe and the handle-based focus command run — no Get-CimInstance call.
    expect(executed).toHaveLength(2)
    expect(executed[0]).toContain('AttachConsole')
    expect(executed[1]).toContain('555555')
    expect(executed[1]).not.toContain('Get-Process')
  })

  it('falls back to the ancestor chain walk when the console probe returns a zero handle', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '0' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    expect(executed).toHaveLength(3)
    expect(executed[2]).toContain('Get-Process -Id 80')
  })

  it('falls back to the ancestor chain walk when the console probe command itself fails', async () => {
    const { executed, run } = fakeRunner({ consoleProbeExitCode: 1 })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    expect(executed).toHaveLength(3)
  })

  it('returns false when the console probe misses and no terminal host is found in the chain', async () => {
    const ok = await focusPid(100, async (command) => {
      if (command.includes('AttachConsole')) return { stdout: '0', exitCode: 0 }
      return {
        stdout: JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe' }]),
        exitCode: 0
      }
    })
    expect(ok).toBe(false)
  })

  it('returns false when the focus command fails', async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '0', focusExitCode: 1 })
    const ok = await focusPid(100, run)
    expect(ok).toBe(false)
  })

  it('returns false when PowerShell itself errors', async () => {
    const ok = await focusPid(100, async () => {
      throw new Error('powershell missing')
    })
    expect(ok).toBe(false)
  })
})
