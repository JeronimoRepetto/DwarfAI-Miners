// The pure builders of the observed-session TEXT relay (ADR-012 item 3; 15 §3.3 C4/C5 "the text is
// relayed into the person's terminal ... fails when the terminal cannot be targeted"; spike S-022-1;
// skills/platform-ports "pure builders, thin runners"): every per-OS command that types a person's
// message into a terminal the Host did not start is a value here, and ConsoleTextDelivery.ts runs it
// through the kernel `ProcessControl` (R17). The key relay's builders (consoleKeys.ts) are reused for
// what both share: the PowerShell stdin line, the tty of a pid, the tmux pane on that tty.
//
// The text a terminal is handed is `relayTextOf(text)`, the console normalization — every whitespace
// run, tab and line break collapsed to one space, then trimmed — on every OS: a console cannot take a
// line break without submitting the line, and S-022-1 fixed the transcript echo of a relayed message
// as a string equal to exactly this (Claude Code 2.1.301, Windows 11; macOS and Linux not run, R-16).
//
// Candidate decisions (21 §6; evidence: consoleText.test.ts, ConsoleTextDelivery.test.ts and
// ObservedSessionTurnSender.os.test.ts), against the legacy text-delivery family `src/main/textDelivery/**`:
// - `shared/consoleText.ts` `normalizeConsoleText` — KEPT in the conversation domain
//   (domain/consoleText.ts, the one rule the echo match also reads); `MAX_CONSOLE_CHUNK_CODE_POINTS`
//   and `boundedChunks` — KEPT verbatim here (copied: R16 lets only src/legacy-bridge import legacy code).
// - `consoleInputWrite.ts` `buildConsoleInputWriteCommand` / `buildConsoleInputSequenceCommand` — ADAPTED
//   to `windowsTextWriteScript`: the same FreeConsole → AttachConsole(pid) → `CONIN$` → one
//   WriteConsoleInputW call per bounded chunk, the text only as base64 of UTF-16, Enter in a call of
//   its own after a 50 ms margin (#404), exit codes 2/3/4; written without a cmdlet or the C# compiler
//   (no `Add-Type`, `New-Object`, `Start-Sleep`), as the key script is since ISSUE-141.
// - `tmuxPaneWrite.ts` `buildTmuxLoadBufferCommand` / `buildTmuxPasteBufferCommand` /
//   `buildTmuxSubmitCommand` — KEPT as `tmuxLoadBufferArgs` / `tmuxPasteArgs` / `tmuxSubmitArgs` (the
//   text from stdin into a named buffer, a bracketed paste deleted after, Enter in a call of its own).
// - `terminalTabWrite.ts` `buildTerminalTabWriteCommand(tty, payload, true)` — KEPT as
//   `terminalTabTextArgs` (measured on macOS 2026-09-18, #367, #471).
// - `attachmentDelivery.ts` `consoleChunksFor` (paths as bracketed pastes, then the words, Enter
//   alone; a path past one chunk refused, never split) — ADAPTED for #1463 to `relayPayloadOf` /
//   `pastedPathOf`: the same markers, order and bound, on the relay text instead of `toConsoleLine`,
//   plus a refusal of a path carrying a control character (a line break would submit, an escape
//   could end the paste). `heldContentFor` (Agent SDK content blocks) — not carried: no Agent SDK
//   (R11); the stream-json driver names the paths in its user line instead.

import { normalizeConsoleText } from '../../domain/consoleText'

/** The longest relay text, in code points: legacy's tmux and Terminal.app bound, now on every OS. */
export const MAX_RELAY_TEXT_CODE_POINTS = 32_768

/**
 * The largest chunk one `WriteConsoleInputW` call carries, in code points (#425: one long call loses
 * its own beginning between ConPTY and a live Claude Code TUI; 200, 400 and 800 measured whole).
 */
export const MAX_CONSOLE_CHUNK_CODE_POINTS = 500

/** The relay text of a message (S-022-1), or null when nothing would be typed or it is too long. */
export function relayTextOf(text: string): string | null {
  const flat = normalizeConsoleText(text)
  if (flat === '' || Array.from(flat).length > MAX_RELAY_TEXT_CODE_POINTS) return null
  return flat
}

/**
 * The VT markers a terminal wraps a dropped path in (legacy `attachmentDelivery.ts`, #408): a path
 * that arrives between them is read as the person's own paste, so Claude Code attaches an image and
 * takes any other path as text it opens with its own tools.
 */
export const BRACKETED_PASTE_START = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'

/** C0 and C1 controls and DEL: a line break would submit, an escape could end the paste early. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** What a message hands a terminal: its files as bracketed pastes, then its relay text. */
export interface RelayPayload {
  readonly pastes: readonly string[]
  /** The relay text (`relayTextOf`'s rule); empty for a message of files alone. */
  readonly words: string
}

/**
 * One path as the bracketed paste a terminal is handed, or null when no terminal can take it whole:
 * empty, carrying a control character, or longer than one console chunk (a path split across two
 * writes would attach nothing, #425, so it is refused rather than split).
 */
export function pastedPathOf(path: string): string | null {
  if (path === '' || CONTROL.test(path)) return null
  const paste = `${BRACKETED_PASTE_START}${path}${BRACKETED_PASTE_END}`
  return Array.from(paste).length > MAX_CONSOLE_CHUNK_CODE_POINTS ? null : paste
}

/**
 * A message's files and words for a terminal (#1463; legacy `consoleChunksFor`, measured
 * 2026-09-16): every path pasted, in the order sent, ahead of the relay text. Null — nothing is
 * typed — when one path cannot be pasted whole, when there is neither a file nor a word, or when
 * the whole passes MAX_RELAY_TEXT_CODE_POINTS: a message is never sent without some of its files.
 */
export function relayPayloadOf(text: string, paths: readonly string[]): RelayPayload | null {
  const pastes: string[] = []
  for (const path of paths) {
    const paste = pastedPathOf(path)
    if (paste === null) return null
    pastes.push(paste)
  }
  const words = normalizeConsoleText(text)
  if (pastes.length === 0 && words === '') return null
  const length = Array.from(pastes.join('') + words).length
  return length > MAX_RELAY_TEXT_CODE_POINTS ? null : { pastes, words }
}

/** `text` in chunks of at most MAX_CONSOLE_CHUNK_CODE_POINTS code points; never an empty chunk. */
export function boundedChunks(text: string): string[] {
  const points = Array.from(text)
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += MAX_CONSOLE_CHUNK_CODE_POINTS) {
    chunks.push(points.slice(index, index + MAX_CONSOLE_CHUNK_CODE_POINTS).join(''))
  }
  return chunks
}

/** `sizeof(INPUT_RECORD)`: `WORD EventType`, padding, then the 16-byte `KEY_EVENT_RECORD`. */
const INPUT_RECORD_BYTES = 20

/** `GENERIC_READ | GENERIC_WRITE` in decimal: PowerShell 5.1 parses `0xC0000000` as a signed Int32. */
const GENERIC_READ_WRITE = 3221225472

/** The margin between two calls, against their being coalesced into one read (#404). */
const CHUNK_SPLIT_DELAY_MS = 50

/** The chunk that submits: a carriage return, the one record carrying a virtual key (VK_RETURN). */
const ENTER_CHUNK = '\r'

const base64Utf16 = (text: string): string => Buffer.from(text, 'utf16le').toString('base64')

/**
 * PowerShell that types `text` (already the relay text) into the console input buffer of `pid`,
 * after each of `pastes` (`pastedPathOf`, #1463) in a call of its own, each bounded chunk of the
 * text in its own `WriteConsoleInputW` call and Enter in a last call of its own, in one
 * child and one attach, with no window raised and the foreground untouched. It must run in a child of
 * its own (`FreeConsole`, then `AttachConsole`) and take its handle from `CONIN$`. Exit codes: 2 the
 * attach was refused and 3 `CONIN$` would not open (nothing written), 4 a call was short or failed
 * (part may be written). Null for a pid that cannot name a process, or no text.
 */
export function windowsTextWriteScript(
  pid: number,
  text: string,
  pastes: readonly string[] = []
): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || (text === '' && pastes.length === 0)) return null
  const chunks = [...pastes, ...boundedChunks(text), ENTER_CHUNK]
  const lines = [
    // No cmdlet runs and no module is loaded (a fresh user's first cmdlet builds a module cache and
    // stalled CI there, ISSUE-141); only the language and .NET are used.
    "$PSModuleAutoLoadingPreference = 'None'",
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('DwarfAIConsoleText'), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "$builder = $assembly.DefineDynamicModule('DwarfAIConsoleText').DefineType('ConsoleText', 'Public, Class')",
    "$builder.DefinePInvokeMethod('FreeConsole', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@(), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
    "$builder.DefinePInvokeMethod('AttachConsole', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([uint32]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
    "$builder.DefinePInvokeMethod('CreateFileW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [IntPtr], [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
    "$builder.DefinePInvokeMethod('WriteConsoleInputW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [byte[]], [uint32], [uint32].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
    "$builder.DefinePInvokeMethod('CloseHandle', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
    '$kernel32 = $builder.CreateType()',
    // One chunk's key records (down, then up, per UTF-16 unit); only a carriage return carries a
    // virtual key. The records of two chunks never share a call (#404).
    'function New-InputBuffer([char[]]$units) {',
    `  $buffer = [byte[]]::new($units.Length * ${INPUT_RECORD_BYTES * 2})`,
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
    '  return ,$buffer',
    '}',
    '[void]$kernel32::FreeConsole()',
    `if (-not $kernel32::AttachConsole(${pid})) { exit 2 }`,
    `$conin = $kernel32::CreateFileW('CONIN$', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    'if ($conin -eq [IntPtr]::Zero -or [int64]$conin -eq -1) {',
    '  [void]$kernel32::FreeConsole()',
    '  exit 3',
    '}',
    '$ok = $true'
  ]
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) lines.push(`[System.Threading.Thread]::Sleep(${CHUNK_SPLIT_DELAY_MS})`)
    lines.push(
      `$units = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${base64Utf16(chunk)}')).ToCharArray()`,
      '$written = [uint32]0',
      '$count = [uint32]($units.Length * 2)',
      'if ($ok) {',
      '  $ok = $kernel32::WriteConsoleInputW($conin, (New-InputBuffer $units), $count, [ref]$written)',
      '  if ($written -ne $count) { $ok = $false }',
      '}'
    )
  }
  lines.push(
    '[void]$kernel32::CloseHandle($conin)',
    '[void]$kernel32::FreeConsole()',
    'if (-not $ok) { exit 4 }',
    'exit 0'
  )
  return lines.join('\n')
}

/** The buffer the tmux relay pastes through: named, so the person's own paste stack is untouched. */
export const TMUX_BUFFER_NAME = 'dwarfai-miners'

/** A tmux pane id: `%` and digits, validated because it reaches a command line. */
const PANE_ID = /^%\d+$/

/** `load-buffer` of the relay text into the named buffer, read from STDIN (never an argv). */
export function tmuxLoadBufferArgs(): readonly string[] {
  return ['load-buffer', '-b', TMUX_BUFFER_NAME, '-']
}

/** The named buffer pasted into that pane only, bracketed (`-p`), then deleted (`-d`). */
export function tmuxPasteArgs(paneId: string): readonly string[] | null {
  if (!PANE_ID.test(paneId)) return null
  return ['paste-buffer', '-p', '-d', '-b', TMUX_BUFFER_NAME, '-t', paneId]
}

/** The submit: Enter as a key, in a call of its own (#404, #485). */
export function tmuxSubmitArgs(paneId: string): readonly string[] | null {
  if (!PANE_ID.test(paneId)) return null
  return ['send-keys', '-t', paneId, 'Enter']
}

/** The margin between the paste and its submit (macOS measured 50 ms too thin, #367). */
export const SUBMIT_SPLIT_DELAY_MS = 200

const TERMINAL_TAB_TEXT_SCRIPT = [
  'on run argv',
  '  set targetTty to item 1 of argv',
  '  set payloadText to item 2 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is targetTty then',
  '          do script payloadText in t',
  // The submit: a Return in a call of its own, because the one riding the payload is paste
  // content to a TUI (#404; macOS 2026-09-18).
  `          delay ${SUBMIT_SPLIT_DELAY_MS / 1000}`,
  '          do script "" in t',
  '          return "written"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  error "no Terminal tab on that tty" number 1',
  'end run'
].join('\n')

/**
 * osascript that types the relay text into the Terminal.app tab whose tty is `tty` and submits it
 * (`do script` in that tab: no window raised, the foreground untouched). The tty and the text are
 * arguments of a fixed script, never inside it. Errors with "no Terminal tab on that tty", writing
 * nothing, when none matches. Null for a tty that is not a device path, or no text.
 */
export function terminalTabTextArgs(tty: string, text: string): readonly string[] | null {
  if (!/^\/dev\/\S+$/.test(tty) || text === '') return null
  return ['-e', TERMINAL_TAB_TEXT_SCRIPT, tty, text]
}
