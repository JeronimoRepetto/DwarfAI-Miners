import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FeedActivity, FeedMessage } from '../domain/types'
import {
  AntigravityStreamReader,
  antigravityHeldArgs,
  antigravityUserEvent,
  buildAntigravityHeldSpawn,
  createAntigravityHeldSession,
  type AntigravityChild,
  type AntigravityHeldSignal
} from './antigravityHeldSession'
import type { HeldSessionStartRequest, HeldSessionTelemetryUpdate } from './heldSession'

/*
 * Issue #237, step 5. Every expectation about the WIRE here is read off a
 * sanitized capture of one exact CLI version's own stdout (Antigravity CLI
 * 1.1.26, see providers/__fixtures__/antigravity/README.md) rather than off
 * the published protocol page alone — the page documents `-p` and a
 * `request-review` default that the installed build disagreed with, so the
 * capture is the authority and the page is the map.
 *
 * No test here starts a process: the spawn is a value (`buildAntigravityHeldSpawn`),
 * the stream is a pure reader over text, and the port itself is driven through
 * an injected fake child — the same discipline heldSessionRegistry.test.ts
 * holds for the Agent SDK.
 */

const FIXTURES = join(import.meta.dirname, '..', 'providers', '__fixtures__', 'antigravity')
const heldStream = readFileSync(join(FIXTURES, 'held-stream.jsonl'), 'utf8')
const heldStreamEdges = readFileSync(join(FIXTURES, 'held-stream-edges.jsonl'), 'utf8')

const CONVERSATION = '44444444-4444-4444-8444-444444444444'
const MINE = 'C:\\Users\\j\\Desktop\\Sample-Project'
const AGY = 'C:\\Users\\j\\AppData\\Local\\agy\\bin\\agy.exe'

/** Every signal one whole fixture carries, read in one pass. */
function signalsOf(text: string): AntigravityHeldSignal[] {
  return new AntigravityStreamReader().receive(text)
}

describe('antigravityHeldArgs', () => {
  /*
   * The one argv fact the published page gets wrong, and it cost the probe two
   * runs: `-p` takes a VALUE. `agy -p --input-format stream-json` exits 2 with
   * `-p took "--input-format" as its prompt`, and a bare `-p` at the end exits
   * 2 with `flag needs an argument: -p`. `--input-format stream-json` is what
   * puts the CLI in print mode, so `-p` is not passed at all.
   */
  it('never passes -p, which would swallow the next flag as its prompt', () => {
    expect(antigravityHeldArgs()).not.toContain('-p')
    expect(antigravityHeldArgs()).not.toContain('--print')
  })

  it('asks for stream-json on both halves, because the CLI requires the pair', () => {
    expect(antigravityHeldArgs()).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json'
    ])
  })

  it('forwards a model and an effort the launch named, and nothing when it named none', () => {
    expect(antigravityHeldArgs({ model: 'a-model-slug' })).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'a-model-slug'
    ])
    expect(antigravityHeldArgs({ effort: 'high' })).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--effort',
      'high'
    ])
  })
})

describe('antigravityUserEvent', () => {
  it('is one NDJSON user event per line, exactly as the CLI reads them', () => {
    expect(antigravityUserEvent('dig here')).toBe(
      '{"event":"user","message":{"content":"dig here"}}\n'
    )
  })

  it('keeps a multi-line prompt on ONE line, so it stays one turn', () => {
    const line = antigravityUserEvent('first\nsecond')
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
    expect(JSON.parse(line).message.content).toBe('first\nsecond')
  })
})

describe('buildAntigravityHeldSpawn', () => {
  it('holds the child rather than detaching it, with all three streams piped', () => {
    const call = buildAntigravityHeldSpawn({
      program: AGY,
      args: antigravityHeldArgs(),
      cwd: MINE,
      env: { PATH: '/usr/bin' }
    })
    expect(call.command).toBe(AGY)
    expect(call.args).toEqual(antigravityHeldArgs())
    expect(call.options.cwd).toBe(MINE)
    expect(call.options.detached).toBe(false)
    // stderr is its OWN pipe, unlike a hosted process's folded stream: a
    // stderr chunk landing mid-line would corrupt the NDJSON being parsed.
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.options.windowsHide).toBe(true)
  })

  it('runs no shell, because the argv is a constant and the prompt is on stdin', () => {
    const call = buildAntigravityHeldSpawn({
      program: AGY,
      args: [],
      cwd: MINE,
      env: {}
    })
    expect(call.options.shell).toBeUndefined()
  })
})

describe('AntigravityStreamReader', () => {
  it('reports the conversation the CLI named itself, off init', () => {
    expect(signalsOf(heldStream)).toContainEqual({
      kind: 'conversation',
      conversationId: CONVERSATION
    })
  })

  /*
   * The measurement that decides how a reply is read. Step 1 of the fixture is
   * three events: "Checking the parser", " first", and a DONE carrying only
   * ".". Publishing any one of them is wrong; concatenating all three is what
   * equals the turn's own `result.response`.
   */
  it('concatenates every text_delta of one step and publishes it once, at DONE', () => {
    const messages = signalsOf(heldStream).filter((signal) => signal.kind === 'message')
    expect(messages).toContainEqual({
      kind: 'message',
      role: 'assistant',
      text: 'Checking the parser first.'
    })
    // Once, not once per chunk.
    expect(messages.filter((message) => message.text.startsWith('Checking'))).toHaveLength(1)
  })

  it('publishes both turns of the held exchange, in order', () => {
    const spoken = signalsOf(heldStream)
      .filter((signal) => signal.kind === 'message' && signal.activity === undefined)
      .map((signal) => (signal.kind === 'message' ? signal.text : ''))
    expect(spoken).toEqual(['Checking the parser first.', 'pong', 'ping'])
  })

  /*
   * A tool step arrives TWICE — ACTIVE with its parameters, then DONE with its
   * output — and both carry the same `step_index`. One line, not two.
   *
   * The verb and the arg-name mapping are both shared (#240, #280), so this
   * asserts the two things that ARE this module's: the de-duplication above,
   * and that a stream parameter is read with ONE decode where a transcript's
   * needs two — see `used`.
   */
  it('draws one activity line per tool step, however many times the step is reported', () => {
    const activities = signalsOf(heldStream).filter(
      (signal) => signal.kind === 'message' && signal.activity !== undefined
    )
    expect(activities).toEqual([
      {
        kind: 'message',
        role: 'assistant',
        text: 'Ran echo hello',
        activity: { kind: 'run', target: 'echo hello' } satisfies FeedActivity
      }
    ])
  })

  /*
   * Only `result.usage` is cumulative; a step's own `usage` is that step's
   * alone. The registry MERGES a telemetry update, replacing what came before,
   * so reporting a step's usage would make the session's totals go backwards.
   */
  it('reports token usage only off result, where the CLI states it cumulatively', () => {
    const updates = signalsOf(heldStream)
      .filter((signal) => signal.kind === 'telemetry')
      .map((signal) => (signal.kind === 'telemetry' ? signal.update : {}))
      .filter((update) => update.usage !== undefined)
    expect(updates).toEqual([
      {
        usage: {
          inputTokens: 22007,
          outputTokens: 463,
          cacheReadInputTokens: 12199,
          thinkingTokens: 354
        },
        turn: 'ended'
      },
      {
        usage: {
          inputTokens: 26746,
          outputTokens: 494,
          cacheReadInputTokens: 24394,
          thinkingTokens: 384
        },
        turn: 'ended'
      }
    ])
  })

  /*
   * The one thing Antigravity's stream cannot report that Claude's does: this
   * CLI emits `init` once per PROCESS, so nothing on the wire marks a turn's
   * START. Only its end is stated, and the registry supplies the other edge
   * from the message it just sent.
   */
  it('marks only the END of a turn, because init arrives once per process', () => {
    const edges = signalsOf(heldStream)
      .filter((signal) => signal.kind === 'telemetry')
      .map((signal) => (signal.kind === 'telemetry' ? signal.update.turn : undefined))
      .filter((turn) => turn !== undefined)
    expect(edges).toEqual(['ended', 'ended'])
  })

  it('reports a model only when the CLI names one, and never invents one', () => {
    const models = signalsOf(heldStream)
      .filter((signal) => signal.kind === 'telemetry')
      .map((signal) => (signal.kind === 'telemetry' ? signal.update.model : undefined))
      .filter((model) => model !== undefined)
    // Nothing in the captured stream names a model — the launch passed none.
    expect(models).toEqual([])
    const named = signalsOf(heldStreamEdges)
      .filter((signal) => signal.kind === 'telemetry')
      .map((signal) => (signal.kind === 'telemetry' ? signal.update.model : undefined))
      .filter((model) => model !== undefined)
    expect(named).toEqual(['a-model-slug'])
  })

  /*
   * The private-format discipline applied to a public one: this is still a
   * shape that has changed across CLI versions, so anything unrecognised is a
   * miss rather than a throw inside a poll tick.
   */
  it('degrades on every shape it has no reading for, and never throws', () => {
    const signals = signalsOf(heldStreamEdges)
    // The unknown step type, the unknown event, the non-JSON line and the
    // half-written tail all publish nothing.
    expect(signals.filter((signal) => signal.kind === 'message')).toEqual([])
    // The conversation and the model are still read off the init that did parse.
    expect(signals.filter((signal) => signal.kind === 'conversation')).toHaveLength(1)
  })

  it('says nothing for an agent_response step that carried no text', () => {
    expect(signalsOf(heldStreamEdges).some((signal) => signal.kind === 'message')).toBe(false)
  })

  it('draws no activity line for a tool whose input names no subject', () => {
    // `manage_task` is in the edges fixture with an `Action` parameter.
    // `antigravityToolSubject` (#280) does not name that tool and `Action` is
    // not one of the canonical fields, so both shared tables answer nothing —
    // a deliberate miss, which is their own stated posture.
    const activities = signalsOf(heldStreamEdges).filter(
      (signal) => signal.kind === 'message' && signal.activity !== undefined
    )
    expect(activities).toEqual([])
  })

  it('reports an ERROR result as a turn that ended, and never as words the agent said', () => {
    const updates = signalsOf(heldStreamEdges)
      .filter((signal) => signal.kind === 'telemetry')
      .map((signal) => (signal.kind === 'telemetry' ? signal.update : {}))
    expect(updates.some((update) => update.turn === 'ended')).toBe(true)
    expect(signalsOf(heldStreamEdges).filter((signal) => signal.kind === 'message')).toEqual([])
  })

  /** Chunk boundaries are the pipe's business, not the protocol's. */
  it('holds a line split across two chunks until the newline arrives', () => {
    const reader = new AntigravityStreamReader()
    const half = heldStream.indexOf('\n', heldStream.indexOf('"event":"result"'))
    const cut = Math.floor(half / 2)
    const first = reader.receive(heldStream.slice(0, cut))
    const second = reader.receive(heldStream.slice(cut))
    expect([...first, ...second]).toEqual(signalsOf(heldStream))
  })

  it('never reports a crew, because this app has never seen a subagent_info', () => {
    // Absent beats guessed: the protocol names the field, the probe saw none,
    // and HeldSessionSubagentSignal needs a task id and a depth nothing here
    // could honestly supply. See the module comment.
    expect(signalsOf(heldStream).some((signal) => signal.kind === 'crew')).toBe(false)
  })
})

/** A child process, faked. No test here spawns one. */
class FakeChild implements AntigravityChild {
  readonly pid = 4242
  readonly stdinWrites: string[] = []
  killed = false
  stdinBroken = false
  private listeners = new Map<string, ((value: never) => void)[]>()

  readonly stdin = {
    on: () => this,
    write: (chunk: string): unknown => {
      if (this.stdinBroken) throw new Error('EPIPE')
      this.stdinWrites.push(chunk)
      return true
    },
    end: () => {}
  }
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: string) => void) => this.hold('stdout', listener)
  }
  readonly stderr = {
    on: (_event: 'data', listener: (chunk: string) => void) => this.hold('stderr', listener)
  }

  once(event: string, listener: (value: never) => void): unknown {
    return this.hold(event, listener)
  }

  kill(): void {
    this.killed = true
  }

  private hold(event: string, listener: (value: never) => void): this {
    const held = this.listeners.get(event) ?? []
    held.push(listener)
    this.listeners.set(event, held)
    return this
  }

  private fire(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? [])
      (listener as (v: unknown) => void)(value)
  }

  spawned(): void {
    this.fire('spawn', undefined)
  }

  say(text: string): void {
    this.fire('stdout', text)
  }

  exit(code: number | null): void {
    this.fire('exit', code)
  }
}

/** Everything the port reported back, for one started session. */
function recorder() {
  const messages: { role: FeedMessage['role']; text: string; activity?: FeedActivity }[] = []
  const telemetry: HeldSessionTelemetryUpdate[] = []
  const sessionIds: string[] = []
  const ends: string[] = []
  const request: HeldSessionStartRequest = {
    executablePath: AGY,
    cwd: MINE,
    prompt: 'dig here',
    onSessionId: (sessionId) => sessionIds.push(sessionId),
    onTelemetry: (update) => telemetry.push(update),
    onMessage: (role, text, activity) =>
      messages.push({ role, text, ...(activity === undefined ? {} : { activity }) }),
    onAsk: () => Promise.resolve({ answered: false, reason: 'not offered' }),
    onPermission: () => Promise.resolve({ decision: 'deny', reason: 'not offered' }),
    onSubagent: () => {},
    onEnd: (reason) => ends.push(reason)
  }
  return { messages, telemetry, sessionIds, ends, request }
}

async function startOver(child: FakeChild) {
  const seen = recorder()
  const port = createAntigravityHeldSession(() => child)
  const pending = port(seen.request)
  child.spawned()
  return { ...seen, handle: await pending }
}

describe('createAntigravityHeldSession', () => {
  it('sends the launch prompt as the first stream-json input event', async () => {
    const child = new FakeChild()
    await startOver(child)
    expect(child.stdinWrites).toEqual([antigravityUserEvent('dig here')])
  })

  it('does not echo the launch prompt, which the registry has already seeded', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    expect(session.messages).toEqual([])
  })

  it('ingests the CLI’s own events into the session’s id, feed and telemetry', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    child.say(heldStream)
    expect(session.sessionIds).toEqual([CONVERSATION])
    expect(session.messages.map((message) => message.text)).toEqual([
      'Checking the parser first.',
      'Ran echo hello',
      'pong',
      'ping'
    ])
    expect(session.telemetry.at(-1)).toEqual({
      usage: {
        inputTokens: 26746,
        outputTokens: 494,
        cacheReadInputTokens: 24394,
        thinkingTokens: 384
      },
      turn: 'ended'
    })
  })

  /*
   * A follow-up is one more input event on the SAME stdin, and this app is the
   * only thing that knows it was said: the CLI's own `user_input` step carries
   * no content, so a session spoken to would otherwise show a reply with
   * nothing in front of it.
   */
  it('delivers ordinary follow-up text as a further input event, and echoes it once', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    expect(session.handle.send('and again')).toBe(true)
    expect(child.stdinWrites).toEqual([
      antigravityUserEvent('dig here'),
      antigravityUserEvent('and again')
    ])
    expect(session.messages).toEqual([{ role: 'user', text: 'and again' }])
  })

  it('reports a refused write as not delivered, never as a message that went', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    child.stdinBroken = true
    expect(session.handle.send('and again')).toBe(false)
    expect(session.messages).toEqual([])
  })

  /*
   * The acceptance gate, in the type system: this protocol documents no cancel
   * event and no answer event, so the handle simply does not carry the
   * capability. Absent, never a `false` that reads as "it was tried".
   */
  it('offers no interrupt and no context reading, because the protocol has neither', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    expect(session.handle.interrupt).toBeUndefined()
    expect(session.handle.contextUsage).toBeUndefined()
  })

  it('ends the session by ending the process', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    session.handle.close()
    expect(child.killed).toBe(true)
    expect(session.ends).toEqual(['the panel closed the session'])
  })

  it('reports the child’s own exit exactly once, and not again on a later close', async () => {
    const child = new FakeChild()
    const session = await startOver(child)
    child.exit(0)
    session.handle.close()
    expect(session.ends).toEqual(['exit 0'])
  })

  it('rejects when the child could not be started at all', async () => {
    const port = createAntigravityHeldSession(() => {
      throw new Error('ENOENT')
    })
    await expect(port(recorder().request)).rejects.toThrow('ENOENT')
  })
})
