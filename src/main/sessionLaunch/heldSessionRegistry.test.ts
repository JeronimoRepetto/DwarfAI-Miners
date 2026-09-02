import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { createCliDetector, type CliDetector } from '../platform/cliDetection'
import { HeldSessionRegistry } from './heldSessionRegistry'
import type { HeldAnswer, HeldSessionPort, HeldSessionStartRequest } from './heldSession'

const HOME = '/home/j'
const CLAUDE = '/home/j/.local/bin/claude'
const MINE = '/home/j/code/anvil'

function installedDetector(): CliDetector {
  const fs = new FakeFs()
  fs.addFile(CLAUDE, '#!/bin/sh\n')
  return createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })
}

function missingDetector(): CliDetector {
  return createCliDetector({ home: HOME, platform: 'linux', fs: new FakeFs(), env: {} })
}

/** One question the SDK would deliver to canUseTool, well-formed. */
function askInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [{ label: 'Green', description: 'The calm one' }, { label: 'Red' }]
      }
    ]
  }
}

/**
 * Stands in for the Agent SDK. Every unit test drives the ask-answer loop
 * through this — no test may spawn a real agent, so the SDK is never imported
 * on this side of the seam.
 */
class FakePort {
  readonly started: HeldSessionStartRequest[] = []
  readonly closed: number[] = []
  readonly sent: string[] = []
  /** Whatever the host handed back for each ask, in the order the asks were made. */
  readonly answered: HeldAnswer[] = []
  /** Set to make the next start reject, as a CLI that will not launch would. */
  failWith: Error | undefined = undefined

  readonly start: HeldSessionPort = async (request) => {
    if (this.failWith !== undefined) throw this.failWith
    const index = this.started.length
    this.started.push(request)
    return {
      close: () => this.closed.push(index),
      send: (text: string) => {
        this.sent.push(text)
        return true
      }
    }
  }

  /** The SDK reporting the session id it chose. */
  reportSessionId(index: number, sessionId: string): void {
    this.started[index]!.onSessionId(sessionId)
  }

  /** An AskUserQuestion reaching canUseTool. Resolves when the host answers. */
  ask(index: number, toolUseId: string, input = askInput()): Promise<HeldAnswer> {
    const settled = this.started[index]!.onAsk(toolUseId, input)
    void settled.then((answer) => this.answered.push(answer))
    return settled
  }

  end(index: number, reason = 'the turn finished'): void {
    this.started[index]!.onEnd(reason)
  }
}

function registryOver(port: FakePort, detector: CliDetector = installedDetector()) {
  return new HeldSessionRegistry({
    detector,
    start: port.start,
    now: () => 1_700_000_000_000,
    log: () => {}
  })
}

describe('HeldSessionRegistry.launch', () => {
  it('starts the session in the mine, on the binary detection found', async () => {
    const port = new FakePort()
    const registry = registryOver(port)

    expect(
      await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: '  dig here  ' })
    ).toEqual({ launched: true })
    expect(port.started).toHaveLength(1)
    expect(port.started[0]!.executablePath).toBe(CLAUDE)
    expect(port.started[0]!.cwd).toBe(MINE)
    // Trimmed, exactly as a delivered message is.
    expect(port.started[0]!.prompt).toBe('dig here')
  })

  it("refuses with detection's own reason when the CLI is not installed, and starts nothing", async () => {
    const port = new FakePort()
    const registry = registryOver(port, missingDetector())

    const result = await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('not installed')
    // The reason detection gave travels rather than being flattened: it is the
    // one launch failure the user can act on.
    expect(result.error).toContain('not found')
    expect(port.started).toHaveLength(0)
  })

  it('refuses an empty prompt before it costs a disk probe', async () => {
    const port = new FakePort()
    const registry = registryOver(port, missingDetector())

    const result = await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: '   ' })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('prompt')
  })

  it('states a port that would not start at all, rather than resolving as started', async () => {
    const port = new FakePort()
    port.failWith = new Error('spawn failed')
    const registry = registryOver(port)

    const result = await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    expect(result).toEqual({ launched: false, error: 'The agent could not be started.' })
    expect(registry.count()).toBe(0)
  })
})

describe('HeldSessionRegistry questions', () => {
  it("makes an arriving ask the held session's pending question, redacted and stamped", async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    void port.ask(0, 'toolu_01')
    await Promise.resolve()

    expect(registry.questionState('sess-1')).toEqual({
      held: true,
      question: {
        toolUseId: 'toolu_01',
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [{ label: 'Green', description: 'The calm one' }, { label: 'Red' }],
        askedAt: '2023-11-14T22:13:20.000Z'
      }
    })
  })

  it('reports a session it does not hold as not held, so the tail stands', () => {
    const registry = registryOver(new FakePort())
    expect(registry.questionState('sess-nobody')).toEqual({ held: false })
  })

  it('holds a session with nothing open, which is not the same as not holding it', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.questionState('sess-1')).toEqual({ held: true })
  })

  it('keeps an ask that arrived before the CLI reported its id, and shows it once it does', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })

    void port.ask(0, 'toolu_early')
    await Promise.resolve()
    port.reportSessionId(0, 'sess-1')

    expect(registry.questionState('sess-1')).toMatchObject({
      held: true,
      question: { toolUseId: 'toolu_early' }
    })
  })

  it('shows the latest of two open asks, and answers either by its own id', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    void port.ask(0, 'toolu_first')
    const second = port.ask(0, 'toolu_second')
    await Promise.resolve()
    expect(registry.questionState('sess-1')).toMatchObject({
      question: { toolUseId: 'toolu_second' }
    })

    expect(
      registry.answer({
        sessionId: 'sess-1',
        toolUseId: 'toolu_second',
        answers: { 'Which colour?': 'Green' }
      })
    ).toEqual({ answered: true })
    await expect(second).resolves.toEqual({
      answered: true,
      answers: { 'Which colour?': 'Green' }
    })
    // The first is still open, and answering the second did not touch it.
    expect(registry.questionState('sess-1')).toMatchObject({
      question: { toolUseId: 'toolu_first' }
    })
  })
})

describe('HeldSessionRegistry.answer', () => {
  it('releases the blocked tool call with exactly the answers record the agent takes', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    const asked = port.ask(0, 'toolu_01')
    await Promise.resolve()

    expect(
      registry.answer({
        sessionId: 'sess-1',
        toolUseId: 'toolu_01',
        answers: { 'Which colour?': 'Green' }
      })
    ).toEqual({ answered: true })

    await expect(asked).resolves.toEqual({
      answered: true,
      answers: { 'Which colour?': 'Green' }
    })
    // Answered means gone: the panel must not be able to answer it twice.
    expect(registry.questionState('sess-1')).toEqual({ held: true })
  })

  it('refuses an answer for a session this panel is not holding', () => {
    const registry = registryOver(new FakePort())
    const result = registry.answer({
      sessionId: 'sess-nobody',
      toolUseId: 'toolu_01',
      answers: { 'Which colour?': 'Green' }
    })
    expect(result.answered).toBe(false)
    expect(result.error).toContain('session')
  })

  it('refuses an answer naming an ask that is no longer open, rather than re-aiming it', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    void port.ask(0, 'toolu_01')
    await Promise.resolve()

    const result = registry.answer({
      sessionId: 'sess-1',
      toolUseId: 'toolu_other',
      answers: { 'Which colour?': 'Green' }
    })
    expect(result.answered).toBe(false)
    expect(result.error).toContain('question')
    // And the real ask is untouched.
    expect(registry.questionState('sess-1')).toMatchObject({ question: { toolUseId: 'toolu_01' } })
  })

  it('refuses an option the agent never offered, and leaves the call blocked', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    void port.ask(0, 'toolu_01')
    await Promise.resolve()

    const result = registry.answer({
      sessionId: 'sess-1',
      toolUseId: 'toolu_01',
      answers: { 'Which colour?': 'Blue' }
    })
    expect(result.answered).toBe(false)
    expect(port.answered).toHaveLength(0)
    expect(registry.questionState('sess-1')).toMatchObject({ question: { toolUseId: 'toolu_01' } })
  })
})

describe('HeldSessionRegistry lifetime', () => {
  it('dissolves an open question when the session ends, and never fabricates an answer', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    const asked = port.ask(0, 'toolu_01')
    await Promise.resolve()

    port.end(0)

    const answer = await asked
    expect(answer.answered).toBe(false)
    expect(answer.answered ? '' : answer.reason).toContain('answered')
    // The session is gone, so the dwarf's tail-derived question stands again.
    expect(registry.questionState('sess-1')).toEqual({ held: false })
    expect(registry.count()).toBe(0)
  })

  it('dissolves every open question and closes every session on shutdown', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    await registry.launch({ mineId: 'mine-2', minePath: '/home/j/code/forge', prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportSessionId(1, 'sess-2')
    const asked = port.ask(0, 'toolu_01')
    await Promise.resolve()

    registry.closeAll()

    expect((await asked).answered).toBe(false)
    expect(port.closed).toEqual([0, 1])
    expect(registry.count()).toBe(0)
    expect(registry.questionState('sess-1')).toEqual({ held: false })
  })

  it('routes text over the held stream when the session is one it holds', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.sendText('sess-1', 'dig deeper')).toBe(true)
    expect(port.sent).toEqual(['dig deeper'])
    expect(registry.sendText('sess-nobody', 'dig deeper')).toBe(false)
  })
})
