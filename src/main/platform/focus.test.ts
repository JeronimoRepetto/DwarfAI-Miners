import { describe, expect, it } from 'vitest'
import {
  buildConsoleSiblingProbeCommand,
  buildConsoleWindowProbeCommand,
  buildFocusCommand,
  buildFocusHandleCommand,
  buildProcessQueryCommand,
  CONSOLE_PHANTOM_WINDOW_CLASS,
  focusPid,
  focusSessionConsole,
  parseConsoleSiblingCount,
  parseConsoleWindowProbe,
  parseProcessRows,
  planFocusCandidates,
  processChain,
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

  // Issue #371: the phantom console of the Windows 11 default-terminal handoff
  // is OWNED by the Windows Terminal window, which is what makes it a tab
  // rather than a window of its own. The probe reports that relation instead
  // of leaving the caller to assume a handle stands alone.
  it('reports whether another window owns the console, via GetAncestor(GA_ROOTOWNER)', () => {
    const command = buildConsoleWindowProbeCommand(4242)
    expect(command).toContain('GetAncestor')
    // GA_ROOTOWNER is 3, and it answers the handle itself when nothing owns it.
    expect(command).toContain('GetAncestor($handle, 3)')
  })

  // Issue #371: an owned console is refused at the OWNER window, foregrounded
  // through buildFocusCommand — which resolves a pid, so the probe has to name
  // the owner's process as well as its handle.
  it('names the process owning that window, so the host can be foregrounded by pid', () => {
    expect(buildConsoleWindowProbeCommand(4242)).toContain('GetWindowThreadProcessId')
  })
})

/*
 * A `parseConsoleWindowHandle` block stood here with five tests over a parser
 * that answered a bare handle number. Issue #371 needs the owner relation
 * beside the handle — a bare number cannot carry it and the function had no
 * caller but this one — so the parser became `parseConsoleWindowProbe` and
 * returns a record. REMOVED, and every one of the five cases is below under its
 * original name and original meaning, reading `.handle` off the record:
 * "parses a positive, visible handle printed by the probe command", "treats
 * empty or blank output as no handle", "treats a zero handle as no handle",
 * "treats malformed output as no handle instead of throwing" and #182's "treats
 * a nonzero but invisible handle as no handle". No expectation was weakened;
 * the probe now prints four fields, so the literals gained the two the parser
 * reads.
 */
describe('parseConsoleWindowProbe', () => {
  it('parses a positive, visible handle printed by the probe command', () => {
    expect(parseConsoleWindowProbe('555555 1 555555 4242')).toEqual({
      handle: 555555,
      owner: null
    })
  })

  it('treats empty or blank output as no handle', () => {
    expect(parseConsoleWindowProbe('')).toEqual({ handle: 0, owner: null })
    expect(parseConsoleWindowProbe('   ')).toEqual({ handle: 0, owner: null })
  })

  it('treats a zero handle as no handle', () => {
    expect(parseConsoleWindowProbe('0 0 0 0')).toEqual({ handle: 0, owner: null })
  })

  it('treats malformed output as no handle instead of throwing', () => {
    expect(parseConsoleWindowProbe('not a number at all')).toEqual({ handle: 0, owner: null })
    expect(parseConsoleWindowProbe('-5 1 -5 4242')).toEqual({ handle: 0, owner: null })
  })

  // Issue #182: a nonzero handle that IsWindowVisible rejects is exactly the
  // Windows Terminal case — a real console window nobody can ever foreground.
  // The caller cannot tell that apart from "no handle", so it must return 0
  // and let focusPid fall through to the ancestor walk.
  it('treats a nonzero but invisible handle as no handle', () => {
    expect(parseConsoleWindowProbe('555555 0 555555 4242')).toEqual({ handle: 0, owner: null })
  })

  // Issue #371, the whole point: measured live 2026-09-10, three phantoms of
  // class PseudoConsoleWindow (2033948, 657048, 131398) all answering root
  // owner 131698 — the CASCADIA_HOSTING_WINDOW_CLASS window of
  // WindowsTerminal.exe, pid 28704. An owner different from the handle is a tab
  // inside a host window, and that is the fact the reach decision turns on.
  it('reports the owning window and its process when the root owner is not the handle', () => {
    expect(parseConsoleWindowProbe('131398 1 131698 28704')).toEqual({
      handle: 131398,
      owner: { handle: 131698, pid: 28704 }
    })
  })

  // Fail closed: the owner question going unanswered must not read as "nothing
  // owns it", because that is the answer that lets a keystroke into a tab strip.
  it('treats output that stops before the owner fields as no handle, not as unowned', () => {
    expect(parseConsoleWindowProbe('555555 1')).toEqual({ handle: 0, owner: null })
    expect(parseConsoleWindowProbe('555555 1 131698')).toEqual({ handle: 0, owner: null })
  })

  it('treats an owned console whose owner process cannot be read as no handle', () => {
    expect(parseConsoleWindowProbe('131398 1 131698 0')).toEqual({ handle: 0, owner: null })
  })

  it('treats an unreadable owner handle as no handle', () => {
    expect(parseConsoleWindowProbe('131398 1 nope 28704')).toEqual({ handle: 0, owner: null })
  })
})

/*
 * Counting the tabs (#371).
 *
 * An owned phantom says "this console is a tab in somebody's window"; it does
 * not say whether that window holds any OTHER tab. Nothing in user32 maps a tab
 * to a pid, but every ConPTY console under a host has its own top-level
 * PseudoConsoleWindow, so the tabs are countable even though they are not
 * addressable: enumerate them and keep the ones the same window owns.
 */
describe('buildConsoleSiblingProbeCommand', () => {
  it('enumerates top-level windows and keeps the phantom consoles the given window owns', () => {
    const command = buildConsoleSiblingProbeCommand(131698)
    expect(command).toContain('EnumWindows')
    expect(command).toContain('GetClassName')
    expect(command).toContain(CONSOLE_PHANTOM_WINDOW_CLASS)
    // GA_ROOTOWNER again, on each enumerated window this time.
    expect(command).toContain('GetAncestor($hWnd, 3)')
    expect(command).toContain('131698')
  })

  it('prints the count so the caller can parse it back from stdout', () => {
    expect(buildConsoleSiblingProbeCommand(131698)).toContain('[Console]::Out.Write')
  })

  // This command runs on the path to a keystroke, so it must stay a question.
  // Read-only user32 only: nothing here may raise a window or press a key.
  it('reads the desktop without touching it — no foreground change and no keystroke', () => {
    const command = buildConsoleSiblingProbeCommand(131698)
    expect(command).not.toContain('SetForegroundWindow')
    expect(command).not.toContain('ShowWindow')
    expect(command).not.toContain('AttachThreadInput')
    expect(command).not.toContain('SendKeys')
    expect(command).not.toContain('keybd_event')
  })
})

describe('parseConsoleSiblingCount', () => {
  it('parses one sibling — the host has a single console and it is ours', () => {
    expect(parseConsoleSiblingCount('1 131398')).toBe(1)
  })

  // Measured live 2026-09-10: one Windows Terminal window, three phantoms.
  it('parses several siblings — the host is a tab strip', () => {
    expect(parseConsoleSiblingCount('3 2033948,657048,131398')).toBe(3)
  })

  it('parses a count of none', () => {
    expect(parseConsoleSiblingCount('0 -')).toBe(0)
  })

  // Null is "cannot answer", which is not the same as zero: the caller refuses
  // on it rather than reasoning from a number it never got.
  it('answers null for output it cannot read, instead of guessing a count', () => {
    expect(parseConsoleSiblingCount('')).toBeNull()
    expect(parseConsoleSiblingCount('   ')).toBeNull()
    expect(parseConsoleSiblingCount('not a number')).toBeNull()
    expect(parseConsoleSiblingCount('-2 x')).toBeNull()
    expect(parseConsoleSiblingCount('1.5 x')).toBeNull()
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

/**
 * A session in a Windows Terminal tab: its own pid owns no visible console,
 * and the walk reaches the host. HOISTED to module scope for #329, which
 * exercises the same two shapes through `resolveFocusTarget` and
 * `focusSessionConsole` below; the bodies that read it are untouched.
 */
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
 *
 * AMENDED for #371: every `consoleHandleStdout` / `consoleProbes` literal in
 * the blocks below gained the probe's two new fields — the root owner and its
 * pid — because the probe prints four now and the parser fails closed on
 * fewer. An owner equal to the handle is the unowned console those literals
 * always meant, so no expectation in any of those tests moved; `'555555 1'`
 * became `'555555 1 555555 4242'` and the rest read the same way. `siblings`
 * is new and answers the count probe of #371, defaulting to the one-tab
 * output so an unowned fake never needs it.
 */
function fakeRunner(options: {
  consoleHandleStdout?: string
  consoleProbes?: Record<number, string>
  consoleProbeExitCode?: number
  focusExitCode?: number
  processJson?: string
  siblingStdout?: string
  siblingExitCode?: number
}) {
  const {
    consoleHandleStdout = '0 0 0 0',
    consoleProbes = {},
    consoleProbeExitCode = 0,
    focusExitCode = 0,
    processJson: rowsJson = processJson,
    siblingStdout = '1 133398',
    siblingExitCode = 0
  } = options
  const executed: string[] = []
  const run = async (command: string) => {
    executed.push(command)
    const probed = /AttachConsole\((\d+)\)/.exec(command)
    if (probed !== null) {
      const stdout = consoleProbes[Number(probed[1])] ?? consoleHandleStdout
      return { stdout, exitCode: consoleProbeExitCode }
    }
    if (command.includes('EnumWindows')) {
      return { stdout: siblingStdout, exitCode: siblingExitCode }
    }
    if (command.includes('Get-CimInstance')) {
      return { stdout: rowsJson, exitCode: 0 }
    }
    return { stdout: '', exitCode: focusExitCode }
  }
  return { executed, run }
}

/** The classic cmd.exe console of #190: hidden on the session, visible above it. */
const cmdConsoleJson = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 90, Name: 'claude.exe' },
  { ProcessId: 90, ParentProcessId: 85, Name: 'node.exe' },
  { ProcessId: 85, ParentProcessId: 70, Name: 'cmd.exe' },
  { ProcessId: 70, ParentProcessId: 1, Name: 'explorer.exe' }
])

describe('focusPid', () => {
  it('resolves the console window straight from the session pid and skips the ancestor chain walk', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555 1 555555 4242' })
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
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555 0 555555 4242' })
    const ok = await focusPid(100, run)
    expect(ok).toBe(true)
    expect(executed).toHaveLength(3)
    expect(executed[2]).toContain('Get-Process -Id 80')
  })

  it('falls back to the ancestor chain walk when the console probe returns a zero handle', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '0 0 0 0' })
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
      if (command.includes('AttachConsole')) return { stdout: '0 0 0 0', exitCode: 0 }
      return {
        stdout: JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe' }]),
        exitCode: 0
      }
    })
    expect(ok).toBe(false)
  })

  it('returns false when the focus command fails', async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '0 0 0 0', focusExitCode: 1 })
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
      consoleProbes: {
        100: '131732 0 131732 100',
        90: '133320 1 133320 90',
        85: '133320 1 133320 85'
      }
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
    const { executed, run } = fakeRunner({
      processJson,
      consoleHandleStdout: '555555 0 555555 4242'
    })
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

/**
 * Which of the two windows resolution ended on (#329).
 *
 * The distinction was always in the type — a `handle` is a console, a `pid` is
 * a named host — and nothing read it, because click-to-focus wants either. A
 * keystroke does not: a host window draws many sessions at once and only one of
 * its tabs is in front, so the caller has to be able to tell them apart. Pure,
 * over the same fake runner the focusPid tests use.
 */
describe('resolveFocusTarget', () => {
  it("answers a handle for the session's own visible console, which nothing else shares", async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '555555 1 555555 4242' })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'handle', handle: 555555 })
  })

  it('answers the host pid when only the ancestor walk reaches a window, tabs and all', async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '555555 0 555555 4242' })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 80 })
  })

  /*
   * An ancestor's console is still a handle, and deliberately: in a classic
   * cmd.exe console the shell and the session sit on ONE window and the session
   * is the only thing running on it (#190). That is the session's own window in
   * every sense a keystroke cares about — unlike a host, which draws other
   * sessions in its other tabs.
   */
  it('answers a handle for the shell console the session shares with its own launcher', async () => {
    const { run } = fakeRunner({
      processJson: cmdConsoleJson,
      consoleProbes: { 100: '131732 0 131732 100', 90: '133320 1 133320 90' }
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'handle', handle: 133320 })
  })

  it('answers null when neither the probes nor the names find a window', async () => {
    const { run } = fakeRunner({
      processJson: JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe' }])
    })
    await expect(resolveFocusTarget(100, run)).resolves.toBeNull()
  })

  /*
   * Issue #371. The owner relation is the fact #329's refusal was missing, and
   * the count is what turns it into a decision.
   *
   * The live shape, measured 2026-09-10: the session's console is phantom
   * 131398, owned by 131698 — the Windows Terminal window of pid 28704, which
   * drew three of them. Nothing about the phantom itself changes with the tab
   * count, so the count is the only thing that can tell the two cases apart.
   */
  it('asks nothing about tabs when nothing owns the console, so the common case costs one probe', async () => {
    const { executed, run } = fakeRunner({ consoleHandleStdout: '555555 1 555555 4242' })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'handle', handle: 555555 })
    expect(executed).toHaveLength(1)
    expect(executed.some((command) => command.includes('EnumWindows'))).toBe(false)
  })

  it('answers the handle for an owned console when the host draws exactly one, which is ours', async () => {
    const { executed, run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '1 131398'
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'handle', handle: 131398 })
    // The count is asked about the OWNER window, not about the phantom.
    expect(executed[1]).toContain('EnumWindows')
    expect(executed[1]).toContain('131698')
  })

  it('answers the owner process when the host draws more than one console — a tab strip', async () => {
    const { executed, run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '3 2033948,657048,131398'
    })
    // The owner's pid, so the existing named-host path foregrounds the window
    // and every keystroke caller meets #329's shared-window refusal.
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 28704 })
    // No process list is needed: the probe named the host outright.
    expect(executed.some((command) => command.includes('Get-CimInstance'))).toBe(false)
  })

  it('refuses an owned console as its own when the count probe command fails', async () => {
    const { run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '',
      siblingExitCode: 1
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 28704 })
  })

  it('refuses an owned console as its own when the count probe answers nothing readable', async () => {
    const { run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: 'no idea'
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 28704 })
  })

  // A count of zero cannot be right — the probed console is itself one of the
  // windows being counted — so it is a probe that answered wrong, not a host
  // with no tabs. Treated like every other unusable count.
  it('refuses an owned console as its own on a count of none', async () => {
    const { run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '0 -'
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 28704 })
  })

  // The same rule applies to a console found up the chain: an ancestor whose
  // console is a tab in somebody's window is no more typeable than the
  // session's own would be.
  it('applies the same count to an ancestor console that turns out to be owned', async () => {
    const { run } = fakeRunner({
      processJson: cmdConsoleJson,
      consoleProbes: { 100: '131732 0 131732 100', 90: '131398 1 131698 28704' },
      siblingStdout: '3 2033948,657048,131398'
    })
    await expect(resolveFocusTarget(100, run)).resolves.toEqual({ kind: 'pid', pid: 28704 })
  })
})

/**
 * The same act as `focusPid`, reporting WHICH window it foregrounded (#329).
 *
 * `focusPid` keeps its boolean because click-to-focus is content with either
 * window — the person asked for the terminal, and they got the terminal. Text
 * delivery reads this instead.
 */
describe('focusSessionConsole', () => {
  it("reports the session's own console when its probe hit", async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '555555 1 555555 4242' })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({
      focused: true,
      reach: 'own-console'
    })
  })

  it('reports a terminal host when the walk had to reach one, so the tab in front is unknown', async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '555555 0 555555 4242' })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({
      focused: true,
      reach: 'terminal-host'
    })
  })

  it("reports the session's own console for an ancestor shell console (#190)", async () => {
    const { run } = fakeRunner({
      processJson: cmdConsoleJson,
      consoleProbes: { 100: '131732 0 131732 100', 90: '133320 1 133320 90' }
    })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({
      focused: true,
      reach: 'own-console'
    })
  })

  it('reports no reach at all when nothing came forward', async () => {
    const { run } = fakeRunner({ consoleHandleStdout: '555555 1 555555 4242', focusExitCode: 1 })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({ focused: false, reach: null })
  })

  it('reports no reach when PowerShell itself errors', async () => {
    await expect(
      focusSessionConsole(100, async () => {
        throw new Error('powershell missing')
      })
    ).resolves.toEqual({ focused: false, reach: null })
  })

  /*
   * Issue #371, end to end and the reason the issue exists. Before it, both
   * cases below answered `own-console` — the phantom is a `handle`, and a
   * handle was own-console by construction — so the paste went into whichever
   * tab was in front. Now only the one-tab host does.
   */
  it('reports a terminal host for a Windows Terminal window with two tabs, so no keystroke follows', async () => {
    const { executed, run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '2 657048,131398'
    })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({
      focused: true,
      reach: 'terminal-host'
    })
    // Click-to-focus still raises the window: the host is foregrounded through
    // the pid path, whose MainWindowHandle is the owner window itself
    // (measured live 2026-09-10 — WindowsTerminal.exe 28704 -> 131698).
    expect(executed[2]).toContain('Get-Process -Id 28704')
  })

  it("reports the session's own console for a host drawing one tab, which is the session's", async () => {
    const { executed, run } = fakeRunner({
      consoleHandleStdout: '131398 1 131698 28704',
      siblingStdout: '1 131398'
    })
    await expect(focusSessionConsole(100, run)).resolves.toEqual({
      focused: true,
      reach: 'own-console'
    })
    // Foregrounded on the phantom exactly as before, which raises its owner.
    expect(executed[2]).toContain('[IntPtr]131398')
  })
})
