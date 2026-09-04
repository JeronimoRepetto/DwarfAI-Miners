import { describe, expect, it } from 'vitest'
import { HELD_CONVERSATION_LIMIT } from '../domain/types'
import { SHELL_METACHARACTER_REFUSAL, SHIM_REFUSAL } from './hostedCommand'
import {
  HostedProcessRegistry,
  type HostedProcessPort,
  type HostedProcessStartRequest
} from './hostedProcesses'

const MINE = '/home/j/code/anvil'
const MINE_ID = 'mine:anvil'

/**
 * Stands in for a real child process. Every unit test drives the holder
 * through this — no test in this suite may spawn one, so `node:child_process`
 * is never reached from this side of the seam (CONTRIBUTING.md's deterministic
 * fakes rule, and the reason the real port lives in nodeHostedProcess.ts).
 */
class FakePort {
  readonly started: HostedProcessStartRequest[] = []
  /** Everything written to each child's stdin, in order, by child index. */
  readonly written: string[][] = []
  /** Set to make the next start reject, as a program that will not run would. */
  failWith: Error | undefined = undefined
  /** Set false to make stdin refuse a write, as a closed stream would. */
  stdinTakes = true
  /** The pid each successive child reports; undefined means it reported none. */
  pids: (number | undefined)[] = []

  readonly start: HostedProcessPort = async (request) => {
    if (this.failWith !== undefined) throw this.failWith
    const index = this.started.length
    this.started.push(request)
    this.written.push([])
    return {
      pid: index < this.pids.length ? this.pids[index] : 1000 + index,
      send: (text: string) => {
        if (!this.stdinTakes) return false
        this.written[index]!.push(text)
        return true
      }
    }
  }

  /** The child writing to stdout or stderr. */
  emit(index: number, text: string): void {
    this.started[index]!.onOutput(text)
  }

  /** The child exiting on its own. */
  exit(index: number, reason = 'exit 0'): void {
    this.started[index]!.onEnd(reason)
  }
}

/** Records every tree kill the holder asks the per-OS port for (#217's seam). */
class FakeProcessEnd {
  readonly ended: number[] = []
  succeeds = true

  readonly endProcessTree = async (pid: number): Promise<boolean> => {
    this.ended.push(pid)
    return this.succeeds
  }
}

interface Harness {
  registry: HostedProcessRegistry
  port: FakePort
  ends: FakeProcessEnd
  clock: { now: number }
  logs: string[]
}

function harness(): Harness {
  const port = new FakePort()
  const ends = new FakeProcessEnd()
  const clock = { now: 1_700_000_000_000 }
  const logs: string[] = []
  const registry = new HostedProcessRegistry({
    start: port.start,
    endProcessTree: ends.endProcessTree,
    env: { PATH: '/usr/bin' },
    now: () => clock.now,
    log: (message) => logs.push(message)
  })
  return { registry, port, ends, clock, logs }
}

async function launched(
  h: Harness,
  command = 'my-agent --once',
  prompt = 'dig the east gallery'
): Promise<string> {
  const result = await h.registry.launch({ mineId: MINE_ID, minePath: MINE, command, prompt })
  expect(result.error, 'launch was refused').toBeUndefined()
  return result.hostedId!
}

describe('refusing a command before anything is started', () => {
  it("repeats the parse's own reason for a command carrying shell syntax", async () => {
    const h = harness()

    const result = await h.registry.launch({
      mineId: MINE_ID,
      minePath: MINE,
      command: 'my-agent | tee log',
      prompt: 'dig'
    })

    expect(result.started).toBe(false)
    expect(result.error).toBe(SHELL_METACHARACTER_REFUSAL)
    expect(h.port.started).toHaveLength(0)
  })

  it('repeats it for a shim, which cannot be spawned without a shell', async () => {
    const h = harness()

    const result = await h.registry.launch({
      mineId: MINE_ID,
      minePath: MINE,
      command: 'C:\\tools\\my-agent.cmd',
      prompt: 'dig'
    })

    expect(result.error).toBe(SHIM_REFUSAL)
    expect(h.port.started).toHaveLength(0)
  })

  /*
   * Cheapest refusal first, exactly as both existing launch engines order
   * theirs: an empty box must never cost a spawn.
   */
  it('refuses a prompt that is only whitespace and starts nothing', async () => {
    const h = harness()

    const result = await h.registry.launch({
      mineId: MINE_ID,
      minePath: MINE,
      command: 'my-agent',
      prompt: '   \n\t '
    })

    expect(result.started).toBe(false)
    expect(result.error).not.toBeUndefined()
    expect(h.port.started).toHaveLength(0)
  })

  it('turns a program that will not run into a reason, never a silent no-op', async () => {
    const h = harness()
    h.port.failWith = new Error('ENOENT')

    const result = await h.registry.launch({
      mineId: MINE_ID,
      minePath: MINE,
      command: 'my-agent',
      prompt: 'dig'
    })

    expect(result.started).toBe(false)
    expect(result.error).not.toBeUndefined()
    expect(h.registry.count()).toBe(0)
  })
})

describe('starting the command the person typed', () => {
  it('starts the parsed program with the parsed argv, in the mine folder', async () => {
    const h = harness()

    await launched(h, 'my-agent --do-the-thing --twice')

    expect(h.port.started[0]?.program).toBe('my-agent')
    expect(h.port.started[0]?.args).toEqual(['--do-the-thing', '--twice'])
    expect(h.port.started[0]?.cwd).toBe(MINE)
  })

  /*
   * The privacy rule at the top of launch.ts, which was never Claude-specific:
   * argv is readable by any other process on this machine, so nothing the user
   * types may travel in it. Here the prompt IS the user's words, so this is the
   * assertion that keeps them off the process list.
   */
  it('puts the prompt on stdin and never in argv', async () => {
    const h = harness()

    await launched(h, 'my-agent', 'dig the east gallery')

    expect(h.port.started[0]?.args).toEqual([])
    expect(h.port.started[0]?.prompt).toBe('dig the east gallery')
    expect(JSON.stringify(h.port.started[0]?.args)).not.toContain('east gallery')
  })

  it('trims and caps the prompt exactly as the other two engines do', async () => {
    const h = harness()

    await launched(h, 'my-agent', '  dig the east gallery \n')

    expect(h.port.started[0]?.prompt).toBe('dig the east gallery')
  })

  it('logs the length of what it sent and never the words', async () => {
    const h = harness()

    await launched(h, 'my-agent', 'dig the east gallery')

    expect(h.logs.join('\n')).not.toContain('east gallery')
    expect(h.logs.join('\n')).toContain('20')
  })
})

describe('the conversation a hosted process has', () => {
  /*
   * The receipt the panel adopts a launch by (`launchedDwarfIn`): the first
   * message is the prompt this app sent, known first-hand and seeded exactly
   * once, precisely as HeldSessionRegistry seeds a held session's own.
   */
  it('opens with the prompt this app sent, as a user turn', async () => {
    const h = harness()
    const id = await launched(h, 'my-agent', 'dig the east gallery')

    const state = h.registry.states().find((entry) => entry.hostedId === id)

    expect(state?.conversation[0]).toEqual({
      role: 'user',
      text: 'dig the east gallery',
      timestamp: new Date(h.clock.now).toISOString()
    })
  })

  it('shows the captured output as plain text, oldest first', async () => {
    const h = harness()
    const id = await launched(h)

    h.port.emit(0, 'starting up')
    h.clock.now += 1_000
    h.port.emit(0, 'done')

    const state = h.registry.states().find((entry) => entry.hostedId === id)
    expect(state?.conversation.map((message) => message.text)).toEqual([
      'dig the east gallery',
      'starting up',
      'done'
    ])
    expect(state?.conversation[1]?.role).toBe('assistant')
  })

  it('keeps only the last messages the wire admits, like a held session', async () => {
    const h = harness()
    const id = await launched(h)

    for (let index = 0; index < HELD_CONVERSATION_LIMIT + 5; index++) {
      h.port.emit(0, `line ${index}`)
    }

    const state = h.registry.states().find((entry) => entry.hostedId === id)
    expect(state?.conversation).toHaveLength(HELD_CONVERSATION_LIMIT)
  })

  it('redacts a secret in the output before it is ever kept', async () => {
    const h = harness()
    const id = await launched(h)

    h.port.emit(0, 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345')

    const kept = h.registry.states().find((entry) => entry.hostedId === id)?.conversation ?? []
    expect(JSON.stringify(kept)).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
  })

  it('keeps nothing for output that is only whitespace', async () => {
    const h = harness()
    const id = await launched(h)

    h.port.emit(0, '   \n\n  ')

    expect(h.registry.states().find((entry) => entry.hostedId === id)?.conversation).toHaveLength(1)
  })
})

describe('writing into a hosted process', () => {
  /*
   * The one thing a DETACHED launch cannot do, and the reason this mode exists
   * at all: launchRunner closes stdin straight after the prompt, so there is
   * nothing left to write to (#217's launchedNoInboxReason). A hosted process
   * keeps its stdin, so the composer is a real inbox.
   */
  it('puts a later message onto the stdin the holder is still holding', async () => {
    const h = harness()
    const id = await launched(h)

    expect(h.registry.sendText(id, 'also check the west wall')).toBe(true)

    expect(h.port.written[0]).toEqual(['also check the west wall'])
  })

  it('records what it sent as a user turn in the conversation', async () => {
    const h = harness()
    const id = await launched(h)

    h.registry.sendText(id, 'also check the west wall')

    const kept = h.registry.states().find((entry) => entry.hostedId === id)?.conversation ?? []
    expect(kept[kept.length - 1]).toMatchObject({
      role: 'user',
      text: 'also check the west wall'
    })
  })

  it('is false for a process it does not hold, so the caller states the failure', async () => {
    const h = harness()
    await launched(h)

    expect(h.registry.sendText('hosted:nobody', 'hello')).toBe(false)
  })

  it('is false when the stream itself refused the write, and keeps nothing', async () => {
    const h = harness()
    const id = await launched(h)
    h.port.stdinTakes = false

    expect(h.registry.sendText(id, 'also check the west wall')).toBe(false)

    const kept = h.registry.states().find((entry) => entry.hostedId === id)?.conversation ?? []
    expect(JSON.stringify(kept)).not.toContain('west wall')
  })

  it('is false once that process has ended, rather than writing into a dead pipe', async () => {
    const h = harness()
    const id = await launched(h)
    h.port.exit(0)

    expect(h.registry.sendText(id, 'hello')).toBe(false)
  })
})

describe('ending a hosted process', () => {
  /*
   * The per-OS act, behind the port #230 put it behind: a tree kill, because a
   * hosted process may have spawned tools of its own that no job object of
   * ours holds (see platform/processEnd.ts).
   */
  it('ends the process TREE through the per-OS port, by the pid it started', async () => {
    const h = harness()
    h.port.pids = [4242]
    const id = await launched(h)

    expect(await h.registry.end(id)).toBe('ended')

    expect(h.ends.ended).toEqual([4242])
  })

  it('never claims success the platform did not report', async () => {
    const h = harness()
    const id = await launched(h)
    h.ends.succeeds = false

    expect(await h.registry.end(id)).toBe('refused')
  })

  /*
   * The pid-reuse guard #217 states: the moment that process is gone its
   * number can belong to anything on this machine, so a process that has
   * ended is never signalled.
   */
  it('signals nothing for a process that has already gone', async () => {
    const h = harness()
    const id = await launched(h)
    h.port.exit(0)

    expect(await h.registry.end(id)).toBe('already-ended')
    expect(h.ends.ended).toEqual([])
  })

  it('signals nothing twice for the same process', async () => {
    const h = harness()
    const id = await launched(h)

    await h.registry.end(id)
    expect(await h.registry.end(id)).toBe('already-ended')

    expect(h.ends.ended).toHaveLength(1)
  })

  it('reports a process it never held as already ended rather than erroring', async () => {
    const h = harness()

    expect(await h.registry.end('hosted:nobody')).toBe('already-ended')
    expect(h.ends.ended).toEqual([])
  })

  it('has no exit to offer for a process that reported no pid', async () => {
    const h = harness()
    h.port.pids = [undefined]
    const id = await launched(h)

    expect(await h.registry.end(id)).toBe('refused')
    expect(h.ends.ended).toEqual([])
  })
})

describe('what happens to a hosted process the panel stops holding', () => {
  /*
   * The bargain, stated where it is made: a hosted process dies with the
   * panel. That is the opposite of the detached launch, which outlives it, and
   * it is the price of the panel being this process's stdio at all — there is
   * nobody else to read its output or write its input.
   */
  it('ends every held process on quit', async () => {
    const h = harness()
    h.port.pids = [11, 22]
    await launched(h, 'a')
    await launched(h, 'b')

    await h.registry.closeAll()

    expect(h.ends.ended.sort()).toEqual([11, 22])
    expect(h.registry.count()).toBe(0)
  })

  it('marks a process that exited on its own as gone, and keeps its words', async () => {
    const h = harness()
    const id = await launched(h)
    h.port.emit(0, 'all done')

    h.port.exit(0, 'exit 0')

    const state = h.registry.states().find((entry) => entry.hostedId === id)
    expect(state?.running).toBe(false)
    expect(state?.conversation.map((message) => message.text)).toContain('all done')
  })

  it('still reports a process that has gone, so the board can walk it out', async () => {
    const h = harness()
    const id = await launched(h)

    h.port.exit(0)

    expect(h.registry.states().map((state) => state.hostedId)).toEqual([id])
  })
})

describe('what a hosted process says about itself', () => {
  it('names the mine it was started in and the program it is', async () => {
    const h = harness()
    const id = await launched(h, 'my-agent --once')

    const state = h.registry.states().find((entry) => entry.hostedId === id)

    expect(state?.mineId).toBe(MINE_ID)
    expect(state?.minePath).toBe(MINE)
    expect(state?.program).toBe('my-agent')
  })

  /*
   * The whole of the honest limit the maintainer's decision names: a process
   * with no session store behind it has no transcript, so tier, subagents,
   * models, tokens and reactions are not "not yet" — there is nothing that
   * could ever report them. The state shape carries none of them, which is
   * what stops one being invented later by accident.
   */
  it('carries no transcript-derived facts at all', async () => {
    const h = harness()
    const id = await launched(h)
    h.port.emit(0, 'working')

    const state = h.registry.states().find((entry) => entry.hostedId === id)!

    expect(Object.keys(state).sort()).toEqual(
      ['conversation', 'hostedId', 'mineId', 'minePath', 'program', 'running'].sort()
    )
  })

  it('gives every hosted process its own id, so two of the same command are told apart', async () => {
    const h = harness()

    const first = await launched(h, 'my-agent')
    const second = await launched(h, 'my-agent')

    expect(first).not.toBe(second)
  })
})
