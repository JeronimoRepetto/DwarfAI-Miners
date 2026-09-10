/**
 * Console input injection on Windows, v2 as a MEASURED PROOF OF CONCEPT: write
 * the text into the session's own console input buffer by pid, with no window
 * raised and no keystroke synthesized at all.
 *
 * This is the replacement sendKeys.ts's header anticipates ("a stricter
 * AttachConsole/WriteConsoleInput implementation can replace it later without
 * anything above noticing"), and issue #371's step 2. **Nothing composes it
 * yet** — no port exposes it and no delivery route reaches it. Which acts move
 * off the paste path, and behind which capability, is a product decision that
 * this file deliberately does not make.
 *
 * Why it is worth having at all: the paste path types into whatever holds the
 * foreground, so a Windows Terminal window with two tabs cannot be typed into
 * safely and #371's step 1 refuses it — the person's own words then arrive over
 * the relay, framed to the receiving agent as a peer's request rather than
 * their user's. A write by pid has no tab ambiguity to refuse, because the tab
 * strip is never consulted.
 *
 * Measured live 2026-09-10 against throwaway consoles, plain conhost and
 * ConPTY, including a two-tab Windows Terminal window where the write reached
 * the NON-active tab and the other tab received nothing; the foreground did not
 * move and the host window was not raised. Full record, with the API results
 * and the error codes for every way it fails, in `docs/console-hosting.md` §6.
 *
 * Two facts from that measurement are load-bearing here and are not obvious
 * from the API names:
 *
 * 1. **`FreeConsole` first is a precondition, not a flourish.** A process may
 *    be attached to at most one console; called from a process that already has
 *    one, `AttachConsole` returns false with ERROR_ACCESS_DENIED and nothing is
 *    written. So this script must run in a CHILD process — Electron's main
 *    process cannot give up its own console — and that child must be spawned
 *    with `windowsHide: true`, because otherwise it gets a console window of
 *    its own which the Windows 11 default-terminal handoff turns into a new
 *    Windows Terminal window that TAKES THE FOREGROUND. A visible child would
 *    reintroduce, on the delivery path, the exact focus theft this mechanism
 *    exists to remove.
 * 2. **The handle must come from `CONIN$`, never `GetStdHandle`.** The attach
 *    rebinds the console, not the caller's std handles, so
 *    `GetStdHandle(STD_INPUT_HANDLE)` hands back a stale handle and
 *    `WriteConsoleInput` fails on it with ERROR_INVALID_HANDLE — 0 events
 *    written, no error the caller would notice as a delivery failure.
 */

import { toConsoleLine } from './sendKeys'

/**
 * The size of one `INPUT_RECORD`, in bytes: `WORD EventType`, two bytes of
 * padding — the union is 4-aligned because `KEY_EVENT_RECORD` opens with a
 * `BOOL` — then `bKeyDown` (4), `wRepeatCount` (2), `wVirtualKeyCode` (2),
 * `wVirtualScanCode` (2), `UnicodeChar` (2), `dwControlKeyState` (4).
 *
 * Building the records as a flat `byte[]` and marshalling that as the buffer is
 * what lets the script declare no struct at all. `nLength` then counts
 * RECORDS, not bytes, which is the one arithmetic mistake this shape invites.
 */
const INPUT_RECORD_BYTES = 20

/**
 * `GENERIC_READ | GENERIC_WRITE`, in decimal on purpose: PowerShell 5.1 parses
 * `0xC0000000` as a signed `Int32` and the conversion to the `uint32` parameter
 * then fails outright. Measured, not guessed.
 */
const GENERIC_READ_WRITE = 3221225472

/**
 * Encode the payload as base64 of its UTF-16 code units.
 *
 * NOT a single-quoted PowerShell literal, and the difference is the point.
 * `sendKeys.ts`'s `powerShellLiteral` has to double four separate quote
 * codepoints because PowerShell normalises the three typographic variants while
 * parsing, and missing one of them was an arbitrary-execution hole reached by
 * ordinary prose — a word processor's curly apostrophe closed the literal.
 * Base64 removes the class of bug rather than escaping its members: the blob is
 * `[A-Za-z0-9+/=]` only, so there is no quote to double, no backtick, no `$(`,
 * and no here-string terminator. The text never exists as text in the script.
 *
 * UTF-16 also happens to be the unit `WriteConsoleInput` takes, so the decode
 * lands on exactly the code units the records carry — an emoji is a surrogate
 * pair and costs two records, which is what the live measurement showed.
 */
function base64Utf16(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/**
 * PowerShell that writes `text` into the console input buffer of `pid`,
 * optionally followed by Enter. Null when there is nothing it could honestly
 * do: a pid that cannot name a process, or a call that would write no records.
 *
 * Null rather than a throw, and fail-closed like every other guard on this
 * path (`buildQuestionAnswerCommand`, the tier pid guard): a script built
 * around a junk pid would attach to whatever process happens to hold that
 * number, and a write into a stranger's console cannot be taken back.
 *
 * Enter rides OUTSIDE the payload, exactly as it does in `buildSendKeysCommand`
 * — a message can never submit itself. It is also the only record that carries
 * a virtual key: the text records set `wVirtualKeyCode` 0 and let
 * `UnicodeChar` speak, which is what a TTY reader in raw mode reads.
 *
 * `toConsoleLine` flattens first, for the reason it exists: a console has no
 * way to accept a literal newline without submitting the line, so a pasted
 * paragraph would otherwise send its first line and type the rest into a fresh
 * prompt. After flattening, the only CR in the buffer is the appended Enter.
 *
 * The exit codes distinguish the three failures the measurement produced, so a
 * caller can say which one happened rather than reporting a bare non-zero:
 * 2 the attach was refused, 3 `CONIN$` would not open, 4 the write was short or
 * failed. The console is detached again on every one of them.
 */
export function buildConsoleInputWriteCommand(
  pid: number,
  text: string,
  pressEnter: boolean
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const payload = toConsoleLine(text)
  if (payload === '' && !pressEnter) return null

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Win32 -Name ConsoleInput -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);',
    '[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, byte[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);',
    "'@",
    '$units = New-Object System.Collections.Generic.List[char]',
    `$units.AddRange([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${base64Utf16(
      payload
    )}')).ToCharArray())`
  ]
  if (pressEnter) lines.push('$units.Add([char]13)')
  lines.push(
    `$buffer = New-Object byte[] ($units.Count * ${INPUT_RECORD_BYTES * 2})`,
    '$offset = 0',
    'foreach ($unit in $units) {',
    '  $virtualKey = if ($unit -eq [char]13) { 13 } else { 0 }',
    '  foreach ($down in 1, 0) {',
    '    [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset)',
    '    [BitConverter]::GetBytes([int32]$down).CopyTo($buffer, $offset + 4)',
    '    [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset + 8)',
    '    [BitConverter]::GetBytes([uint16]$virtualKey).CopyTo($buffer, $offset + 10)',
    '    [BitConverter]::GetBytes([uint16][int]$unit).CopyTo($buffer, $offset + 14)',
    `    $offset += ${INPUT_RECORD_BYTES}`,
    '  }',
    '}',
    '[void][Win32.ConsoleInput]::FreeConsole()',
    `if (-not [Win32.ConsoleInput]::AttachConsole(${pid})) { exit 2 }`,
    `$conin = [Win32.ConsoleInput]::CreateFileW('CONIN$', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    'if ($conin -eq [IntPtr]::Zero -or [int64]$conin -eq -1) {',
    '  [void][Win32.ConsoleInput]::FreeConsole()',
    '  exit 3',
    '}',
    '$written = [uint32]0',
    '$expected = [uint32]($units.Count * 2)',
    '$ok = [Win32.ConsoleInput]::WriteConsoleInputW($conin, $buffer, $expected, [ref]$written)',
    '[void][Win32.ConsoleInput]::CloseHandle($conin)',
    '[void][Win32.ConsoleInput]::FreeConsole()',
    'if (-not $ok -or $written -ne $expected) { exit 4 }',
    'exit 0'
  )
  return lines.join('\n')
}
