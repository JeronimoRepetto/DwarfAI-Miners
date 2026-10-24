// Spike helper (spike/claude-subagent-terminal-input): types keys into, and reads the screen of, the
// console of one process by pid, with the SAME method as the Host's observed-session relay
// (src/host/modules/conversation/adapters/observed-send/consoleKeys.ts `windowsKeyWriteScript` and
// consoleText.ts `windowsTextWriteScript`): a hidden powershell.exe child, `shell: false`, its script
// as one base64 stdin line, FreeConsole -> AttachConsole(pid) -> CONIN$ -> WriteConsoleInputW, one
// call per step, no window raised and the foreground untouched. Windows only. Not product code.
//
// Usage:
//   node console.mjs keys <pid> <step>...   steps: down up left right esc enter tab text:<words> wait:<ms>
//   node console.mjs screen <pid>           prints the visible console window, one line per row
import { spawn } from 'node:child_process'

const VK = { down: 0x28, up: 0x26, left: 0x25, right: 0x27, esc: 0x1b, enter: 0x0d, tab: 0x09 }
const CHAR = { esc: 0x1b, enter: 13, tab: 9 }
const GENERIC_READ_WRITE = 3221225472

const PINVOKE = [
  "$PSModuleAutoLoadingPreference = 'None'",
  "$ErrorActionPreference = 'Stop'",
  "$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('SpikeConsole'), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "$builder = $assembly.DefineDynamicModule('SpikeConsole').DefineType('ConsoleIO', 'Public, Class')",
  "$builder.DefinePInvokeMethod('FreeConsole', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@(), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('AttachConsole', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([uint32]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('CreateFileW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [IntPtr], [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('WriteConsoleInputW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [byte[]], [uint32], [uint32].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('GetConsoleScreenBufferInfo', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [byte[]]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('ReadConsoleOutputCharacterW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr], [char[]], [uint32], [uint32], [uint32].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "$builder.DefinePInvokeMethod('CloseHandle', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [type[]]@([IntPtr]), 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')",
  '$k = $builder.CreateType()'
]

const attach = (pid, device) => [
  '[void]$k::FreeConsole()',
  `if (-not $k::AttachConsole(${pid})) { exit 2 }`,
  `$h = $k::CreateFileW('${device}', ${GENERIC_READ_WRITE}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)`,
  'if ($h -eq [IntPtr]::Zero -or [int64]$h -eq -1) { [void]$k::FreeConsole(); exit 3 }'
]

/** One WriteConsoleInputW call: each (virtualKey, unit) pair as a key down then a key up record. */
function writeCall(pairs) {
  const lines = [`$buf = [byte[]]::new(${pairs.length * 40})`, '$o = 0']
  for (const [vk, unit] of pairs) {
    for (const down of [1, 0]) {
      lines.push(
        '[BitConverter]::GetBytes([uint16]1).CopyTo($buf, $o)',
        `[BitConverter]::GetBytes([int32]${down}).CopyTo($buf, $o + 4)`,
        '[BitConverter]::GetBytes([uint16]1).CopyTo($buf, $o + 8)',
        `[BitConverter]::GetBytes([uint16]${vk}).CopyTo($buf, $o + 10)`,
        `[BitConverter]::GetBytes([uint16]${unit}).CopyTo($buf, $o + 14)`,
        '$o += 20'
      )
    }
  }
  lines.push(
    '$n = [uint32]0',
    `if (-not $k::WriteConsoleInputW($h, $buf, [uint32]${pairs.length * 2}, [ref]$n) -or $n -ne ${pairs.length * 2}) { exit 4 }`
  )
  return lines
}

function keysScript(pid, steps) {
  const body = []
  for (const step of steps) {
    if (step.startsWith('text:')) {
      body.push(...writeCall(Array.from(step.slice(5)).map((c) => [0, c.charCodeAt(0)])))
    } else if (step.startsWith('wait:')) {
      body.push(`[Threading.Thread]::Sleep(${Number(step.slice(5))})`)
    } else if (step in VK) {
      body.push(...writeCall([[VK[step], CHAR[step] ?? 0]]))
    } else throw new Error(`unknown step ${step}`)
    body.push('[Threading.Thread]::Sleep(120)')
  }
  return [
    ...PINVOKE,
    ...attach(pid, 'CONIN$'),
    ...body,
    '[void]$k::CloseHandle($h)',
    '[void]$k::FreeConsole()',
    'exit 0'
  ]
}

function screenScript(pid) {
  return [
    ...PINVOKE,
    ...attach(pid, 'CONOUT$'),
    '$info = [byte[]]::new(22)',
    'if (-not $k::GetConsoleScreenBufferInfo($h, $info)) { exit 5 }',
    '$width = [BitConverter]::ToInt16($info, 0)',
    '$top = [BitConverter]::ToInt16($info, 12); $bottom = [BitConverter]::ToInt16($info, 16)',
    '$out = [Text.StringBuilder]::new()',
    'for ($y = $top; $y -le $bottom; $y++) {',
    '  $chars = [char[]]::new($width); $n = [uint32]0',
    '  [void]$k::ReadConsoleOutputCharacterW($h, $chars, [uint32]$width, [uint32]($y -shl 16), [ref]$n)',
    '  [void]$out.AppendLine((-join $chars).TrimEnd())',
    '}',
    '[void]$k::CloseHandle($h)',
    '[void]$k::FreeConsole()',
    '[Console]::Out.Write($out.ToString())',
    'exit 0'
  ]
}

const stdinLine = (script) =>
  `& ([ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script.join('\n'), 'utf8').toString('base64')}'))))\n`

const [mode, pidText, ...steps] = process.argv.slice(2)
const pid = Number(pidText)
if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid')
const script = mode === 'screen' ? screenScript(pid) : keysScript(pid, steps)
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit']
})
const started = Date.now()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => process.stdout.write(d))
child.stdin.end(stdinLine(script))
child.on('exit', (code) => {
  if (mode !== 'screen') console.error(`exit=${code} ms=${Date.now() - started}`)
  process.exitCode = code ?? 1
})
