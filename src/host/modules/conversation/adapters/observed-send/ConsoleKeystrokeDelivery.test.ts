// layer: L2
// L2 (17 §1.2): the observed-session key relay over the kernel `ProcessControl` double (16 §3;
// R17), per OS on every host (skills/platform-ports). Each spawned tool answers from a script; the
// fake never starts a real process. Proves: exactly one key, through the per-OS write, after the
// target's identity was re-checked just before writing (ADR-014 item 1, INV-51), and nothing
// written when it no longer matches or the terminal cannot be targeted (ADR-012 item 3; 15 §3.3).
import { describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import type { RecordedSpawn } from '../../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../../kernel/ports/processControl'
import { ConsoleKeystrokeDelivery, OBSERVED_KEY_WRITE_TIMEOUT_MS } from './ConsoleKeystrokeDelivery'
import {
  POWERSHELL_ARGS,
  TMUX_LIST_PANES_ARGS,
  powerShellStdinLine,
  terminalTabKeyArgs,
  windowsKeyWriteScript,
  type ConsoleKey
} from './consoleKeys'
import { ScriptedConsoleTools, type ToolAnswer } from './testing/ScriptedConsoleTools'

const ONE: ConsoleKey = { kind: 'text', text: '1' }
const ESC: ConsoleKey = { kind: 'escape' }
const TARGET: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_790_000_000_000, bootId: 'boot' }
const ENV = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' }
const CWD = '/home/j'

function world(
  platform: NodeJS.Platform,
  answer: (spec: SpawnSpec) => ToolAnswer = () => ({ code: 0 })
) {
  const tools = new ScriptedConsoleTools(answer)
  tools.script(TARGET.pid, { ...TARGET })
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const delivery = new ConsoleKeystrokeDelivery({
    processes: tools,
    platform,
    env: ENV,
    cwd: CWD,
    scheduler
  })
  const writes = (): RecordedSpawn[] =>
    tools.spawns.filter(
      (s) =>
        s.executable === 'powershell.exe' ||
        s.executable === 'osascript' ||
        (s.executable === 'tmux' && s.args[0] === 'send-keys')
    )
  return { tools, clock, delivery, writes }
}

/** A POSIX world: `ps` says the session is on pts/4, tmux has a pane %7 there (or as given). */
function posix(
  platform: NodeJS.Platform,
  opts: { tty?: string; panes?: ToolAnswer; keys?: ToolAnswer; tab?: ToolAnswer } = {}
) {
  return world(platform, (spec) => {
    if (spec.executable === 'ps') return { code: 0, stdout: `${opts.tty ?? 'pts/4'}\n` }
    if (spec.executable === 'tmux' && spec.args[0] === 'list-panes') {
      return opts.panes ?? { code: 0, stdout: '%1 /dev/pts/1 100\n%7 /dev/pts/4 200\n' }
    }
    if (spec.executable === 'tmux') return opts.keys ?? { code: 0 }
    if (spec.executable === 'osascript') return opts.tab ?? { code: 0, stdout: 'written\n' }
    return { code: 9 }
  })
}

const MISMATCHES: ReadonlyArray<[string, ProcessIdentity | 'absent' | 'unknown']> = [
  [
    'a recycled pid',
    { ...TARGET, processStartTimeMs: TARGET.processStartTimeMs + PROCESS_START_TOLERANCE_MS + 1 }
  ],
  ['an earlier boot', { ...TARGET, bootId: 'an-earlier-boot' }],
  ['a process that is gone', 'absent'],
  ['an unreadable start time', 'unknown']
]

describe('ConsoleKeystrokeDelivery on Windows: a write into the console by pid', () => {
  it('[ADR-012] Allow writes exactly 1 and Deny exactly Esc into the console of that pid, in a hidden PowerShell child', async () => {
    for (const key of [ONE, ESC]) {
      const { tools, delivery, writes } = world('win32')
      expect(await delivery.press(TARGET, key)).toBe('pressed')
      expect(writes()).toEqual([
        {
          executable: 'powershell.exe',
          args: [...POWERSHELL_ARGS],
          env: ENV,
          cwd: CWD,
          processGroup: 'inherit',
          stdio: 'pipe'
        }
      ])
      expect([...tools.stdinOf.values()]).toEqual([
        powerShellStdinLine(windowsKeyWriteScript(TARGET.pid, key)!)
      ])
    }
  })

  it('[ADR-014, INV-51] a target whose identity no longer matches is never written to', async () => {
    for (const [why, probed] of MISMATCHES) {
      const { tools, delivery, writes } = world('win32')
      tools.script(TARGET.pid, probed)
      expect({ why, outcome: await delivery.press(TARGET, ONE) }).toEqual({
        why,
        outcome: 'refused'
      })
      expect({ why, writes: writes() }).toEqual({ why, writes: [] })
    }
  })

  it('[ADR-012] a write that fails or cannot start is refused', async () => {
    for (const code of [2, 3, 4, 1]) {
      const { delivery } = world('win32', () => ({ code }))
      expect({ code, outcome: await delivery.press(TARGET, ESC) }).toEqual({
        code,
        outcome: 'refused'
      })
    }
    const { tools, delivery } = world('win32')
    tools.spawn = () => {
      throw new Error('spawn EINVAL')
    }
    expect(await delivery.press(TARGET, ONE)).toBe('refused')
  })

  it('[ADR-012] a write that does not finish in time is refused and its own child is ended by identity', async () => {
    const { tools, clock, delivery } = world('win32', () => 'hang')
    const pressing = delivery.press(TARGET, ONE)
    await new Promise((resolve) => setImmediate(resolve))
    clock.advance(OBSERVED_KEY_WRITE_TIMEOUT_MS)
    expect(await pressing).toBe('refused')
    expect(tools.ended.map((e) => e.pid)).toEqual([9_000])
    expect(tools.events).toContain('killTree 9000 foreign')
  })
})

describe('ConsoleKeystrokeDelivery on macOS and Linux: the tmux pane or Terminal.app tab of its tty', () => {
  it('[ADR-012] Allow sends 1 literally and Deny sends Escape to the tmux pane on the session tty, nothing else', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const [key, sent] of [
        [ONE, ['send-keys', '-t', '%7', '-l', '1']],
        [ESC, ['send-keys', '-t', '%7', 'Escape']]
      ] as const) {
        const { tools, delivery, writes } = posix(platform)
        expect(await delivery.press(TARGET, key)).toBe('pressed')
        expect(tools.spawns.map((s) => [s.executable, ...s.args])).toEqual([
          ['ps', '-o', 'tty=', '-p', '4242'],
          ['tmux', ...TMUX_LIST_PANES_ARGS],
          ['tmux', ...sent]
        ])
        expect(
          writes().every((s) => s.env === ENV || JSON.stringify(s.env) === JSON.stringify(ENV))
        ).toBe(true)
      }
    }
  })

  it('[ADR-014, INV-51] the identity is re-checked after the terminal is resolved, just before the key, and a mismatch writes nothing', async () => {
    const { tools, delivery } = posix('linux')
    expect(await delivery.press(TARGET, ONE)).toBe('pressed')
    const order = tools.events.filter((e) => !e.startsWith('spawn ps'))
    expect(order.indexOf(`probe ${TARGET.pid}`)).toBe(
      order.indexOf('spawn send-keys -t %7 -l 1') - 1
    )

    for (const [why, probed] of MISMATCHES) {
      const recycled = posix('darwin')
      recycled.tools.script(TARGET.pid, probed)
      expect({ why, outcome: await recycled.delivery.press(TARGET, ESC) }).toEqual({
        why,
        outcome: 'refused'
      })
      expect({ why, writes: recycled.writes() }).toEqual({ why, writes: [] })
    }
  })

  it('[ADR-012, FM-082] a session in no tmux pane and no Terminal.app tab cannot be targeted: refused, nothing written', async () => {
    const noTmux = posix('linux', { panes: { code: 1, stdout: '' } })
    expect(await noTmux.delivery.press(TARGET, ONE)).toBe('refused')
    expect(noTmux.writes()).toEqual([])

    const noTty = posix('linux', { tty: '?' })
    expect(await noTty.delivery.press(TARGET, ESC)).toBe('refused')
    expect(noTty.writes()).toEqual([])

    const otherPane = posix('linux', { tty: 'pts/9' })
    expect(await otherPane.delivery.press(TARGET, ONE)).toBe('refused')
    expect(otherPane.writes()).toEqual([])
  })

  it('[ADR-012] on macOS outside tmux a digit goes into the Terminal.app tab of the tty, and Esc is refused', async () => {
    const tab = posix('darwin', { tty: 'ttys003', panes: { code: 1 } })
    expect(await tab.delivery.press(TARGET, ONE)).toBe('pressed')
    expect(tab.writes().map((s) => [s.executable, ...s.args])).toEqual([
      ['osascript', ...terminalTabKeyArgs('/dev/ttys003', ONE)!]
    ])

    const esc = posix('darwin', { tty: 'ttys003', panes: { code: 1 } })
    expect(await esc.delivery.press(TARGET, ESC)).toBe('refused')
    expect(esc.writes()).toEqual([])

    const noTab = posix('darwin', { tty: 'ttys003', panes: { code: 1 }, tab: { code: 1 } })
    expect(await noTab.delivery.press(TARGET, ONE)).toBe('refused')
  })

  it('[ADR-012] a failed send-keys is refused', async () => {
    const { delivery } = posix('linux', { keys: { code: 1 } })
    expect(await delivery.press(TARGET, ONE)).toBe('refused')
  })
})

describe('ConsoleKeystrokeDelivery: what is never pressed', () => {
  it('[ADR-012] a key that is not one digit or Esc is refused before anything is probed or spawned', async () => {
    for (const text of ['\r', '12', '0', '']) {
      const { tools, delivery } = world('win32')
      expect(await delivery.press(TARGET, { kind: 'text', text })).toBe('refused')
      expect(tools.spawns).toEqual([])
      expect(tools.probed).toEqual([])
    }
  })

  it('[ADR-013, INV-59] a tool gets only the named OS basics of the Host environment, never a token or the Host switch', async () => {
    const tools = new ScriptedConsoleTools()
    tools.script(TARGET.pid, { ...TARGET })
    const delivery = new ConsoleKeystrokeDelivery({
      processes: tools,
      platform: 'win32',
      env: {
        ...ENV,
        TEMP: 'C:\\t',
        DWARFAI_DELEGATION_TOKEN: 'secret',
        ELECTRON_RUN_AS_NODE: '1',
        ANTHROPIC_API_KEY: 'sk-x',
        UNSET: undefined
      },
      cwd: CWD,
      scheduler: new FakeScheduler(new FakeClock(0))
    })
    expect(await delivery.press(TARGET, ONE)).toBe('pressed')
    expect(tools.spawns.map((s) => s.env)).toEqual([{ ...ENV, TEMP: 'C:\\t' }])
  })

  it('[ADR-012] a platform with no recorded key route refuses and spawns nothing', async () => {
    const { tools, delivery } = world('freebsd')
    expect(await delivery.press(TARGET, ONE)).toBe('refused')
    expect(tools.spawns).toEqual([])
  })
})
