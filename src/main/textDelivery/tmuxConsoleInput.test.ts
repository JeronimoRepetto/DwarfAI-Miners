import { describe, expect, it } from 'vitest'
import type { ProbeCommand } from '../platform/processProbe'
import type { DwarfAttachment } from '../domain/types'
import {
  TMUX_BUFFER_NAME,
  TMUX_NOT_RUNNING,
  TMUX_NO_PANE_FOR_TTY,
  TMUX_SUBMIT_SPLIT_DELAY_MS
} from './tmuxPaneWrite'
import {
  TMUX_CARRIES_NO_KEYSTROKES,
  TMUX_KEY_WRITE_FAILED,
  TMUX_MESSAGE_UNBUILDABLE,
  TMUX_PASTE_FAILED,
  TMUX_WRITE_NEVER_STARTED,
  createTmuxConsoleInput
} from './tmuxConsoleInput'

function attachment(path: string): DwarfAttachment {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'image', bytes: 1024 }
}

/** Every pane row, as `list-panes -F` prints it on a machine with one tmux. */
const PANES = '%0 /dev/pts/1 4321\n%3 /dev/pts/4 9876\n'

/** A runner answering each command by its VERB, recording what it was asked. */
function runnerFor(answers: Partial<Record<string, string | Error>>) {
  const seen: ProbeCommand[] = []
  const slept: number[] = []
  const run = async (command: ProbeCommand): Promise<string> => {
    seen.push(command)
    const key = command.command === 'ps' ? 'ps' : (command.args[0] as string)
    const answer = answers[key]
    if (answer === undefined) throw new Error(`unexpected ${key}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms)
  }
  return { run, sleep, seen, slept }
}

/** A session whose pid is on `/dev/pts/4`, which pane `%3` carries. */
const REACHABLE = {
  ps: 'pts/4\n',
  'list-panes': PANES,
  'load-buffer': '',
  'paste-buffer': '',
  'send-keys': ''
}

function verbs(seen: readonly ProbeCommand[]): string[] {
  return seen.map((command) => (command.command === 'ps' ? 'ps' : (command.args[0] as string)))
}

describe('createTmuxConsoleInput sendMessage', () => {
  it('loads the payload on stdin, pastes it into the pane, then submits separately', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    const outcome = await createTmuxConsoleInput(run, { sleep }).sendMessage({
      pid: 4321,
      text: 'hola mundo',
      pressEnter: true
    })
    expect(outcome).toEqual({ delivered: true })
    expect(verbs(seen)).toEqual(['ps', 'list-panes', 'load-buffer', 'paste-buffer', 'send-keys'])
    expect(seen[2]).toEqual({
      command: 'tmux',
      args: ['load-buffer', '-b', TMUX_BUFFER_NAME, '-'],
      stdin: 'hola mundo'
    })
    expect(seen[3]?.args).toEqual(['paste-buffer', '-p', '-d', '-b', TMUX_BUFFER_NAME, '-t', '%3'])
    expect(seen[4]?.args).toEqual(['send-keys', '-t', '%3', 'Enter'])
  })

  // #404 and #485 again: the submit is a separate write, and the margin insures
  // against the two being coalesced into one read.
  it('waits the submit margin between the paste and the Enter', async () => {
    const { run, sleep, slept } = runnerFor(REACHABLE)
    await createTmuxConsoleInput(run, { sleep }).sendMessage({
      pid: 4321,
      text: 'hola',
      pressEnter: true
    })
    expect(slept).toEqual([TMUX_SUBMIT_SPLIT_DELAY_MS])
  })

  it('puts the attachment pastes and the words in one buffer', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    await createTmuxConsoleInput(run, { sleep }).sendMessage({
      pid: 4321,
      text: 'look at this',
      pressEnter: true,
      attachments: [attachment('/tmp/a b.png')]
    })
    expect(seen[2]?.stdin).toBe('[200~/tmp/a b.png[201~look at this')
  })

  /*
   * The one act this tier can do that the Terminal.app tab write cannot. The
   * submit is a call of its own here, so withholding it is simply not making
   * that call — where `do script` appends a Return no caller can remove.
   */
  it('pastes without submitting when the Return must be withheld', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: false
      })
    ).toEqual({ delivered: true })
    expect(verbs(seen)).toEqual(['ps', 'list-panes', 'load-buffer', 'paste-buffer'])
  })

  it('refuses a session in no tmux pane, and says nothing was written', async () => {
    const { run, sleep, seen } = runnerFor({ ...REACHABLE, ps: 'pts/9\n' })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_NO_PANE_FOR_TTY, neverStarted: true })
    expect(verbs(seen)).toEqual(['ps', 'list-panes'])
  })

  it('refuses a session with no controlling terminal at all', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, ps: '??\n' })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_NO_PANE_FOR_TTY, neverStarted: true })
  })

  // No tmux binary at all is the ordinary case on a machine that does not use
  // one, and it reads as tmux not running rather than as a broken panel.
  it('names tmux itself when there is no tmux to ask', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, 'list-panes': new Error('ENOENT tmux') })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_NOT_RUNNING, neverStarted: true })
  })

  it('names tmux itself when it is running with no panes we can see', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, 'list-panes': '' })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_NOT_RUNNING, neverStarted: true })
  })

  it('refuses a message with no words and no files, before any command runs', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: '',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_MESSAGE_UNBUILDABLE, neverStarted: true })
    expect(seen).toEqual([])
  })

  it('refuses a message that cannot be built into one payload', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hi',
        pressEnter: true,
        attachments: [attachment(`/tmp/${'p'.repeat(5000)}.png`)]
      })
    ).toEqual({ delivered: false, error: TMUX_MESSAGE_UNBUILDABLE, neverStarted: true })
    expect(seen).toEqual([])
  })

  // A buffer that did not load pasted nothing, which is the one failure here
  // that can prove the console received nothing.
  it('says nothing was written when the buffer would not load', async () => {
    const { run, sleep, seen } = runnerFor({ ...REACHABLE, 'load-buffer': new Error('no server') })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendMessage({
        pid: 4321,
        text: 'hola',
        pressEnter: true
      })
    ).toEqual({ delivered: false, error: TMUX_WRITE_NEVER_STARTED, neverStarted: true })
    expect(verbs(seen)).toEqual(['ps', 'list-panes', 'load-buffer'])
  })

  /*
   * Cautious past that point, the way both other ports are: a paste that failed
   * may still have put part of the message in the composer, and a submit that
   * failed leaves the whole of it there. Neither licenses the relay to send the
   * same words again, so neither carries `neverStarted`.
   */
  it('claims nothing about a paste that failed', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, 'paste-buffer': new Error('pane gone') })
    const outcome = await createTmuxConsoleInput(run, { sleep }).sendMessage({
      pid: 4321,
      text: 'hola',
      pressEnter: true
    })
    expect(outcome).toEqual({ delivered: false, error: TMUX_PASTE_FAILED })
  })

  it('claims nothing about a submit that failed', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, 'send-keys': new Error('pane gone') })
    const outcome = await createTmuxConsoleInput(run, { sleep }).sendMessage({
      pid: 4321,
      text: 'hola',
      pressEnter: true
    })
    expect(outcome.delivered).toBe(false)
    expect(outcome.neverStarted).toBeUndefined()
  })
})

describe('createTmuxConsoleInput sendKey', () => {
  it('sends one digit literally into the pane, with no Enter behind it', async () => {
    const { run, sleep, seen, slept } = runnerFor(REACHABLE)
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendKey({
        pid: 4321,
        text: '4',
        pressEnter: false
      })
    ).toEqual({ delivered: true })
    expect(verbs(seen)).toEqual(['ps', 'list-panes', 'send-keys'])
    expect(seen[2]?.args).toEqual(['send-keys', '-t', '%3', '-l', '4'])
    expect(slept).toEqual([])
  })

  // Null is "not my key", and it must cost nothing at all — no ps, no tmux.
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
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendKey({ pid: 4321, text, pressEnter: false })
    ).toBeNull()
    expect(seen).toEqual([])
  })

  // #329 arriving here: a digit whose pane cannot be named is refused, never
  // pressed into whatever window happens to be in front.
  it('refuses a digit whose pane it cannot name, and says nothing was written', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, ps: 'pts/9\n' })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendKey({
        pid: 4321,
        text: '1',
        pressEnter: false
      })
    ).toEqual({ delivered: false, error: TMUX_NO_PANE_FOR_TTY, neverStarted: true })
  })

  it('claims nothing about a send-keys that failed', async () => {
    const { run, sleep } = runnerFor({ ...REACHABLE, 'send-keys': new Error('pane gone') })
    expect(
      await createTmuxConsoleInput(run, { sleep }).sendKey({
        pid: 4321,
        text: '1',
        pressEnter: false
      })
    ).toEqual({ delivered: false, error: TMUX_KEY_WRITE_FAILED })
  })
})

/*
 * The two keystroke-only acts. tmux addresses a pane; it has no way to put a
 * key into whatever window holds the FOREGROUND, which is what these two mean
 * on the ports above. Refusing is the honest answer, and the sentence says why.
 */
describe('createTmuxConsoleInput keystrokes', () => {
  it('refuses to type at the foreground, running nothing', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(await createTmuxConsoleInput(run, { sleep }).sendText('1', false)).toBe(false)
    expect(seen).toEqual([])
  })

  it('refuses the interrupt, running nothing', async () => {
    const { run, sleep, seen } = runnerFor(REACHABLE)
    expect(await createTmuxConsoleInput(run, { sleep }).sendInterrupt()).toBe(false)
    expect(seen).toEqual([])
  })

  it('names the foreground it cannot reach', () => {
    expect(TMUX_CARRIES_NO_KEYSTROKES).toContain('foreground')
  })
})
