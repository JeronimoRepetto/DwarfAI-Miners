import { describe, expect, it } from 'vitest'
import {
  buildFocusCommand,
  buildProcessQueryCommand,
  focusPid,
  parseProcessRows,
  selectFocusTargetPid,
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

  it('returns true when the chain resolves and the focus command succeeds', async () => {
    const executed: string[] = []
    const ok = await focusPid(100, async (command) => {
      executed.push(command)
      return command.includes('Get-CimInstance')
        ? { stdout: processJson, exitCode: 0 }
        : { stdout: '', exitCode: 0 }
    })
    expect(ok).toBe(true)
    expect(executed).toHaveLength(2)
    expect(executed[1]).toContain('80')
  })

  it('returns false when no terminal host is found', async () => {
    const ok = await focusPid(100, async () => ({
      stdout: JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe' }]),
      exitCode: 0
    }))
    expect(ok).toBe(false)
  })

  it('returns false when the focus command fails', async () => {
    const ok = await focusPid(100, async (command) =>
      command.includes('Get-CimInstance')
        ? { stdout: processJson, exitCode: 0 }
        : { stdout: '', exitCode: 1 }
    )
    expect(ok).toBe(false)
  })

  it('returns false when PowerShell itself errors', async () => {
    const ok = await focusPid(100, async () => {
      throw new Error('powershell missing')
    })
    expect(ok).toBe(false)
  })
})
