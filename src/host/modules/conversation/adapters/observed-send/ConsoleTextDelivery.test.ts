// layer: L2
// L2 (17 §1.2): the observed-session TEXT relay over the kernel `ProcessControl` double (16 §3; R17),
// per OS on every host (skills/platform-ports). Each spawned tool answers from a script; the fake never
// starts a real process. Proves: the relay text (S-022-1) reaches the terminal of that process once,
// through the per-OS write, only after its identity was re-checked just before writing (ADR-012 item 3,
// ADR-014 item 1, INV-51), and nothing is written — nor submitted — when it no longer matches or the
// terminal cannot be targeted (15 §3.3).
import { describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../../kernel/ports/processControl'
import { POWERSHELL_ARGS, TMUX_LIST_PANES_ARGS, powerShellStdinLine } from './consoleKeys'
import {
  SUBMIT_SPLIT_DELAY_MS,
  terminalTabTextArgs,
  tmuxLoadBufferArgs,
  tmuxPasteArgs,
  tmuxSubmitArgs,
  windowsTextWriteScript
} from './consoleText'
import { ConsoleTextDelivery, OBSERVED_TEXT_WRITE_TIMEOUT_MS } from './ConsoleTextDelivery'
import { ScriptedConsoleTools, type ToolAnswer } from './testing/ScriptedConsoleTools'

const TARGET: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_790_000_000_000, bootId: 'boot' }
const ENV = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows', DWARFAI_CHANNEL_TOKEN: 'secret' }
const CWD = '/home/j'
const MESSAGE = 'dig  the\r\nnorth   tunnel '
const RELAYED = 'dig the north tunnel'

function world(
  platform: NodeJS.Platform,
  answer: (spec: SpawnSpec) => ToolAnswer = () => ({ code: 0 })
) {
  const tools = new ScriptedConsoleTools(answer)
  tools.script(TARGET.pid, { ...TARGET })
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const delivery = new ConsoleTextDelivery({
    processes: tools,
    platform,
    env: ENV,
    cwd: CWD,
    scheduler
  })
  /** Runs `work` to its end, moving the clock past each margin the relay waits out. */
  async function settle<T>(work: Promise<T>): Promise<T> {
    let done = false
    void work.then(
      () => (done = true),
      () => (done = true)
    )
    for (let turn = 0; turn < 50 && !done; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!done) clock.advance(SUBMIT_SPLIT_DELAY_MS)
    }
    return work
  }
  /** The spawns that write into a terminal. */
  const writes = () =>
    tools.spawns.filter(
      (s) =>
        s.executable === 'powershell.exe' ||
        s.executable === 'osascript' ||
        (s.executable === 'tmux' && s.args[0] !== 'list-panes' && s.args[0] !== 'load-buffer')
    )
  return { tools, clock, delivery, settle, writes }
}

/** A POSIX world: `ps` says the session is on pts/4, tmux has a pane %7 there (or as given). */
function posix(
  platform: NodeJS.Platform,
  opts: {
    tty?: string
    panes?: ToolAnswer
    load?: ToolAnswer
    paste?: ToolAnswer
    submit?: ToolAnswer
    tab?: ToolAnswer
  } = {}
) {
  return world(platform, (spec) => {
    if (spec.executable === 'ps') return { code: 0, stdout: `${opts.tty ?? 'pts/4'}\n` }
    if (spec.executable === 'tmux') {
      switch (spec.args[0]) {
        case 'list-panes':
          return opts.panes ?? { code: 0, stdout: '%1 /dev/pts/1 100\n%7 /dev/pts/4 200\n' }
        case 'load-buffer':
          return opts.load ?? { code: 0 }
        case 'paste-buffer':
          return opts.paste ?? { code: 0 }
        default:
          return opts.submit ?? { code: 0 }
      }
    }
    if (spec.executable === 'osascript') return opts.tab ?? { code: 0, stdout: 'written\n' }
    return { code: 9 }
  })
}

const GONE: ReadonlyArray<[string, ProcessIdentity | 'absent']> = [
  [
    'a recycled pid',
    { ...TARGET, processStartTimeMs: TARGET.processStartTimeMs + PROCESS_START_TOLERANCE_MS + 1 }
  ],
  ['an earlier boot', { ...TARGET, bootId: 'an-earlier-boot' }],
  ['a process that is gone', 'absent']
]

describe('ConsoleTextDelivery on Windows: the relay text into the console by pid', () => {
  it('[ADR-012, S-022-1] types the relay text once into the console of that pid, in a hidden PowerShell child, after the identity check', async () => {
    const { tools, delivery, writes } = world('win32')
    expect(await delivery.write(TARGET, MESSAGE)).toBe('written')
    expect(writes()).toEqual([
      {
        executable: 'powershell.exe',
        args: [...POWERSHELL_ARGS],
        env: { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' },
        cwd: CWD,
        processGroup: 'inherit',
        stdio: 'pipe'
      }
    ])
    expect([...tools.stdinOf.values()]).toEqual([
      powerShellStdinLine(windowsTextWriteScript(TARGET.pid, RELAYED)!)
    ])
    expect(tools.events).toEqual([`probe ${TARGET.pid}`, `spawn ${POWERSHELL_ARGS.join(' ')}`])
  })

  it('[ADR-014, INV-51] a target whose process is gone or recycled is never written to', async () => {
    for (const [why, probed] of GONE) {
      const { tools, delivery, writes } = world('win32')
      tools.script(TARGET.pid, probed)
      expect({ why, outcome: await delivery.write(TARGET, MESSAGE) }).toEqual({
        why,
        outcome: 'gone'
      })
      expect(writes()).toEqual([])
    }
    const { tools, delivery, writes } = world('win32')
    tools.script(TARGET.pid, 'unknown')
    expect(await delivery.write(TARGET, MESSAGE)).toBe('not-targeted')
    expect(writes()).toEqual([])
  })

  it('[ADR-012] an attach or CONIN$ refusal wrote nothing; a short write or an overrun may have written part', async () => {
    for (const [code, outcome] of [
      [2, 'not-targeted'],
      [3, 'not-targeted'],
      [4, 'incomplete'],
      [1, 'incomplete']
    ] as const) {
      const { delivery } = world('win32', () => ({ code }))
      expect({ code, outcome: await delivery.write(TARGET, MESSAGE) }).toEqual({ code, outcome })
    }
    const { tools, clock, delivery } = world('win32', () => 'hang')
    const writing = delivery.write(TARGET, MESSAGE)
    await new Promise((resolve) => setImmediate(resolve))
    clock.advance(OBSERVED_TEXT_WRITE_TIMEOUT_MS)
    expect(await writing).toBe('incomplete')
    expect(tools.events).toContain('killTree 9000 foreign')
  })

  it('[ADR-012] nothing to type, a tool that will not start, or an OS with no relay writes nothing', async () => {
    const empty = world('win32')
    expect(await empty.delivery.write(TARGET, ' \r\n ')).toBe('not-targeted')
    expect(empty.tools.events).toEqual([])
    const broken = world('win32')
    broken.tools.spawn = () => {
      throw new Error('spawn EINVAL')
    }
    expect(await broken.delivery.write(TARGET, MESSAGE)).toBe('not-targeted')
    const other = world('freebsd')
    expect(await other.delivery.write(TARGET, MESSAGE)).toBe('not-targeted')
    expect(other.tools.events).toEqual([])
  })
})

describe('ConsoleTextDelivery on macOS and Linux: the tmux pane or Terminal.app tab of its tty', () => {
  it('[ADR-012, S-022-1] tmux: the relay text from stdin into the named buffer, pasted into that pane only, then Enter alone, each write after the identity check', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const { tools, delivery, settle } = posix(platform)
      expect(await settle(delivery.write(TARGET, MESSAGE))).toBe('written')
      expect(tools.events).toEqual([
        'spawn -o tty= -p 4242',
        `spawn ${TMUX_LIST_PANES_ARGS.join(' ')}`,
        `spawn ${tmuxLoadBufferArgs().join(' ')}`,
        'probe 4242',
        `spawn ${tmuxPasteArgs('%7')!.join(' ')}`,
        'probe 4242',
        `spawn ${tmuxSubmitArgs('%7')!.join(' ')}`
      ])
      const loads = tools.spawns.findIndex((s) => s.args[0] === 'load-buffer')
      expect(tools.stdinOf.get(9_000 + loads)).toBe(RELAYED)
      expect(tools.spawns.some((s) => s.args.some((a) => a.includes('dig')))).toBe(false)
    }
  })

  it('[ADR-012] the text is never submitted into a pane whose process went away after the paste', async () => {
    const { tools, delivery, settle } = posix('linux', {
      paste: { code: 0 }
    })
    const original = tools.spawn.bind(tools)
    tools.spawn = (spec) => {
      if (spec.args[0] === 'paste-buffer') tools.script(TARGET.pid, 'absent')
      return original(spec)
    }
    expect(await settle(delivery.write(TARGET, MESSAGE))).toBe('incomplete')
    expect(tools.spawns.some((s) => s.args[0] === 'send-keys')).toBe(false)
  })

  it('[ADR-012, ADR-014] a process gone before the paste, no tty, no pane on it, or a failed buffer load writes nothing', async () => {
    const gone = posix('linux')
    gone.tools.script(TARGET.pid, 'absent')
    expect(await gone.settle(gone.delivery.write(TARGET, MESSAGE))).toBe('gone')
    expect(gone.writes()).toEqual([])
    for (const opts of [
      { tty: '?' },
      { panes: { code: 0, stdout: '%1 /dev/pts/1 100\n' } },
      { panes: { code: 1 } },
      { load: { code: 1 } }
    ]) {
      const { delivery, settle, writes } = posix('linux', opts)
      expect({ opts, outcome: await settle(delivery.write(TARGET, MESSAGE)) }).toEqual({
        opts,
        outcome: 'not-targeted'
      })
      expect(writes()).toEqual([])
    }
  })

  it('[ADR-012] a failed paste or submit may have left text behind: incomplete', async () => {
    for (const opts of [{ paste: { code: 1 } }, { submit: { code: 1 } }]) {
      const { delivery, settle } = posix('darwin', opts)
      expect(await settle(delivery.write(TARGET, MESSAGE))).toBe('incomplete')
    }
  })

  it('[ADR-012] macOS outside tmux: the relay text into the Terminal.app tab of that tty, after the identity check; no tab is nothing written', async () => {
    const noPane = { panes: { code: 0, stdout: '' } }
    const { tools, delivery, settle } = posix('darwin', noPane)
    expect(await settle(delivery.write(TARGET, MESSAGE))).toBe('written')
    expect(tools.events.slice(-2)).toEqual([
      'probe 4242',
      `spawn ${terminalTabTextArgs('/dev/pts/4', RELAYED)!.join(' ')}`
    ])
    const missing = posix('darwin', { ...noPane, tab: { code: 1 } })
    expect(await missing.settle(missing.delivery.write(TARGET, MESSAGE))).toBe('not-targeted')
    const linux = posix('linux', noPane)
    expect(await linux.settle(linux.delivery.write(TARGET, MESSAGE))).toBe('not-targeted')
    expect(linux.writes()).toEqual([])
  })
})
