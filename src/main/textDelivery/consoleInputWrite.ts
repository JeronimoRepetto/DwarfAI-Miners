/**
 * Console input injection on Windows, and since #371 step 2 the one the message
 * path takes: write the text into the session's own console input buffer by
 * pid, with no window raised and no keystroke synthesized at all.
 *
 * This is the replacement sendKeys.ts's header anticipated ("a stricter
 * AttachConsole/WriteConsoleInput implementation can replace it later without
 * anything above noticing"). `WindowsTextDelivery` composes it for a message
 * and for #203's permission digit; the question picker's keys (#362) do not
 * come here, because its multi-select confirmation is an ARROW — a virtual key
 * with no character — and nothing has measured a record shaped like that.
 *
 * Why it is worth having at all: the paste path typed into whatever held the
 * foreground, so a Windows Terminal window with two tabs could not be typed
 * into safely and #371's step 1 refused it — the person's own words then
 * arrived over the relay, framed to the receiving agent as a peer's request
 * rather than their user's. A write by pid has no tab ambiguity to refuse,
 * because the tab strip is never consulted.
 *
 * Measured live 2026-09-10 against throwaway consoles, plain conhost and
 * ConPTY, including a two-tab Windows Terminal window where the write reached
 * the NON-active tab and the other tab received nothing; the foreground did not
 * move and the host window was not raised. Measured again 2026-09-16 with this
 * builder's own script, run as a `windowsHide` PowerShell child against a live
 * Claude Code TUI pid the app did not spawn: two writes, exit 0 in 246 ms and
 * 213 ms, the text complete in that session's composer — read there before
 * anything submitted it — and received verbatim by the model when the person
 * pressed Enter. Full record, with the API results, the two unexplained
 * sightings from the first write, and the error codes for every way it fails,
 * in `docs/console-hosting.md` §6.
 *
 * That same day carried a second, separate measurement that changed the shape
 * of the write itself (#404). The two writes above both carried `pressEnter`
 * false; recorded once with the text and Enter in ONE `WriteConsoleInput` call,
 * a live Claude Code TUI held the message in its composer unsubmitted forever
 * — Ink treats a multi-character chunk as a paste, and a carriage return inside
 * a paste is line content, not a submit gesture. The raw-mode Node receivers
 * this file was measured against earlier had no such rule, which is why an
 * earlier record could say "the Enter arrived once" without anyone seeing the
 * difference it makes to a real TUI. Splitting the Enter into its own
 * `WriteConsoleInput` call — same child process, same attach — submitted every
 * time regardless of the pause between the two calls (0, 50 and 150 ms all
 * worked). Full table in `docs/console-hosting.md` §6.
 *
 * Three facts from these measurements are load-bearing here and are not
 * obvious from the API names:
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
 * 3. **The Enter must be its own `WriteConsoleInput` call, never appended to
 *    the text's.** The SECOND call is what makes Enter read as a submit rather
 *    than pasted content; `ENTER_SPLIT_DELAY_MS` below carries only the
 *    measured margin against the two calls being coalesced into one read while
 *    the receiving process is busy (#404).
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
 * How long the script sleeps between the text's `WriteConsoleInputW` call and
 * the Enter's, in milliseconds.
 *
 * The pause is a margin, not the mechanism: what makes Enter submit rather
 * than paste is that it travels in a SECOND call, and every delay measured
 * against a live Claude Code TUI on 2026-09-16 submitted — 0 ms, 50 ms and
 * 150 ms all worked, one child process and one attach throughout (#404). 50 is
 * kept because it sits near the low end of what was measured, as insurance
 * against the two calls being coalesced into one read while the receiving
 * process is busy rather than something the TUI is waiting out. Table in
 * `docs/console-hosting.md` §6.
 */
const ENTER_SPLIT_DELAY_MS = 50

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
 * Enter travels in its OWN `WriteConsoleInputW` call, never inside the text's
 * — #404's finding. The two calls run in the same child process and the same
 * attach, `ENTER_SPLIT_DELAY_MS` apart, because a live Claude Code TUI reads a
 * multi-character chunk as a paste and a carriage return inside one as line
 * content rather than a submit; only a call of its own reads as a keystroke. A
 * bare Enter (`text` empty) is the one case with a single call, since there is
 * no text write to put it after. Enter is also the only record that carries a
 * virtual key: the text records set `wVirtualKeyCode` 0 and let `UnicodeChar`
 * speak, which is what a TTY reader in raw mode reads.
 *
 * `toConsoleLine` flattens first, for the reason it exists: a console has no
 * way to accept a literal newline without submitting the line, so a pasted
 * paragraph would otherwise send its first line and type the rest into a fresh
 * prompt. After flattening, the only CR in either buffer is Enter's own.
 *
 * The exit codes distinguish the failures the measurement produced, so a
 * caller can say which one happened rather than reporting a bare non-zero:
 * 2 the attach was refused, 3 `CONIN$` would not open, 4 a write was short or
 * failed — including the shape #404 added, where the text's call landed whole
 * and the Enter call behind it did not, leaving an unsubmitted message in the
 * buffer. The console is detached again on every one of them.
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
    // One record-building routine, called once per buffer (text, and — when
    // asked — Enter as its own, separate buffer): the two must never share a
    // call, so they must not share the list they are built from either (#404).
    'function New-InputBuffer([System.Collections.Generic.List[char]]$units) {',
    `  $buffer = New-Object byte[] ($units.Count * ${INPUT_RECORD_BYTES * 2})`,
    '  $offset = 0',
    '  foreach ($unit in $units) {',
    '    $virtualKey = if ($unit -eq [char]13) { 13 } else { 0 }',
    '    foreach ($down in 1, 0) {',
    '      [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset)',
    '      [BitConverter]::GetBytes([int32]$down).CopyTo($buffer, $offset + 4)',
    '      [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset + 8)',
    '      [BitConverter]::GetBytes([uint16]$virtualKey).CopyTo($buffer, $offset + 10)',
    '      [BitConverter]::GetBytes([uint16][int]$unit).CopyTo($buffer, $offset + 14)',
    `      $offset += ${INPUT_RECORD_BYTES}`,
    '    }',
    '  }',
    '  return $buffer',
    '}',
    '$textUnits = New-Object System.Collections.Generic.List[char]',
    `$textUnits.AddRange([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${base64Utf16(
      payload
    )}')).ToCharArray())`,
    '[void][Win32.ConsoleInput]::FreeConsole()',
    `if (-not [Win32.ConsoleInput]::AttachConsole(${pid})) { exit 2 }`,
    `$conin = [Win32.ConsoleInput]::CreateFileW('CONIN$', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    'if ($conin -eq [IntPtr]::Zero -or [int64]$conin -eq -1) {',
    '  [void][Win32.ConsoleInput]::FreeConsole()',
    '  exit 3',
    '}',
    '$ok = $true',
    '$written = [uint32]0',
    '$expected = [uint32]0'
  ]

  // The text's own call, when there is any text at all — a bare Enter has
  // none, and must not spend a call writing zero records.
  if (payload !== '') {
    lines.push(
      '$textBuffer = New-InputBuffer $textUnits',
      '$textWritten = [uint32]0',
      '$expected += [uint32]($textUnits.Count * 2)',
      '$ok = $ok -and [Win32.ConsoleInput]::WriteConsoleInputW($conin, $textBuffer, [uint32]($textUnits.Count * 2), [ref]$textWritten)',
      '$written += $textWritten'
    )
  }

  // Enter's call, SECOND and separate from the text's — the shape #404
  // measured: a chunk with the text and Enter together reads to a live TUI as
  // a paste, where a carriage return is line content rather than a submit. The
  // sleep only guards the two calls against being coalesced into one read; it
  // is skipped for a bare Enter, which has no first call to be coalesced with.
  if (pressEnter) {
    if (payload !== '') lines.push(`Start-Sleep -Milliseconds ${ENTER_SPLIT_DELAY_MS}`)
    lines.push(
      '$enterUnits = New-Object System.Collections.Generic.List[char]',
      '$enterUnits.Add([char]13)',
      '$enterBuffer = New-InputBuffer $enterUnits',
      '$enterWritten = [uint32]0',
      '$expected += [uint32]($enterUnits.Count * 2)',
      '$ok = $ok -and [Win32.ConsoleInput]::WriteConsoleInputW($conin, $enterBuffer, [uint32]($enterUnits.Count * 2), [ref]$enterWritten)',
      '$written += $enterWritten'
    )
  }

  lines.push(
    '[void][Win32.ConsoleInput]::CloseHandle($conin)',
    '[void][Win32.ConsoleInput]::FreeConsole()',
    'if (-not $ok -or $written -ne $expected) { exit 4 }',
    'exit 0'
  )
  return lines.join('\n')
}

/** What one non-zero exit of the script above means, for the two readers of it. */
export interface ConsoleWriteFailure {
  /** The sentence the panel shows, naming which of the three failures happened. */
  error: string
  /**
   * Whether the console provably received NOTHING.
   *
   * The half that is not for the person: it becomes
   * `TextDeliveryOutcome.neverStarted`, which is the only thing that licenses a
   * second tier to send the same text. True only where the script exited before
   * `WriteConsoleInput` was reached at all.
   */
  wroteNothing: boolean
}

/**
 * Turn one of the script's exit codes into a failure a caller can state.
 *
 * Three codes because the measurement produced three distinct failures, and a
 * bare non-zero would have collapsed them: attaching to a pid whose session has
 * ended is an ordinary thing to hit, a `CONIN$` that will not open is not, and a
 * short or failed write is the one that may have put HALF a message into
 * somebody's session — now including the shape #404 added, where the text's
 * own call landed whole and the Enter call behind it did not, leaving the
 * message sitting in the console's buffer unsubmitted. The runtime log says
 * which.
 *
 * Anything else — PowerShell failing on its own terms, a child killed by the
 * timeout — takes the cautious answer rather than a new claim: the buffer may
 * have been written and nothing here can prove otherwise.
 */
export function consoleWriteFailureFor(exitCode: number): ConsoleWriteFailure {
  if (exitCode === 2) {
    return {
      error: 'The panel could not attach to that console; the session may have ended.',
      wroteNothing: true
    }
  }
  if (exitCode === 3) {
    return {
      error: 'That console would not open for input, so nothing was written.',
      wroteNothing: true
    }
  }
  if (exitCode === 4) {
    return { error: 'The write into that console did not complete.', wroteNothing: false }
  }
  return { error: 'The text could not be written into that console.', wroteNothing: false }
}
