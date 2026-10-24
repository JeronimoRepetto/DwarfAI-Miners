// The pure Windows builders of the observed-subagent route (AMENDMENT-29, owner 2026-10-24; skills/
// platform-ports "pure builders, thin runners"): the screen read and the navigation keys that
// WindowsConsoleScreen.ts runs through the kernel `ProcessControl` (R17), as the key and text relays
// beside it run theirs. Measured by the spike helper `scripts/spikes/claude-subagent-input/console.mjs`
// (spike branch, commit 867dad5d) on Claude Code 2.1.310, Windows 11.
//
// - The screen: a hidden PowerShell child gives up its own console (FreeConsole), attaches to the
//   session's by pid (AttachConsole), opens `CONOUT$`, reads the visible window row by row
//   (GetConsoleScreenBufferInfo, ReadConsoleOutputCharacterW) and prints it as ONE base64 line of
//   UTF-16, so no code page turns a glyph into `?` on the way (the spike's printout did: `❯`, `●`). It
//   writes nothing into the console. Exit codes: 2 the attach was refused, 3 `CONOUT$` would not open,
//   5 the buffer info could not be read.
// - A key: the same attach, `CONIN$`, one WriteConsoleInputW call with the key down then up, exit
//   codes 2/3/4 as `consoleKeys.ts` `windowsKeyWriteScript`. Only ↓ (VK_DOWN), ↑ (VK_UP) and Enter
//   (VK_RETURN with its carriage return) have a record: Esc stops the viewed subagent (spike §2), so it
//   has none here, and the key relay that may press Esc (consoleKeys.ts) is never used by this route.
// Nothing here logs what the screen showed.
import type { NavKey } from './claudeAgentPlan'

/** The console input record of each navigation key (spike §Setup: VK_DOWN 0x28, VK_UP 0x26, VK_RETURN 0x0D with `\r`). */
const NAV_KEY_RECORDS: Readonly<Record<NavKey, { virtualKey: number; unit: number }>> = {
  down: { virtualKey: 0x28, unit: 0 },
  up: { virtualKey: 0x26, unit: 0 },
  enter: { virtualKey: 0x0d, unit: 0x0d }
}

/** The record of a navigation key, or null for any other name (Esc, `x`, a letter, …). */
export function navKeyRecordOf(key: NavKey): { virtualKey: number; unit: number } | null {
  return Object.prototype.hasOwnProperty.call(NAV_KEY_RECORDS, key) ? NAV_KEY_RECORDS[key] : null
}

/** `sizeof(INPUT_RECORD)`: `WORD EventType`, padding, then the 16-byte `KEY_EVENT_RECORD`. */
const INPUT_RECORD_BYTES = 20

/** `GENERIC_READ | GENERIC_WRITE` in decimal: PowerShell 5.1 parses `0xC0000000` as a signed Int32. */
const GENERIC_READ_WRITE = 3221225472

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0

/** The kernel32 calls both scripts declare in memory (no `Add-Type`, no cmdlet: ISSUE-141). */
function pinvokePrelude(assemblyName: string, extra: readonly string[]): string[] {
  const define = (name: string, returns: string, params: string, charset: string) =>
    `$builder.DefinePInvokeMethod('${name}', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', ${returns}, [type[]]@(${params}), 'Winapi', '${charset}').SetImplementationFlags('PreserveSig')`
  return [
    "$PSModuleAutoLoadingPreference = 'None'",
    "$ErrorActionPreference = 'Stop'",
    `$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('${assemblyName}'), [Reflection.Emit.AssemblyBuilderAccess]::Run)`,
    `$builder = $assembly.DefineDynamicModule('${assemblyName}').DefineType('ConsoleScreen', 'Public, Class')`,
    define('FreeConsole', '[bool]', '', 'Auto'),
    define('AttachConsole', '[bool]', '[uint32]', 'Auto'),
    define(
      'CreateFileW',
      '[IntPtr]',
      '[string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]',
      'Unicode'
    ),
    define('CloseHandle', '[bool]', '[IntPtr]', 'Auto'),
    ...extra,
    '$kernel32 = $builder.CreateType()'
  ]
}

function attachTo(pid: number, device: 'CONIN$' | 'CONOUT$', handle: string): string[] {
  return [
    '[void]$kernel32::FreeConsole()',
    `if (-not $kernel32::AttachConsole(${pid})) { exit 2 }`,
    `${handle} = $kernel32::CreateFileW('${device}', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
    `if (${handle} -eq [IntPtr]::Zero -or [int64]${handle} -eq -1) {`,
    '  [void]$kernel32::FreeConsole()',
    '  exit 3',
    '}'
  ]
}

/**
 * PowerShell that prints the visible window of the console of `pid`, top row first, each row with
 * its trailing blanks trimmed, joined by `\n`, as one base64 line of UTF-16 (`screenLinesOf`). Null
 * for a pid that cannot name a process.
 */
export function windowsScreenReadScript(pid: number): string | null {
  if (!validPid(pid)) return null
  return [
    ...pinvokePrelude('DwarfAIConsoleScreen', [
      "$builder.DefinePInvokeMethod('GetConsoleScreenBufferInfo', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [byte[]]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
      "$builder.DefinePInvokeMethod('ReadConsoleOutputCharacterW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [char[]], [uint32], [uint32], [uint32].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')"
    ]),
    ...attachTo(pid, 'CONOUT$', '$conout'),
    // CONSOLE_SCREEN_BUFFER_INFO: dwSize (X at 0), dwCursorPosition, wAttributes, srWindow (Top at 12, Bottom at 16).
    '$info = [byte[]]::new(22)',
    'if (-not $kernel32::GetConsoleScreenBufferInfo($conout, $info)) {',
    '  [void]$kernel32::CloseHandle($conout)',
    '  [void]$kernel32::FreeConsole()',
    '  exit 5',
    '}',
    '$width = [BitConverter]::ToInt16($info, 0)',
    '$top = [BitConverter]::ToInt16($info, 12)',
    '$bottom = [BitConverter]::ToInt16($info, 16)',
    '$rows = [System.Collections.Generic.List[string]]::new()',
    'for ($y = $top; $y -le $bottom; $y++) {',
    '  $chars = [char[]]::new($width)',
    '  $read = [uint32]0',
    '  [void]$kernel32::ReadConsoleOutputCharacterW($conout, $chars, [uint32]$width, [uint32]($y -shl 16), [ref]$read)',
    '  $rows.Add([string]::new($chars, 0, [int]$read).TrimEnd())',
    '}',
    '[void]$kernel32::CloseHandle($conout)',
    '[void]$kernel32::FreeConsole()',
    '[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(($rows -join "`n"))))',
    'exit 0'
  ].join('\n')
}

/** The rows a screen read printed, or null when the output is not one base64 line of a screen. */
export function screenLinesOf(stdout: string): string[] | null {
  const encoded = stdout.trim()
  if (encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const text = Buffer.from(encoded, 'base64').toString('utf16le')
  return text.split('\n')
}

/**
 * PowerShell that writes one navigation key (down, then up) into the console input buffer of
 * `pid`, in ONE WriteConsoleInputW call. Exit codes as `windowsKeyWriteScript`: 2 the attach was
 * refused and 3 `CONIN$` would not open (nothing written), 4 the write was short or failed. Null for
 * a pid that cannot name a process, or a key that is not ↓, ↑ or Enter.
 */
export function windowsNavKeyScript(pid: number, key: NavKey): string | null {
  const record = navKeyRecordOf(key)
  if (!validPid(pid) || record === null) return null
  return [
    ...pinvokePrelude('DwarfAIConsoleNav', [
      "$builder.DefinePInvokeMethod('WriteConsoleInputW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [byte[]], [uint32], [uint32].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')"
    ]),
    `$buffer = [byte[]]::new(${INPUT_RECORD_BYTES * 2})`,
    '$offset = 0',
    'foreach ($down in 1, 0) {',
    '  [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset)',
    '  [BitConverter]::GetBytes([int32]$down).CopyTo($buffer, $offset + 4)',
    '  [BitConverter]::GetBytes([uint16]1).CopyTo($buffer, $offset + 8)',
    `  [BitConverter]::GetBytes([uint16]${record.virtualKey}).CopyTo($buffer, $offset + 10)`,
    `  [BitConverter]::GetBytes([uint16]${record.unit}).CopyTo($buffer, $offset + 14)`,
    `  $offset += ${INPUT_RECORD_BYTES}`,
    '}',
    ...attachTo(pid, 'CONIN$', '$conin'),
    '$written = [uint32]0',
    '$ok = $kernel32::WriteConsoleInputW($conin, $buffer, [uint32]2, [ref]$written)',
    '[void]$kernel32::CloseHandle($conin)',
    '[void]$kernel32::FreeConsole()',
    'if (-not $ok -or $written -ne 2) { exit 4 }',
    'exit 0'
  ].join('\n')
}
