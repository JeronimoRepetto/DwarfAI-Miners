/**
 * Console input injection on Windows, and since #371 step 2 the one the message
 * path takes: write the text into the session's own console input buffer by
 * pid, with no window raised and no keystroke synthesized at all.
 *
 * This is the replacement sendKeys.ts's header anticipated ("a stricter
 * AttachConsole/WriteConsoleInput implementation can replace it later without
 * anything above noticing"). `WindowsTextDelivery` composes it for a message,
 * for #203's permission digit, and — since #402 — for the question picker's own
 * keys (#362). The picker stayed behind at first because its multi-select
 * confirmation was read as an ARROW, a virtual key with no character, and no
 * record of that shape had been measured. It is not one: measured live on
 * 2026-09-16, the arrow travels as the three ORDINARY CHARACTERS of the VT
 * "cursor right" sequence, `ESC [ C`, which this file was already able to carry.
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
 * 3. **Every key must be its own `WriteConsoleInput` call, never appended to
 *    another's.** A call of its own is what makes Enter read as a submit rather
 *    than pasted content, and #402 found the same rule governs each key of an
 *    answer; `CHUNK_SPLIT_DELAY_MS` below carries only the measured margin
 *    against two calls being coalesced into one read while the receiving
 *    process is busy (#404).
 */

import { boundedChunks } from '../../shared/consoleText'
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
 * How long the script sleeps between one chunk's `WriteConsoleInputW` call and
 * the next's, in milliseconds.
 *
 * The pause is a margin, not the mechanism: what makes Enter submit rather
 * than paste is that it travels in a SECOND call, and every delay measured
 * against a live Claude Code TUI on 2026-09-16 submitted — 0 ms, 50 ms and
 * 150 ms all worked, one child process and one attach throughout (#404). 50 is
 * kept because it sits near the low end of what was measured, as insurance
 * against the two calls being coalesced into one read while the receiving
 * process is busy rather than something the TUI is waiting out. The same margin
 * now sits between every pair of chunks in a sequence, because every chunk of an
 * answer is a keystroke for the same reason Enter is (#402). Table in
 * `docs/console-hosting.md` §6.
 */
const CHUNK_SPLIT_DELAY_MS = 50

/** The chunk that submits: a carriage return, the one record carrying a virtual key. */
const ENTER_CHUNK = '\r'

/**
 * PowerShell that writes a SEQUENCE of key chunks into the console input buffer
 * of `pid` — each chunk in its own `WriteConsoleInputW` call, one child process
 * and one attach for the whole sequence, `CHUNK_SPLIT_DELAY_MS` between calls.
 * Null when there is nothing it could honestly do: a pid that cannot name a
 * process, an empty sequence, or a chunk that would write no records.
 *
 * **A chunk is a keystroke and a call is what makes it one.** That is #404's
 * finding generalised: a live Claude Code TUI reads everything arriving in one
 * read as a PASTE, where a carriage return is line content rather than a submit
 * — so Enter had to travel in a call of its own. #402 measured the rest of the
 * picker through the same route and found the rule holds for every key: the
 * digits that toggle a multi-select, the `ESC [ C` that opens its summary, and
 * the Enter that accepts it are four keystrokes, so they are four calls.
 *
 * Nothing here interprets a chunk. They are code-unit strings, and `ESC [ C` is
 * a chunk exactly as `hello` is one — the arrow the picker needs turned out not
 * to be a virtual key at all, just the three ordinary characters of the VT
 * "cursor right" sequence, which `New-InputBuffer` below encodes with
 * `wVirtualKeyCode` 0 like any other text. Flattening belongs to the CALLER
 * that carries a person's own text (see `buildConsoleInputWriteCommand`); a
 * builder that flattened would eat the `\r` that submits.
 *
 * Null rather than a throw, and fail-closed like every other guard on this
 * path: a script built around a junk pid would attach to whatever process
 * happens to hold that number, and a write into a stranger's console cannot be
 * taken back.
 *
 * The exit codes distinguish the failures the measurement produced, so a
 * caller can say which one happened rather than reporting a bare non-zero:
 * 2 the attach was refused, 3 `CONIN$` would not open, 4 a write was short or
 * failed — including the shape #404 added, where an earlier call landed whole
 * and a later one did not, leaving an unsubmitted message or a half-pressed
 * answer in the buffer. The console is detached again on every one of them.
 */
export function buildConsoleInputSequenceCommand(
  pid: number,
  chunks: readonly string[]
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (chunks.length === 0) return null
  // A chunk with nothing in it would spend a `WriteConsoleInputW` call writing
  // zero records, which reports success and presses nothing.
  if (chunks.some((chunk) => chunk === '')) return null

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Win32 -Name ConsoleInput -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);',
    '[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, byte[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);',
    "'@",
    // One record-building routine, called once per chunk: the chunks must never
    // share a call, so they must not share the list they are built from either
    // (#404). The Enter chunk earns `VK_RETURN` from the same line every other
    // record is denied one by.
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

  for (const [index, chunk] of chunks.entries()) {
    // Before every call but the first: the margin against two calls being
    // coalesced into one read while the receiving process is busy (#404).
    if (index > 0) lines.push(`Start-Sleep -Milliseconds ${CHUNK_SPLIT_DELAY_MS}`)
    lines.push(
      `$units${index} = New-Object System.Collections.Generic.List[char]`,
      `$units${index}.AddRange([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${base64Utf16(
        chunk
      )}')).ToCharArray())`,
      `$buffer${index} = New-InputBuffer $units${index}`,
      `$written${index} = [uint32]0`,
      `$expected += [uint32]($units${index}.Count * 2)`,
      `$ok = $ok -and [Win32.ConsoleInput]::WriteConsoleInputW($conin, $buffer${index}, [uint32]($units${index}.Count * 2), [ref]$written${index})`,
      `$written += $written${index}`
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

/**
 * PowerShell that writes `text` into the console input buffer of `pid`,
 * optionally followed by Enter — the MESSAGE shape, which is a two-chunk
 * sequence and nothing more.
 *
 * A thin caller of the builder above rather than a sibling of it, because the
 * two would otherwise carry the same P/Invoke block, the same record encoding
 * and the same exit codes twice. What belongs here and not there is the one
 * thing that is true of a person's own text and of no other chunk:
 * `toConsoleLine` flattens it first, because a console has no way to accept a
 * literal newline without submitting the line, so a pasted paragraph would
 * otherwise send its first line and type the rest into a fresh prompt. After
 * flattening, the only CR in the sequence is Enter's own.
 *
 * A bare Enter (`text` empty) is a one-chunk sequence, so it makes one call with
 * no sleep in front of it — there is no earlier call for it to be coalesced
 * with. Text with no Enter is the other one-chunk case, and a call with neither
 * is refused rather than built.
 *
 * **The words are bounded before they ever reach the builder (#425).** A
 * single `WriteConsoleInput` call carrying a long message loses its own
 * beginning somewhere between ConPTY's translation and a live Claude Code
 * TUI's reader — measured 2026-09-16, `docs/console-hosting.md` §6 — so
 * `boundedChunks` (shared/consoleText.ts) splits the flattened text into
 * `MAX_CONSOLE_CHUNK_CODE_POINTS`-sized pieces first, each becoming its own
 * chunk and so its own `WriteConsoleInputW` call; a short message still comes
 * back as the one chunk it always was. This is the ONE place a message and
 * #203's permission digit both pass through, so both are bounded by the same
 * change.
 */
export function buildConsoleInputWriteCommand(
  pid: number,
  text: string,
  pressEnter: boolean
): string | null {
  const payload = toConsoleLine(text)
  const chunks = [
    ...(payload === '' ? [] : boundedChunks(payload)),
    ...(pressEnter ? [ENTER_CHUNK] : [])
  ]
  return buildConsoleInputSequenceCommand(pid, chunks)
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
