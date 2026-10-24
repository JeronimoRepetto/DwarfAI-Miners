// layer: L2
// L2 (17 §1.2): the console-reading capability and the navigation keys of the observed-subagent route
// (AMENDMENT-29) over the kernel `ProcessControl` double (16 §3; R17). Each spawned tool answers from
// a script; the fake never starts a real process. Proves: each read and each key runs only after the
// target's identity was re-checked (ADR-012 item 3, ADR-014 item 1, INV-51), in a hidden PowerShell
// child with the allowlisted environment, and only on Windows.
import { describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../../kernel/ports/processControl'
import { POWERSHELL_ARGS, powerShellStdinLine } from './consoleKeys'
import { windowsNavKeyScript, windowsScreenReadScript } from './consoleScreen'
import { ScriptedConsoleTools, type ToolAnswer } from './testing/ScriptedConsoleTools'
import { CONSOLE_SCREEN_TIMEOUT_MS, WindowsConsoleScreen } from './WindowsConsoleScreen'

const TARGET: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_790_000_000_000, bootId: 'boot' }
const ENV = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', DWARFAI_CHANNEL_TOKEN: 'secret' }
const CWD = 'C:\\Users\\j'
const SCREEN = ['❯ main', '  ● Run ping five times (echo)']
const printed = (rows: readonly string[]) =>
  `${Buffer.from(rows.join('\n'), 'utf16le').toString('base64')}\r\n`

function world(
  platform: NodeJS.Platform,
  answer: (spec: SpawnSpec) => ToolAnswer = () => ({ code: 0, stdout: printed(SCREEN) })
) {
  const tools = new ScriptedConsoleTools(answer)
  tools.script(TARGET.pid, { ...TARGET })
  const clock = new FakeClock(0)
  const console_ = new WindowsConsoleScreen({
    processes: tools,
    platform,
    env: ENV,
    cwd: CWD,
    scheduler: new FakeScheduler(clock)
  })
  return { tools, clock, reader: console_ }
}

const GONE: ReadonlyArray<[string, ProcessIdentity | 'absent']> = [
  [
    'a recycled pid',
    { ...TARGET, processStartTimeMs: TARGET.processStartTimeMs + PROCESS_START_TOLERANCE_MS + 1 }
  ],
  ['an earlier boot', { ...TARGET, bootId: 'an-earlier-boot' }],
  ['a process that is gone', 'absent']
]

describe('WindowsConsoleScreen.read: the visible window of the lead reader, read only', () => {
  it('[ADR-012, ADR-014] reads the console of that pid in a hidden PowerShell child, after the identity check', async () => {
    const { tools, reader } = world('win32')
    expect(await reader.read(TARGET)).toEqual({ kind: 'screen', lines: SCREEN })
    expect(tools.spawns).toEqual([
      {
        executable: 'powershell.exe',
        args: [...POWERSHELL_ARGS],
        env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
        cwd: CWD,
        processGroup: 'inherit',
        stdio: 'pipe'
      }
    ])
    expect([...tools.stdinOf.values()]).toEqual([
      powerShellStdinLine(windowsScreenReadScript(TARGET.pid)!)
    ])
    expect(tools.events).toEqual([`probe ${TARGET.pid}`, `spawn ${POWERSHELL_ARGS.join(' ')}`])
  })

  it('[ADR-014, INV-51] a target whose process is gone or recycled is never attached to', async () => {
    for (const [why, probed] of GONE) {
      const { tools, reader } = world('win32')
      tools.script(TARGET.pid, probed)
      expect({ why, read: await reader.read(TARGET) }).toEqual({ why, read: { kind: 'gone' } })
      expect(tools.spawns).toEqual([])
    }
    const { tools, reader } = world('win32')
    tools.script(TARGET.pid, 'unknown')
    expect(await reader.read(TARGET)).toEqual({ kind: 'not-targeted' })
    expect(tools.spawns).toEqual([])
  })

  it('[ADR-012] an attach or CONOUT$ refusal is not-targeted; any other exit, an unreadable printout or an overrun failed', async () => {
    for (const [answer, read] of [
      [{ code: 2 }, { kind: 'not-targeted' }],
      [{ code: 3 }, { kind: 'not-targeted' }],
      [{ code: 5 }, { kind: 'failed' }],
      [{ code: 0, stdout: 'garbage!' }, { kind: 'failed' }]
    ] as const) {
      const { reader } = world('win32', () => answer)
      expect({ answer, read: await reader.read(TARGET) }).toEqual({ answer, read })
    }
    const { tools, clock, reader } = world('win32', () => 'hang')
    const reading = reader.read(TARGET)
    await new Promise((resolve) => setImmediate(resolve))
    clock.advance(CONSOLE_SCREEN_TIMEOUT_MS)
    expect(await reading).toEqual({ kind: 'failed' })
    expect(tools.events).toContain('killTree 9000 foreign')
  })

  it('[ADR-012] macOS and Linux have no read: nothing runs', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { tools, reader } = world(platform)
      expect(await reader.read(TARGET)).toEqual({ kind: 'not-targeted' })
      expect(tools.events).toEqual([])
    }
  })
})

describe('WindowsConsoleScreen.press: one navigation key into the lead console', () => {
  it('[ADR-012, ADR-014] presses ↓, ↑ or Enter into the console of that pid, after the identity check', async () => {
    for (const key of ['down', 'up', 'enter'] as const) {
      const { tools, reader } = world('win32', () => ({ code: 0 }))
      expect(await reader.press(TARGET, key)).toBe('pressed')
      expect([...tools.stdinOf.values()]).toEqual([
        powerShellStdinLine(windowsNavKeyScript(TARGET.pid, key)!)
      ])
      expect(tools.events).toEqual([`probe ${TARGET.pid}`, `spawn ${POWERSHELL_ARGS.join(' ')}`])
    }
  })

  it('[ADR-014, INV-51] a gone or recycled target gets no key', async () => {
    for (const [why, probed] of GONE) {
      const { tools, reader } = world('win32', () => ({ code: 0 }))
      tools.script(TARGET.pid, probed)
      expect({ why, outcome: await reader.press(TARGET, 'enter') }).toEqual({
        why,
        outcome: 'gone'
      })
      expect(tools.spawns).toEqual([])
    }
  })

  it('[ADR-012] an attach or CONIN$ refusal wrote nothing; a short write, another exit or an overrun is incomplete', async () => {
    for (const [code, outcome] of [
      [2, 'not-targeted'],
      [3, 'not-targeted'],
      [4, 'incomplete'],
      [1, 'incomplete']
    ] as const) {
      const { reader } = world('win32', () => ({ code }))
      expect({ code, outcome: await reader.press(TARGET, 'down') }).toEqual({ code, outcome })
    }
    const { reader } = world('linux')
    expect(await reader.press(TARGET, 'down')).toBe('not-targeted')
  })
})
