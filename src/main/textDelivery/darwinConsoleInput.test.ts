import { describe, expect, it } from 'vitest'
import type { ProbeCommand } from '../platform/processProbe'
import {
  AUTOMATION_PERMISSION_DENIED,
  TERMINAL_HOST_UNMEASURED,
  TTY_UNKNOWN
} from '../platform/darwinTabReach'
import type { DwarfAttachment } from '../domain/types'
import { TMUX_NOT_RUNNING } from './tmuxPaneWrite'
import {
  MESSAGE_UNBUILDABLE,
  RETURN_CANNOT_BE_WITHHELD,
  consoleRefusalNamingBoth,
  createDarwinConsoleInput
} from './darwinConsoleInput'

function attachment(path: string): DwarfAttachment {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'image', bytes: 1024 }
}

/**
 * A runner answering each command by name, recording what it was asked.
 *
 * AMENDED for #471's fall-through: tmux commands answer by their own verb, and
 * `list-panes` defaults to "no panes at all" so a test that says nothing about
 * tmux still describes a machine without one.
 */
function runnerFor(answers: Partial<Record<string, string | Error>>) {
  const seen: ProbeCommand[] = []
  const run = async (command: ProbeCommand): Promise<string> => {
    seen.push(command)
    const key =
      command.command === 'ps'
        ? 'ps'
        : command.command === 'tmux'
          ? (command.args[0] as string)
          : command.args.length > 2
            ? 'write'
            : 'tabs'
    const answer = answers[key] ?? (command.command === 'tmux' ? '' : undefined)
    if (answer === undefined) throw new Error(`unexpected ${key}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { run, seen }
}

const REACHABLE = { ps: 'ttys001\n', tabs: '/dev/ttys002, /dev/ttys001\n' }

/** The panes of a Mac whose session is in tmux rather than in a Terminal.app tab. */
const IN_TMUX = { 'list-panes': '%3 /dev/ttys001 9876\n', 'load-buffer': '', 'paste-buffer': '' }

describe('createDarwinConsoleInput sendMessage', () => {
  it('writes the whole message into the tab that tty names, in ONE do script call', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    const outcome = await createDarwinConsoleInput(run).sendMessage({
      pid: 4321,
      text: 'hola mundo',
      pressEnter: true
    })
    expect(outcome).toEqual({ delivered: true })
    const write = seen.at(-1)
    expect(write?.command).toBe('osascript')
    expect(write?.args.slice(2)).toEqual(['/dev/ttys001', 'hola mundo'])
    // One write, because one call is one Return.
    expect(
      seen.filter((command) => command.command === 'osascript' && command.args.length === 4)
    ).toHaveLength(1)
  })

  it('puts the attachment pastes and the words in that same one call', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    await createDarwinConsoleInput(run).sendMessage({
      pid: 4321,
      text: 'look at this',
      pressEnter: true,
      attachments: [attachment('/tmp/a b.png')]
    })
    expect(seen.at(-1)?.args[3]).toBe('[200~/tmp/a b.png[201~look at this')
    expect(
      seen.filter((command) => command.command === 'osascript' && command.args.length === 4)
    ).toHaveLength(1)
  })

  /*
   * The refusal that keeps the two mechanisms apart: `do script` always appends
   * a Return, so a caller that must not submit cannot take this tier.
   *
   * AMENDED for #471. It asserted that NOTHING ran — the refusal came before
   * the reach. It now comes after it, because the refusal belongs to the TAB
   * and a session tmux hosts can withhold the Return; what is pinned here is
   * that a session in a tab still gets the refusal, and that nothing was
   * written for it.
   */
  it('refuses to write into a tab when the Return must be withheld', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    expect(
      await createDarwinConsoleInput(run).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: false
      })
    ).toEqual({ delivered: false, error: RETURN_CANNOT_BE_WITHHELD, neverStarted: true })
    expect(seen.map((command) => command.command)).toEqual(['ps', 'osascript'])
    expect(
      seen.some((command) => command.command === 'osascript' && command.args.length === 4)
    ).toBe(false)
  })

  // AMENDED for #471: the refusal now names BOTH tiers, because tmux is asked
  // before anything is refused and this machine has no tmux either.
  it('refuses a session whose tab it cannot name, and says nothing was written', async () => {
    const { run } = runnerFor({ ps: 'ttys009\n', tabs: '/dev/ttys001\n' })
    expect(
      await createDarwinConsoleInput(run).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({
      delivered: false,
      error: consoleRefusalNamingBoth(TERMINAL_HOST_UNMEASURED, TMUX_NOT_RUNNING),
      neverStarted: true
    })
  })

  it('refuses a session with no controlling terminal', async () => {
    const { run } = runnerFor({ ps: '??\n' })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({ delivered: false, error: TTY_UNKNOWN, neverStarted: true })
  })

  // AMENDED for #471: the permission is still named, beside the second tier
  // that was tried and could not help either. A refused Apple event is exactly
  // the case tmux CAN rescue, so it must be asked before this is reported.
  it('names the Automation permission when TCC refuses the reach', async () => {
    const { run } = runnerFor({
      ps: 'ttys001\n',
      tabs: new Error('execution error: Not authorized to send Apple events (-1743)')
    })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({
      delivered: false,
      error: consoleRefusalNamingBoth(AUTOMATION_PERMISSION_DENIED, TMUX_NOT_RUNNING),
      neverStarted: true
    })
  })

  it('names the Automation permission when TCC refuses the write itself', async () => {
    const { run } = runnerFor({
      ...REACHABLE,
      write: new Error('execution error: Not authorized to send Apple events (-1743)')
    })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({ delivered: false, error: AUTOMATION_PERMISSION_DENIED, neverStarted: true })
  })

  // The tab closed between the reach and the write. The script errors before
  // any `do script` runs, so nothing was written and the relay may still carry it.
  it('reports nothing written when the tab has gone by the time the write runs', async () => {
    const { run } = runnerFor({
      ...REACHABLE,
      write: new Error('execution error: no Terminal tab on that tty (1)')
    })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({ delivered: false, error: TERMINAL_HOST_UNMEASURED, neverStarted: true })
  })

  // Cautious, the way the Windows port is: an unexplained failure may have
  // written, so nothing licenses a second tier to send the same words again.
  it('claims nothing about an unexplained osascript failure', async () => {
    const { run } = runnerFor({ ...REACHABLE, write: new Error('osascript killed') })
    const outcome = await createDarwinConsoleInput(run).sendMessage({
      pid: 4321,
      text: 'hi',
      pressEnter: true
    })
    expect(outcome.delivered).toBe(false)
    expect(outcome.neverStarted).toBeUndefined()
  })

  it('refuses a message that cannot be built into one payload', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    expect(
      await createDarwinConsoleInput(run).sendMessage({
        pid: 4321,
        text: 'hi',
        pressEnter: true,
        attachments: [attachment(`/tmp/${'p'.repeat(1000)}.png`)]
      })
    ).toEqual({ delivered: false, error: MESSAGE_UNBUILDABLE, neverStarted: true })
    expect(seen).toEqual([])
  })
})

/*
 * The KEY route (#471), measured 2026-09-18 through the tab write itself.
 *
 * `sendKey` answers null for "this key is not mine", which is what sends the
 * port down its keystroke path — the one that focuses a window and needs
 * Accessibility permission. A digit answers with an outcome instead, and the
 * whole point of the route is that it needs neither.
 */
describe('createDarwinConsoleInput sendKey', () => {
  // Measured: `4` (No) closed the permission dialog cleanly and the appended
  // Return was consumed as the confirmation. ONE call, because a lone digit is
  // read as a keystroke rather than as a paste — so #404's second call, which a
  // MESSAGE needs, would be a second Return into whatever comes next.
  it('writes a single digit into the tab as ONE do script call', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    const outcome = await createDarwinConsoleInput(run).sendKey({
      pid: 4321,
      text: '4',
      pressEnter: false
    })
    expect(outcome).toEqual({ delivered: true })
    const write = seen.at(-1)
    expect(write?.args.slice(2)).toEqual(['/dev/ttys001', '4'])
    expect(write?.args[1]?.match(/do script .* in t/g)).toHaveLength(1)
    expect(write?.args[1]).not.toContain('do script "" in t')
    // Nothing was focused and System Events was never asked.
    expect(seen.some((command) => command.args[1]?.includes('System Events'))).toBe(false)
  })

  it('takes a single-select picker digit the same way', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    await expect(
      createDarwinConsoleInput(run).sendKey({ pid: 4321, text: '2', pressEnter: false })
    ).resolves.toEqual({ delivered: true })
    expect(seen.at(-1)?.args[3]).toBe('2')
  })

  /*
   * Everything a multi-select needs is refused BY SHAPE rather than attempted.
   * Measured 2026-09-18: the digit toggled late, digit+Return did not submit,
   * and submitting needs a Tab and then a digit — a sequence nobody has
   * measured through `do script`. Null hands it back to the keystroke path,
   * unchanged.
   */
  it.each([
    ['several digits', '12'],
    ['a Tab', '\t'],
    ['an Escape', ''],
    ['the VT cursor-right', '[C'],
    ['a carriage return', '\r'],
    ['ordinary words', 'hola'],
    ['nothing at all', ''],
    ['a zero, which numbers no row', '0']
  ])('leaves %s to the keystroke path, running nothing itself', async (_name, text) => {
    const { run, seen } = runnerFor({ ...REACHABLE, write: 'written\n' })
    expect(
      await createDarwinConsoleInput(run).sendKey({ pid: 4321, text, pressEnter: false })
    ).toBeNull()
    expect(seen).toEqual([])
  })

  // The reach verdict binds here exactly as it does for a message: a tab that
  // cannot be named is a refusal, never a quiet fall-through to pressing a key
  // at whatever window happens to be in front (#329).
  // AMENDED for #471: both tiers are named, for the reason the message route's
  // twin is.
  it('refuses a digit whose tab it cannot name, and says nothing was written', async () => {
    const { run } = runnerFor({ ps: 'ttys009\n', tabs: '/dev/ttys001\n' })
    expect(
      await createDarwinConsoleInput(run).sendKey({ pid: 4321, text: '1', pressEnter: false })
    ).toEqual({
      delivered: false,
      error: consoleRefusalNamingBoth(TERMINAL_HOST_UNMEASURED, TMUX_NOT_RUNNING),
      neverStarted: true
    })
  })

  it('refuses a digit for a session with no controlling terminal', async () => {
    const { run } = runnerFor({ ps: '??\n' })
    expect(
      await createDarwinConsoleInput(run).sendKey({ pid: 4321, text: '1', pressEnter: false })
    ).toEqual({ delivered: false, error: TTY_UNKNOWN, neverStarted: true })
  })

  // Unamended: this one refuses at the WRITE, not at the reach, and the
  // fall-through is a reach-verdict thing. A write that may have landed is
  // never handed to a second tier (#329's rule, and the Windows port's).
  it('names the Automation permission when TCC refuses a digit', async () => {
    const { run } = runnerFor({
      ...REACHABLE,
      write: new Error('execution error: Not authorized to send Apple events (-1743)')
    })
    expect(
      await createDarwinConsoleInput(run).sendKey({ pid: 4321, text: '1', pressEnter: false })
    ).toEqual({ delivered: false, error: AUTOMATION_PERMISSION_DENIED, neverStarted: true })
  })

  // Cautious, as everywhere else on this path: an unexplained failure may have
  // pressed the row, and a row pressed twice is a different answer.
  it('claims nothing about an unexplained osascript failure', async () => {
    const { run } = runnerFor({ ...REACHABLE, write: new Error('osascript killed') })
    const outcome = await createDarwinConsoleInput(run).sendKey({
      pid: 4321,
      text: '1',
      pressEnter: false
    })
    expect(outcome?.delivered).toBe(false)
    expect(outcome?.neverStarted).toBeUndefined()
  })
})

describe('createDarwinConsoleInput keystrokes', () => {
  /*
   * AMENDED for #471. It was 'sends a permission digit through the keystroke
   * path, not do script' — true of the whole adapter while a digit had nowhere
   * else to go, and true of `sendText` alone now. A permission digit reaches
   * `sendKey` above first and is written into the tab. What is pinned here is
   * that `sendText` ITSELF is untouched, because it is still what every key the
   * tab write cannot carry falls back to.
   */
  it('still types through System Events when sendText is called directly', async () => {
    const { run, seen } = runnerFor({ tabs: '' })
    expect(await createDarwinConsoleInput(run).sendText('1', false)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args[1]).toContain('System Events')
    expect(seen[0]?.args[1]).toContain('keystroke')
  })

  it('sends the interrupt through the keystroke path', async () => {
    const { run, seen } = runnerFor({ tabs: '' })
    expect(await createDarwinConsoleInput(run).sendInterrupt()).toBe(true)
    expect(seen[0]?.args[1]).toContain('System Events')
    expect(seen[0]?.args[1]).toContain('key code 53')
  })
})

/*
 * The fall-through to tmux (#471).
 *
 * A Mac session in iTerm2, WezTerm, or in any host under tmux, has no
 * Terminal.app tab carrying its tty — the whole of TERMINAL_HOST_UNMEASURED —
 * and until now that was the end of it. It is a tmux PANE, though, and a pane
 * is addressable wherever tmux runs. So the tab is tried first, because it is
 * the tier that was measured, and tmux is offered what the tab could not take.
 *
 * The order is the claim being pinned here. Trying tmux first would put a
 * measured tier behind an unmeasured one for every session that has both.
 */
describe('createDarwinConsoleInput falling through to tmux', () => {
  it('writes into the Terminal tab when there is one, never asking tmux', async () => {
    const { run, seen } = runnerFor({ ...REACHABLE, ...IN_TMUX, write: 'written\n' })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({ delivered: true })
    expect(seen.some((command) => command.command === 'tmux')).toBe(false)
  })

  it('writes into the tmux pane when no tab carries that tty', async () => {
    const { run, seen } = runnerFor({ ps: 'ttys001\n', tabs: '/dev/ttys009\n', ...IN_TMUX })
    expect(
      await createDarwinConsoleInput(run).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: false
      })
    ).toEqual({ delivered: true })
    const tmux = seen.filter((command) => command.command === 'tmux')
    expect(tmux.map((command) => command.args[0])).toEqual([
      'list-panes',
      'load-buffer',
      'paste-buffer'
    ])
    expect(tmux[1]?.stdin).toBe('hola')
  })

  it('presses a digit in the tmux pane when no tab carries that tty', async () => {
    const { run, seen } = runnerFor({ ps: 'ttys001\n', tabs: '/dev/ttys009\n', ...IN_TMUX })
    expect(
      await createDarwinConsoleInput(run).sendKey({ pid: 4321, text: '4', pressEnter: false })
    ).toEqual({ delivered: true })
    expect(seen.at(-1)?.args).toEqual(['send-keys', '-t', '%3', '-l', '4'])
  })

  it('names both tiers when neither can reach the session', async () => {
    const { run } = runnerFor({ ps: 'ttys001\n', tabs: '/dev/ttys009\n' })
    const outcome = await createDarwinConsoleInput(run).sendMessage({
      pid: 4321,
      text: 'hola',
      pressEnter: true
    })
    expect(outcome.neverStarted).toBe(true)
    expect(outcome.error).toContain('Terminal.app')
    expect(outcome.error).toContain('tmux')
  })

  /*
   * A session with no controlling terminal at all is refused BEFORE tmux is
   * asked, and this is the one place the fall-through is skipped: a pane is
   * matched by tty, so a session without one can match none, and asking would
   * spend two commands to learn what the first already said.
   */
  it('never asks tmux for a session with no controlling terminal', async () => {
    const { run, seen } = runnerFor({ ps: '??\n', ...IN_TMUX })
    expect(
      await createDarwinConsoleInput(run).sendMessage({ pid: 4321, text: 'hi', pressEnter: true })
    ).toEqual({ delivered: false, error: TTY_UNKNOWN, neverStarted: true })
    expect(seen.some((command) => command.command === 'tmux')).toBe(false)
  })

  // The keystroke path is untouched by any of this: it is still System Events
  // at the foreground, and tmux has no opinion about it.
  it('leaves the keystroke path alone', async () => {
    const { run, seen } = runnerFor({ tabs: '' })
    expect(await createDarwinConsoleInput(run).sendText('hola', false)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args[1]).toContain('System Events')
  })
})
