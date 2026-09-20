/**
 * The CONOUT$ repair behind a forced kill (#504, over #358's step 1) — the
 * output-side sibling of `consoleInputWrite.ts`, mirroring its house style
 * exactly, because the two scripts differ in exactly two places and nothing
 * else: which handle they open and which call they write with.
 *
 * `taskkill /T /F` gives a TUI no chance to run its own exit path, so the
 * DECSET modes it turned on — mouse tracking above all — are never reset, and
 * the shell that inherits the console prints an SGR mouse report on every
 * pointer move afterwards and accepts no command. This script writes the
 * resets from OUTSIDE, into a console this process never held.
 *
 * |                | write-by-pid (#371)             | the reset (#504)         |
 * | -------------- | -------------------------------- | ------------------------- |
 * | Handle         | `CreateFileW("CONIN$")`          | `CreateFileW("CONOUT$")`  |
 * | Call           | `WriteConsoleInputW` (key records)| `WriteConsoleW` (characters) |
 *
 * A DECSET reset is OUTPUT, not input. Writing it as key records would hand
 * the ESC bytes to whatever is reading the console — the shell — which would
 * type them rather than obey them; the wrong handle here is not a smaller
 * version of the bug, it is a different bug that looks like success (exit 0,
 * garbage on screen).
 *
 * Measured live on Windows 11 Pro 10.0.26200, against a Windows Terminal tab
 * the app did not spawn (`docs/console-hosting.md` §6, "Handing the terminal
 * back after a forced kill"): `FreeConsole` -> `AttachConsole(pid)` ->
 * `CONOUT$` -> `WriteConsoleW` -> `CloseHandle` -> `FreeConsole`, 54 of 54
 * characters written, exit 0, mouse-drag text selection refused before the
 * write and restored after it. `GetConsoleMode` read **7**
 * (`ENABLE_VIRTUAL_TERMINAL_PROCESSING` already on under ConPTY) — the
 * `SetConsoleMode` below stays for a legacy conhost that lacks it, and is a
 * no-op on every host that was actually measured. A pid whose process had
 * already exited answered `AttachConsole` -> false, `GetLastError` 87 — the
 * shape `buildConsoleResetCommand`'s caller must read as "nothing to repair",
 * never as a failed kick: `taskkill /T /F` has already removed the agent's
 * own pid by the time this runs, so the candidate list is the ancestor chain
 * read BEFORE the kill, and a candidate whose process is already gone is the
 * ordinary case, not an error.
 */

/**
 * The DECSET resets a kicked TUI never got to send itself, exactly as
 * measured — no separators, no trailing newline.
 *
 * `1000`/`1002`/`1003`/`1006`/`1015` are the mouse-tracking modes (the one
 * that actually matters: left on, every pointer move prints an SGR report
 * into the shell that inherits the console). `2004` is bracketed paste and
 * `25h` restores cursor visibility, the same class of mode a TUI toggles and
 * never gets to undo when it is killed rather than exited.
 *
 * `ESC[?1049l` — leaving the alternate screen — is DELIBERATELY absent, and
 * stays absent unless a future measurement proves it safe. It is not a repair
 * for a shell that was never on the alternate screen: it can clear or rewind
 * a screen the person was reading, which is worse than the mouse-report bug
 * this exists to fix (#504).
 */
export const CONSOLE_RESET_SEQUENCE =
  '\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l\u001b[?2004l\u001b[?25h'

/**
 * `GENERIC_READ | GENERIC_WRITE`, in decimal for the same reason
 * `consoleInputWrite.ts` carries the identical constant: PowerShell 5.1
 * parses `0xC0000000` as a signed `Int32`, and the conversion to the `uint32`
 * parameter then fails outright. Measured there, not re-derived here.
 */
const GENERIC_READ_WRITE = 3221225472

/**
 * `ENABLE_VIRTUAL_TERMINAL_PROCESSING`, the output-mode bit this script sets
 * only where `GetConsoleMode` reports it absent (a legacy conhost). Measured
 * live at **7** under ConPTY — this bit already on — which is why the guard
 * below is "if absent", never "always on": forcing a mode a console already
 * has and then restoring a DIFFERENT value would leave it changed.
 */
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 4

/**
 * Encode the payload as base64 of its UTF-16 code units — the same encoding
 * `consoleInputWrite.ts`'s `base64Utf16` uses and for the same reason: the
 * blob is `[A-Za-z0-9+/=]` only, so there is no quote to double and no
 * here-string terminator to collide with. `CONSOLE_RESET_SEQUENCE` is a fixed
 * constant rather than untrusted text, so the injection concern that
 * motivated the sibling's version does not apply here — this is kept anyway
 * so the script never spells the raw ESC bytes as PowerShell source, and so a
 * test can read the exact bytes back out of the script the way
 * `consoleInputWrite.test.ts` reads a chunk out of its.
 */
function base64Utf16(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/**
 * Whether `pid` is a candidate this script may honestly attach to: a real,
 * positive, safe integer — the same fail-closed shape
 * `buildConsoleInputSequenceCommand` holds for a single pid, applied here to
 * every entry of a list gathered by an ancestor walk rather than handed down
 * from a caller that already validated one number.
 */
function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

/**
 * PowerShell that writes `CONSOLE_RESET_SEQUENCE` into the console of the
 * first `pids` entry it can attach to, and does nothing else.
 *
 * Null — unrun, fail-closed — for an empty list or any entry that is not a
 * real positive safe integer: the same guard `buildConsoleInputSequenceCommand`
 * holds for its own pid, because a script built around a junk number would
 * attach to whatever process happens to hold it, and a write into a
 * stranger's console cannot be taken back. This is why the builder returns a
 * value rather than a string outright.
 *
 * Candidates are tried in order, EACH its own `FreeConsole` + `AttachConsole`
 * attempt, stopping at the first that succeeds — unrolled per candidate
 * rather than a runtime PowerShell loop over an array, the same shape
 * `buildConsoleInputSequenceCommand` uses for its chunks: the TypeScript loop
 * that builds the script is the only place list length is a variable, and
 * every emitted line embeds one already-validated literal pid, exactly as
 * `AttachConsole(${pid})` does there.
 *
 * The exit codes mirror `consoleWriteFailureFor`'s contract in
 * `consoleInputWrite.ts`, read against the output side rather than the input
 * one: 0 wrote the resets, 2 no candidate pid could be attached (the ordinary
 * shape of a caller whose own pid has already exited by the time this runs),
 * 3 `CONOUT$` would not open, 4 the write was short or refused. The console is
 * detached again on every one of them.
 */
export function buildConsoleResetCommand(pids: readonly number[]): string | null {
  if (pids.length === 0) return null
  if (pids.some((pid) => !isValidPid(pid))) return null

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Win32 -Name ConsoleReset -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);',
    '[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);',
    '[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WriteConsoleW(IntPtr hConsoleOutput, string lpBuffer, uint nNumberOfCharsToWrite, out uint lpNumberOfCharsWritten, IntPtr lpReserved);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);',
    "'@",
    `$payload = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${base64Utf16(
      CONSOLE_RESET_SEQUENCE
    )}'))`,
    '$attached = $false'
  ]

  for (const pid of pids) {
    lines.push(
      'if (-not $attached) {',
      '  [void][Win32.ConsoleReset]::FreeConsole()',
      `  if ([Win32.ConsoleReset]::AttachConsole(${pid})) { $attached = $true }`,
      '}'
    )
  }

  lines.push(
    'if (-not $attached) { exit 2 }',
    `$conout = [Win32.ConsoleReset]::CreateFileW('CONOUT$', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    'if ($conout -eq [IntPtr]::Zero -or [int64]$conout -eq -1) {',
    '  [void][Win32.ConsoleReset]::FreeConsole()',
    '  exit 3',
    '}',
    '$originalMode = [uint32]0',
    '$hadMode = [Win32.ConsoleReset]::GetConsoleMode($conout, [ref]$originalMode)',
    '$setVt = $false',
    // "only if absent" — forcing a mode already on and restoring a value that
    // was never the true prior state would leave the console changed by this
    // script's own passage, which is the opposite of a repair.
    `if ($hadMode -and (($originalMode -band ${ENABLE_VIRTUAL_TERMINAL_PROCESSING}) -eq 0)) {`,
    `  [void][Win32.ConsoleReset]::SetConsoleMode($conout, $originalMode -bor ${ENABLE_VIRTUAL_TERMINAL_PROCESSING})`,
    '  $setVt = $true',
    '}',
    '$written = [uint32]0',
    '$ok = [Win32.ConsoleReset]::WriteConsoleW($conout, $payload, [uint32]$payload.Length, [ref]$written, [IntPtr]::Zero)',
    'if ($setVt) { [void][Win32.ConsoleReset]::SetConsoleMode($conout, $originalMode) }',
    '[void][Win32.ConsoleReset]::CloseHandle($conout)',
    '[void][Win32.ConsoleReset]::FreeConsole()',
    'if (-not $ok -or $written -ne $payload.Length) { exit 4 }',
    'exit 0'
  )
  return lines.join('\n')
}
