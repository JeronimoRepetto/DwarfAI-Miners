// The pure builders of the observed-session key relay (ADR-012 item 3; 15 §3.3 "fails when the
// terminal cannot be targeted"; skills/platform-ports "pure builders, thin runners"): every per-OS
// command that presses one key in a terminal the Host did not start is a value here, and
// ConsoleKeystrokeDelivery.ts runs it through the kernel `ProcessControl` (R17). Only the two keys
// an observed Claude permission answer presses are addressable: one digit (`1` is Allow) and Esc
// (Deny). Never Enter, never several characters (ADR-012 item 3; keyMap.ts in asking).
//
// Candidate decisions (21 §6; evidence: consoleKeys.test.ts and ConsoleKeystrokeDelivery.os.test.ts),
// against the legacy text-delivery family (`src/main/textDelivery/**`, `src/main/platform/**`):
// - `consoleInputWrite.ts` `buildConsoleInputSequenceCommand` — ADAPTED to `windowsKeyWriteScript`:
//   the same FreeConsole → AttachConsole(pid) → `CONIN$` → WriteConsoleInputW write and exit codes
//   2/3/4, cut to ONE key per call; Esc is now a record of its own carrying `VK_ESCAPE`, where legacy
//   pressed it with a foreground SendKeys (`windowsTextDelivery.ts` `sendInterrupt`, REPLACED: a
//   window in front is not a positively targeted terminal, #329).
// - `windowsTextDelivery.ts` `CONSOLE_WRITE_ARGS` / `consoleWriteStdinLine` — KEPT as
//   `POWERSHELL_ARGS` / `powerShellStdinLine` (one base64 line; a multi-line script on
//   `-Command -` runs its first line only and exits 0, measured 2026-09-16).
// - `darwinTabReach.ts` `buildPidTtyCommand` / `parsePidTty` — KEPT as `ttyOfArgs` / `parsePidTty`.
// - `tmuxPaneWrite.ts` `buildTmuxListPanesCommand` / `parseTmuxPanes` / `selectTmuxPaneId` /
//   `buildTmuxKeyCommand` — ADAPTED: the same pane-by-tty match; Esc is `send-keys -t <pane>
//   Escape`, where legacy tmux refused every Esc (`tmuxConsoleInput.ts` `sendInterrupt`).
// - `terminalTabWrite.ts` `buildTerminalTabWriteCommand` (one `do script` into the tab whose tty
//   matches, `submits` false) — ADAPTED for a digit only: its appended Return is consumed by the
//   dialog as the confirmation (measured on macOS 2026-09-18, #471). An Esc with a Return behind it
//   is unmeasured, so a tab never takes Esc.
// - `osascriptInput.ts` (System Events keystrokes into the foreground window after a focus) —
//   REPLACED by refusal: it presses into whatever window is in front, not a positively targeted
//   terminal.

/** The one key a permission answer presses (the shape of asking's `PermissionKeystroke`). */
export type ConsoleKey = { kind: 'text'; text: string } | { kind: 'escape' }

/** One digit that numbers a dialog row; `0` numbers none. */
const ADDRESSABLE_DIGIT = /^[1-9]$/

/** Whether `key` is one this relay may press: one digit 1-9, or Esc. */
export function isAddressableKey(key: ConsoleKey): boolean {
  return key.kind === 'escape' || ADDRESSABLE_DIGIT.test(key.text)
}

const ESC = 0x1b

/**
 * The console input record of `key`: a digit is its character with no virtual key (as the legacy
 * write sends text); Esc is `VK_ESCAPE` carrying the ESC character, as a keyboard sends it.
 */
export function keyRecordOf(key: ConsoleKey): { virtualKey: number; unit: number } | null {
  if (!isAddressableKey(key)) return null
  if (key.kind === 'escape') return { virtualKey: ESC, unit: ESC }
  return { virtualKey: 0, unit: key.text.charCodeAt(0) }
}

/** `sizeof(INPUT_RECORD)`: `WORD EventType`, padding, then the 16-byte `KEY_EVENT_RECORD`. */
const INPUT_RECORD_BYTES = 20

/** `GENERIC_READ | GENERIC_WRITE` in decimal: PowerShell 5.1 parses `0xC0000000` as a signed Int32. */
const GENERIC_READ_WRITE = 3221225472

/**
 * PowerShell that writes `key` (down, then up) into the console input buffer of `pid`, in ONE
 * `WriteConsoleInputW` call, with no window raised and the foreground untouched. It runs in a
 * child of its own (it must give up its own console first: `FreeConsole`, then `AttachConsole`),
 * and takes its handle from `CONIN$`, never `GetStdHandle`. Exit codes: 2 the attach was refused
 * (nothing written), 3 `CONIN$` would not open (nothing written), 4 the write was short or failed.
 * Null for a pid that cannot name a process or a key that is not addressable: a script around a
 * junk pid would attach to whatever holds that number.
 */
export function windowsKeyWriteScript(pid: number, key: ConsoleKey): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const record = keyRecordOf(key)
  if (record === null) return null
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Win32 -Name ConsoleInput -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);',
    '[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, byte[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);',
    "'@",
    `$buffer = New-Object byte[] ${INPUT_RECORD_BYTES * 2}`,
    '$offset = 0',
    'foreach ($down in 1, 0) {',
    '  [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset)',
    '  [BitConverter]::GetBytes([int32]$down).CopyTo($buffer, $offset + 4)',
    '  [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset + 8)',
    `  [BitConverter]::GetBytes([uint16]${record.virtualKey}).CopyTo($buffer, $offset + 10)`,
    `  [BitConverter]::GetBytes([uint16]${record.unit}).CopyTo($buffer, $offset + 14)`,
    `  $offset += ${INPUT_RECORD_BYTES}`,
    '}',
    '[void][Win32.ConsoleInput]::FreeConsole()',
    `if (-not [Win32.ConsoleInput]::AttachConsole(${pid})) { exit 2 }`,
    `$conin = [Win32.ConsoleInput]::CreateFileW('CONIN$', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    'if ($conin -eq [IntPtr]::Zero -or [int64]$conin -eq -1) {',
    '  [void][Win32.ConsoleInput]::FreeConsole()',
    '  exit 3',
    '}',
    '$written = [uint32]0',
    '$ok = [Win32.ConsoleInput]::WriteConsoleInputW($conin, $buffer, [uint32]2, [ref]$written)',
    '[void][Win32.ConsoleInput]::CloseHandle($conin)',
    '[void][Win32.ConsoleInput]::FreeConsole()',
    'if (-not $ok -or $written -ne 2) { exit 4 }',
    'exit 0'
  ].join('\n')
}

/** `powershell.exe` reading its script from stdin, with no profile and no prompt. */
export const POWERSHELL_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-Command', '-']

/**
 * The one stdin line the PowerShell child is handed: the whole script as base64 of UTF-8, run as
 * one script block. `-Command -` runs each stdin LINE as a statement, so a raw multi-line script
 * would run its first line and exit 0 with nothing written.
 */
export function powerShellStdinLine(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return (
    `& ([ScriptBlock]::Create(` +
    `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))` +
    `))\n`
  )
}

/** `ps` for one pid's controlling terminal, header suppressed by the `=` suffix. */
export function ttyOfArgs(pid: number): readonly string[] | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  return ['-o', 'tty=', '-p', String(pid)]
}

/**
 * The device path of what `ps -o tty=` printed (`ttys001` on macOS, `pts/4` on Linux), or null:
 * `??` (macOS) and `?` (Linux) are no controlling terminal, and without a device nothing matches.
 */
export function parsePidTty(stdout: string): string | null {
  const name = stdout.trim()
  if (name === '' || /^\?+$/.test(name) || /\s/.test(name)) return null
  return name.startsWith('/dev/') ? name : `/dev/${name}`
}

/** Every pane of every tmux session, with its id and tty. */
export const TMUX_LIST_PANES_ARGS: readonly string[] = [
  'list-panes',
  '-a',
  '-F',
  '#{pane_id} #{pane_tty} #{pane_pid}'
]

export interface TmuxPane {
  paneId: string
  tty: string
}

/** A tmux pane id: `%` and digits, validated because it reaches a command line. */
const PANE_ID = /^%\d+$/

/** The panes `list-panes` printed; a row that does not read is skipped, never guessed. */
export function parseTmuxPanes(stdout: string): TmuxPane[] {
  const panes: TmuxPane[] = []
  for (const line of stdout.split('\n')) {
    const match = /^(%\d+)\s+(\S+)\s+\d+\s*$/.exec(line.trimEnd())
    if (match !== null) panes.push({ paneId: match[1]!, tty: match[2]! })
  }
  return panes
}

/**
 * The pane on `tty`, matched by TTY rather than pid: a pane's own pid is the shell tmux started,
 * the session is a descendant of it, and the tty is the field both share.
 */
export function tmuxPaneOn(tty: string | null, panes: readonly TmuxPane[]): string | null {
  if (tty === null) return null
  return panes.find((pane) => pane.tty === tty)?.paneId ?? null
}

/**
 * `send-keys` into that pane only: a digit LITERALLY (`-l`, so it is never read as a key name),
 * Esc as tmux's `Escape` key; nothing appends an Enter.
 */
export function tmuxKeyArgs(paneId: string, key: ConsoleKey): readonly string[] | null {
  if (!PANE_ID.test(paneId) || !isAddressableKey(key)) return null
  return key.kind === 'escape'
    ? ['send-keys', '-t', paneId, 'Escape']
    : ['send-keys', '-t', paneId, '-l', key.text]
}

/**
 * osascript for one digit into the Terminal.app tab whose tty is `tty` (`do script` in that tab:
 * no window raised, the foreground untouched; the tty and the digit travel as argv, never inside
 * the script). Errors with "no Terminal tab on that tty" when none matches, writing nothing.
 * Null for Esc, which a tab never takes (see the header), and for a tty that is not a device path.
 */
export function terminalTabKeyArgs(tty: string, key: ConsoleKey): readonly string[] | null {
  if (!/^\/dev\/\S+$/.test(tty) || key.kind !== 'text' || !isAddressableKey(key)) return null
  return ['-e', TERMINAL_TAB_KEY_SCRIPT, tty, key.text]
}

const TERMINAL_TAB_KEY_SCRIPT = [
  'on run argv',
  '  set targetTty to item 1 of argv',
  '  set payloadText to item 2 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is targetTty then',
  '          do script payloadText in t',
  '          return "written"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  error "no Terminal tab on that tty" number 1',
  'end run'
].join('\n')
