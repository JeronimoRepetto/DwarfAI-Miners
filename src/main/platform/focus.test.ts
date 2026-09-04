import { describe, expect, it } from 'vitest'
import {
  buildConsoleWindowProbeCommand,
  buildFocusCommand,
  buildFocusHandleCommand,
  buildProcessQueryCommand,
  focusPid,
  parseConsoleWindowHandle,
  parseProcessRows,
  planFocusCandidates,
  processChain,
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

describe('processChain', () => {
  it('lists the start process first and then each parent in turn', () => {
    const rows = [row(100, 90, 'claude.exe'), row(90, 85, 'node.exe'), row(85, 1, 'cmd.exe')]
    expect(processChain(rows, 100).map((process) => process.pid)).toEqual([100, 90, 85])
  })

  it('stops at a parent the table does not list, and is empty for an unknown start pid', () => {
    const rows = [row(100, 90, 'claude.exe')]
    expect(processChain(rows, 100).map((process) => process.pid)).toEqual([100])
    expect(processChain(rows, 999)).toEqual([])
  })

  it('breaks a parent-pid cycle instead of looping', () => {
    const rows = [row(10, 20, 'a.exe'), row(20, 10, 'b.exe')]
    expect(processChain(rows, 10).map((process) => process.pid)).toEqual([10, 20])
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

  // Issue #182: Windows Terminal keeps the classic console window hidden and
  // draws the session in its own tab, so AttachConsole + GetConsoleWindow
  // still returns a real, nonzero handle for it. Without this check that
  // handle looked identical to a focusable one, and focusPid took it as the
  // target instead of falling through to the ancestor walk that would have
  // found WindowsTerminal.exe.
  it('checks IsWindowVisible on the resolved handle, so a hidden console window is not reported as a hit', () => {
    const command = buildConsoleWindowProbeCommand(4242)
    expect(command).toContain('IsWindowVisible')
  })
})

describe('parseConsoleWindowHandle', () => {
  it('parses a positive, visible handle printed by the probe command', () => {
    expect(parseConsoleWindowHandle('555555 1')).toBe(555555)
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

  // Issue #182: a nonzero handle that IsWindowVisible rejects is exactly the
  // Windows Terminal case — a real console window nobody can ever foreground.
  // The caller cannot tell that apart from "no handle", so it must return 0
  // and let focusPid fall through to the ancestor walk.
  it('treats a nonzero but invisible handle as no handle', () => {
    expect(parseConsoleWindowHandle('555555 0')).toBe(0)
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
    // Amended for issue #190: the verification is no longer handle equality —
    // see the two tests below for why. The assertion here previously read
    // `GetForegroundWindow() -eq $handle`, and its job is unchanged: prove
    // this builder drives the same shared sequence buildFocusCommand does.
    expect(command).toContain('$reachedTarget = $foregroundAfter -eq $handle')
  })

  it('does not resolve the handle through Get-Process, unlike buildFocusCommand', () => {
    expect(buildFocusHandleCommand(555555)).not.toContain('Get-Process')
  })

  // Issue #190, defect A: the shipped sequence read the thread id out of
  // GetWindowThreadProcessId's *out parameter* — which is the process id — and
  // `[void]`'d the return value, which is the thread id. AttachThreadInput was
  // therefore always handed a process id and always returned false. Measured
  // live against a foreground explorer window: the out parameter gave 39872,
  // explorer's pid, against a return value of 31976, its foreground thread;
  // AttachThreadInput was False for the first and True for the second. The
  // foreground-lock mitigation the docstring describes had never run once.
  it('takes the foreground thread id from GetWindowThreadProcessId return value, not its out parameter', () => {
    const command = buildFocusHandleCommand(555555)
    expect(command).toContain(
      '$foregroundThreadId = [Win32.Native]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)'
    )
    // The return value is the thread id, so discarding it is the defect.
    expect(command).not.toContain('[void][Win32.Native]::GetWindowThreadProcessId')
    // ...and the out parameter is the process id, so reading it as a thread id
    // is the other half of the same defect.
    expect(command).not.toContain(
      'GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundThreadId)'
    )
  })

  // Issue #190, defect B: with defect A repaired the foreground genuinely
  // moves, but under the Windows 11 default-terminal handoff the console
  // window the probe resolves is a ConPTY `PseudoConsoleWindow` phantom, and
  // Windows brings the window that *owns* it forward instead. Measured live:
  // target 133320, foreground afterwards 133266 — the real
  // CASCADIA_HOSTING_WINDOW_CLASS window of WindowsTerminal.exe. Exact handle
  // equality called that a failure and the message fell back to the relay.
  it('accepts the window that owns the target as the foreground, not only the target handle itself', () => {
    const command = buildFocusHandleCommand(555555)
    // GA_ROOTOWNER is 3, and it returns the handle itself when nothing owns
    // it — so a window with no owner still verifies exactly as it did before.
    expect(command).toContain('$targetRootOwner = [Win32.Native]::GetAncestor($handle, 3)')
    expect(command).toContain(
      '$reachedTarget = $foregroundAfter -eq $handle -or $foregroundAfter -eq $targetRootOwner'
    )
    expect(command).not.toContain('[Win32.Native]::GetForegroundWindow() -eq $handle')
  })

  // Issue #190: buildSendKeysCommand types into whatever holds the foreground,
  // and the typing step had never run in any of this issue's measurements. A
  // phantom raised without its terminal would put keystrokes somewhere nobody
  // can see, so widening the check to the owner must not widen it to an
  // invisible window.
  it('requires the window it ended up on to be visible before reporting success', () => {
    expect(buildFocusHandleCommand(555555)).toContain(
      'if ($reachedTarget -and [Win32.Native]::IsWindowVisible($foregroundAfter)) { exit 0 } else { exit 1 }'
    )
  })
})

// A `resolveFocusTarget` block stood here with three tests pinning the pure
// decision between the session's own console handle and the name walk. Issue
// #190 made the walk probe ancestors as it climbs, so it needs a shell runner
// and the pure part is the plan below. Of the three: "a nonzero handle wins
// and skips the walk" now lives in focusPid's first test; "zero handle falls
// back to the walk" is the first test below; "both miss returns null" is
// replaced by the second, because an ancestor that is not a named host is no
// longer a miss — it gets probed.
describe('planFocusCandidates', () => {
  const hostRows = [row(10, 5, 'claude.exe'), row(5, 1, 'WindowsTerminal.exe')]

  it('names a terminal host that is the direct parent as the target, with nothing to probe', () => {
    expect(planFocusCandidates(hostRows, 10)).toEqual([{ kind: 'host', pid: 5 }])
  })

  it('asks for an ancestor that is not a named host to be probed instead of giving up', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'services.exe')]
    expect(planFocusCandidates(rows, 10)).toEqual([{ kind: 'console', pid: 5 }])
  })

  // Issue #190: the live chain of a Claude session in a classic cmd.exe
  // console. No rung is a named host, so every one is a probe, nearest first.
  it('probes each ancestor of a classic cmd.exe console in turn, nearest first', () => {
    const rows = [
      row(100, 90, 'claude.exe'),
      row(90, 85, 'node.exe'),
      row(85, 70, 'cmd.exe'),
      row(70, 1, 'explorer.exe')
    ]
    expect(planFocusCandidates(rows, 100)).toEqual([
      { kind: 'console', pid: 90 },
      { kind: 'console', pid: 85 },
      { kind: 'console', pid: 70 }
    ])
  })

  // Issue #182: under Windows Terminal every console beneath it is hidden by
  // design, so the host ends the walk — nothing above it is worth a probe.
  it('ends the walk at the first named host, probing only the rungs beneath it', () => {
    const rows = [
      row(100, 90, 'claude.exe'),
      row(90, 85, 'node.exe'),
      row(85, 80, 'cmd.exe'),
      row(80, 1, 'WindowsTerminal.exe'),
      row(1, 0, 'wininit.exe')
    ]
    expect(planFocusCandidates(rows, 100)).toEqual([
      { kind: 'console', pid: 90 },
      { kind: 'console', pid: 85 },
      { kind: 'host', pid: 80 }
    ])
  })

  it('stops asking for probes after three ancestors, yet still finds a host by name past them', () => {
    const rows = [
      row(100, 90, 'claude.exe'),
      row(90, 80, 'a.exe'),
      row(80, 70, 'b.exe'),
      row(70, 60, 'c.exe'),
      row(60, 50, 'd.exe'),
      row(50, 40, 'e.exe'),
      row(40, 1, 'WindowsTerminal.exe')
    ]
    expect(planFocusCandidates(rows, 100)).toEqual([
      { kind: 'console', pid: 90 },
      { kind: 'console', pid: 80 },
      { kind: 'console', pid: 70 },
      { kind: 'host', pid: 40 }
    ])
  })

  it('never asks to probe the session pid itself, whose console was already probed', () => {
    const rows = [row(10, 5, 'claude.exe'), row(5, 1, 'services.exe')]
    expect(planFocusCandidates(rows, 10)).not.toContainEqual({ kind: 'console', pid: 10 })
  })

  it('still takes the session pid itself as the target when it is a named host', () => {
    const rows = [row(10, 5, 'WindowsTerminal.exe'), row(5, 1, 'explorer.exe')]
    expect(planFocusCandidates(rows, 10)).toEqual([{ kind: 'host', pid: 10 }])
  })

  it('plans nothing for an unknown start pid', () => {
    expect(planFocusCandidates(hostRows, 999)).toEqual([])
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
    // Amended for issue #190: what is read back is unchanged, what it is
    // compared against is not. The assertion previously read
    // `GetForegroundWindow() -eq $handle`; the test below says why.
    expect(command).toContain('$foregroundAfter = [Win32.Native]::GetForegroundWindow()')
    expect(command).toContain('$reachedTarget = $foregroundAfter -eq $handle')
  })

  // Issue #190: both builders share buildForegroundSequence, so both carry
  // both repairs — the thread id from the call's return value rather than its
  // out parameter, and a verification that accepts the owner of the target and
  // insists the window is visible. Pinned on this entry point too, because
  // this is the one a named terminal host is foregrounded through.
  it('carries the repaired thread-id read and owner-aware, visibility-checked verification', () => {
    const command = buildFocusCommand(4242)
    expect(command).toContain(
      '$foregroundThreadId = [Win32.Native]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)'
    )
    expect(command).not.toContain('[void][Win32.Native]::GetWindowThreadProcessId')
    expect(command).toContain('$targetRootOwner = [Win32.Native]::GetAncestor($handle, 3)')
    expect(command).toContain(
      'if ($reachedTarget -and [Win32.Native]::IsWindowVisible($foregroundAfter)) { exit 0 } else { exit 1 }'
    )
    expect(command).not.toContain('[Win32.Native]::GetForegroundWindow() -eq $handle')
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
   *
   * A probe answers per pid when `consoleProbes` names that pid, so one fake
   * can hand a hidden console to the session and a visible one to its
   * ancestors (issue #190); any pid it does not name gets `consoleHandleStdout`.
   */
  function fakeRunner(options: {
    consoleHandleStdout?: string
    consoleProbes?: Record<number, string>
    consoleProbeExitCode?: number
    focusExitCode?: number
    processJson?: string
  }) {
    const {
      consoleHandleStdout = '0',
      consoleProbes = {},
      consoleProbeExitCode = 0,
      focusExitCode = 0,
      processJson: rowsJson = processJson
    } = options
    const executed: string[] = []
    const run = async (command: string) => {
      executed.push(command)
      const probed = /AttachConsole\((\d+)\)/.exec(command)
      if (probed !== null) {
        const stdout = consoleProbes[Number(probed[1])] ?? consoleHandleStdout
        return { stdout, exitCode: consoleProbeExitCode }
      }
      if (command.includes('Get-CimInstance')) {
        return { stdout: rowsJson, exitCode: 0 }
      }
      return { stdout: '', exitCode: focusExitCode }
    }
    return { executed, run }
  }

  it('resolves the console window straight from the session pid and skips the ancestor chain walk', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555 1' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    // Only the console probe and the handle-based focus command run — no Get-CimInstance call.
    expect(executed).toHaveLength(2)
    expect(executed[0]).toContain('AttachConsole')
    expect(executed[1]).toContain('555555')
    expect(executed[1]).not.toContain('Get-Process')
  })

  // Issue #182: Windows Terminal's console window resolves to a real, nonzero
  // handle that is not visible. That must not be taken as a hit — it has to
  // fall through exactly like a zero handle, to the ancestor chain walk that
  // resolves WindowsTerminal.exe (already in WINDOWS_TERMINAL_HOSTS).
  it('falls back to the ancestor chain walk when the console handle is nonzero but the window is hidden', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555 0' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    expect(executed).toHaveLength(3)
    expect(executed[2]).toContain('Get-Process -Id 80')
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

  // Issue #190: a Claude session in a classic cmd.exe console, with the probe
  // results measured live. AttachConsole on claude.exe itself resolves a
  // console whose window is hidden, while node.exe and cmd.exe above it share
  // the console the person is actually looking at. Neither cmd.exe nor
  // explorer.exe is a named terminal host, so the name walk alone found
  // nothing and no foreground attempt was ever made.
  it('foregrounds the nearest ancestor console window that is visible when the session own is hidden', async () => {
    const processJson = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 90, Name: 'claude.exe' },
      { ProcessId: 90, ParentProcessId: 85, Name: 'node.exe' },
      { ProcessId: 85, ParentProcessId: 70, Name: 'cmd.exe' },
      { ProcessId: 70, ParentProcessId: 1, Name: 'explorer.exe' }
    ])
    const { executed, run } = fakeRunner({
      processJson,
      consoleProbes: { 100: '131732 0', 90: '133320 1', 85: '133320 1' }
    })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    // Probe the session, list the processes, probe the parent, foreground its
    // console — the visible console is found one rung up, so cmd.exe and
    // explorer.exe are never probed.
    expect(executed).toHaveLength(4)
    expect(executed[0]).toContain('AttachConsole(100)')
    expect(executed[1]).toContain('Get-CimInstance')
    expect(executed[2]).toContain('AttachConsole(90)')
    expect(executed[3]).toContain('[IntPtr]133320')
    expect(executed[3]).not.toContain('Get-Process')
  })

  it('gives up after probing three ancestors when none has a visible console and no host is named', async () => {
    const processJson = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 90, Name: 'claude.exe' },
      { ProcessId: 90, ParentProcessId: 80, Name: 'a.exe' },
      { ProcessId: 80, ParentProcessId: 70, Name: 'b.exe' },
      { ProcessId: 70, ParentProcessId: 60, Name: 'c.exe' },
      { ProcessId: 60, ParentProcessId: 50, Name: 'd.exe' },
      { ProcessId: 50, ParentProcessId: 1, Name: 'e.exe' }
    ])
    const { executed, run } = fakeRunner({ processJson, consoleHandleStdout: '555555 0' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(false)
    // The session's own probe, the process list, and three ancestor probes —
    // no fourth probe, and no foreground command at a window nobody can see.
    expect(executed).toHaveLength(5)
    expect(executed.slice(2).map((command) => /AttachConsole\((\d+)\)/.exec(command)?.[1])).toEqual(
      ['90', '80', '70']
    )
    expect(executed.some((command) => command.includes('SetForegroundWindow'))).toBe(false)
  })
})
