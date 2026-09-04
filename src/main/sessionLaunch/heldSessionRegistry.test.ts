import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { HELD_CONVERSATION_LIMIT } from '../domain/types'
import { createCliDetector, type CliDetector } from '../platform/cliDetection'
import { HeldSessionRegistry } from './heldSessionRegistry'
import type {
  HeldAnswer,
  HeldSessionPort,
  HeldSessionStartRequest,
  HeldSessionTelemetryUpdate
} from './heldSession'

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

  /** The CLI's own init/result fields, arriving off the message loop (issue #96). */
  reportTelemetry(index: number, update: HeldSessionTelemetryUpdate): void {
    this.started[index]!.onTelemetry(update)
  }

  /** One message the stream carried, as the loop reads it (#159). */
  reportMessage(index: number, role: 'user' | 'assistant', text: string): void {
    this.started[index]!.onMessage(role, text)
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
      await registry.launch({
        mineId: 'mine-1',
        provider: 'claude',
        minePath: MINE,
        prompt: '  dig here  '
      })
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

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig'
    })
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

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: '   '
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('prompt')
  })

  it('states a port that would not start at all, rather than resolving as started', async () => {
    const port = new FakePort()
    port.failWith = new Error('spawn failed')
    const registry = registryOver(port)

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig'
    })
    expect(result).toEqual({ launched: false, error: 'The agent could not be started.' })
    expect(registry.count()).toBe(0)
  })

  /*
   * #168. Holding a session means an Agent SDK stream, and only Claude has one:
   * `docs/command-surface-evaluation.md:113` states outright that "Codex has no
   * held-session engine in this app (no equivalent of `sdkHeldSession.ts` exists
   * for it)". Before #168 this method could not tell — it took no provider and
   * detected `'claude'` unconditionally — so a Codex chip would have been
   * answered with a Claude session under Codex's name. It is refused BY NAME
   * instead, and the refusal comes before the disk probe because nothing about
   * this machine could change the answer.
   */
  it('refuses a provider it has no SDK stream for, by name, and starts nothing', async () => {
    const port = new FakePort()
    const registry = registryOver(port)

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'codex',
      minePath: MINE,
      prompt: 'dig'
    })

    expect(result.launched).toBe(false)
    expect(result.error).toContain('codex')
    expect(port.started).toHaveLength(0)
  })

  it('never substitutes Claude for the provider that was asked for', async () => {
    // The whole point of carrying a provider on this channel: a refusal is the
    // only honest answer, and a Claude session started here would be one the
    // user did not ask for, in a real folder.
    const port = new FakePort()
    const registry = registryOver(port)

    await registry.launch({ mineId: 'mine-1', provider: 'codex', minePath: MINE, prompt: 'dig' })

    expect(registry.count()).toBe(0)
  })
})

/*
 * Issue #191. The Claude provider asks this and nothing else of the registry:
 * an SDK-hosted session's own registry entry never carries a status, so
 * holding the stream is the one proof the provider has that the session is
 * there to draw.
 */
describe('HeldSessionRegistry.holds', () => {
  it('holds a session from the moment its stream names it until the stream ends', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })

    // Started but not yet named: no dwarf could be matched to it, so nothing
    // is claimed for any id.
    expect(registry.holds('sess-1')).toBe(false)

    port.reportSessionId(0, 'sess-1')
    expect(registry.holds('sess-1')).toBe(true)
    expect(registry.holds('sess-2')).toBe(false)

    // The stream ending is the session leaving — the dwarf goes with it.
    port.end(0)
    expect(registry.holds('sess-1')).toBe(false)
  })
})

describe('HeldSessionRegistry questions', () => {
  it("makes an arriving ask the held session's pending question, redacted and stamped", async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.questionState('sess-1')).toEqual({ held: true })
  })

  it('keeps an ask that arrived before the CLI reported its id, and shows it once it does', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })

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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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

/*
 * Issue #96. The held-session loop already reads `session_id` off `init` and
 * discards `model`, `mcp_servers`, `effort` and `claude_code_version` on the
 * same message, and never inspects a `result` message at all — so
 * `total_cost_usd`/`usage` never reach the registry either. These pin the fix:
 * the registry keeps what `onTelemetry` reports, using the same "arrives
 * late, kept until then" idiom `recordSessionId` already follows.
 */
describe('HeldSessionRegistry telemetry (#96)', () => {
  it('reports not-held for a session this panel does not hold, so a tail-derived read stands', () => {
    const registry = registryOver(new FakePort())
    expect(registry.telemetryState('sess-nobody')).toEqual({ held: false })
  })

  it('holds a session with nothing reported yet as held, with no field set', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.telemetryState('sess-1')).toEqual({ held: true })
  })

  it("keeps model, effort, mcpServers and claudeCodeVersion off the session's own init", async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, {
      model: 'claude-haiku-4-5',
      effort: 'low',
      mcpServers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'claude-ai-proxy', status: 'needs-auth' }
      ],
      claudeCodeVersion: '2.1.259'
    })

    expect(registry.telemetryState('sess-1')).toEqual({
      held: true,
      model: 'claude-haiku-4-5',
      effort: 'low',
      mcpServers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'claude-ai-proxy', status: 'needs-auth' }
      ]
      // claudeCodeVersion is registry bookkeeping, not part of the minimal
      // wire vocabulary issue #96 draws — see heldTelemetryToWire.
    })
  })

  it("keeps the session's running totalCostUsd off its result message", async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, { totalCostUsd: 0.0123 })

    expect(registry.telemetryState('sess-1')).toEqual({ held: true, totalCostUsd: 0.0123 })
  })

  it("replaces totalCostUsd with the LATEST turn's running total, never sums turns together", async () => {
    // The SDK's own doc comment on total_cost_usd: "each result carries the
    // running total so far, so read the latest result rather than summing
    // across results" — confirmed live by issue #96's spike (the structured
    // usage call's own running total matched the same turn's plain
    // total_cost_usd exactly). Summing here would silently double-count.
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, { totalCostUsd: 0.03 })
    port.reportTelemetry(0, { totalCostUsd: 0.0697689 })

    expect(registry.telemetryState('sess-1')).toEqual({ held: true, totalCostUsd: 0.0697689 })
  })

  it('keeps a later init update from erasing an earlier field it did not carry', async () => {
    // A turn's init and result are two different partial updates; a field one
    // omits must not blank out what an earlier update already recorded.
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })
    port.reportTelemetry(0, { totalCostUsd: 0.01 })

    expect(registry.telemetryState('sess-1')).toEqual({
      held: true,
      model: 'claude-haiku-4-5',
      totalCostUsd: 0.01
    })
  })

  it('drops an MCP server whose status this build does not recognise', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, {
      mcpServers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'future-server', status: 'reconnecting' }
      ]
    })

    expect(registry.telemetryState('sess-1')).toEqual({
      held: true,
      mcpServers: [{ name: 'codegraph', status: 'connected' }]
    })
  })

  it('discards telemetry once the session ends, exactly as it discards open asks', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })

    port.end(0)

    expect(registry.telemetryState('sess-1')).toEqual({ held: false })
  })
})

describe('HeldSessionRegistry.answer', () => {
  it('releases the blocked tool call with exactly the answers record the agent takes', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    await registry.launch({
      mineId: 'mine-2',
      provider: 'claude',
      minePath: '/home/j/code/forge',
      prompt: 'dig'
    })
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
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.sendText('sess-1', 'dig deeper')).toBe(true)
    expect(port.sent).toEqual(['dig deeper'])
    expect(registry.sendText('sess-nobody', 'dig deeper')).toBe(false)
  })
})

/**
 * The exchange the panel's own message surface draws (#159). A held session is
 * the one kind this app can carry a real conversation for, because it is the
 * one whose stream this process is holding — so what is kept here is only what
 * this host actually watched go by, never a transcript read back off disk.
 */
describe('HeldSessionRegistry conversation', () => {
  const AT = new Date(1_700_000_000_000).toISOString()

  it('opens the conversation with the prompt the panel itself sent', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: '  dig here  '
    })
    port.reportSessionId(0, 'sess-1')

    // First-hand: this app composed that prompt and handed it over, so it is
    // the one user message it can state without reading anything back.
    expect(registry.conversationState('sess-1')).toEqual({
      held: true,
      conversation: [{ role: 'user', text: 'dig here', timestamp: AT }]
    })
  })

  it('keeps every message the stream carried, in the order it carried them', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')

    port.reportMessage(0, 'assistant', 'Found the seam.')
    port.reportMessage(0, 'user', 'keep going')
    port.reportMessage(0, 'assistant', 'Digging.')

    const state = registry.conversationState('sess-1')
    expect(state.held ? state.conversation : []).toEqual([
      { role: 'user', text: 'dig here', timestamp: AT },
      { role: 'assistant', text: 'Found the seam.', timestamp: AT },
      { role: 'user', text: 'keep going', timestamp: AT },
      { role: 'assistant', text: 'Digging.', timestamp: AT }
    ])
  })

  it('never grows past the retention bound, however long the session runs', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')
    for (let index = 0; index < 100; index++) port.reportMessage(0, 'assistant', `line ${index}`)

    const state = registry.conversationState('sess-1')
    expect(state.held ? state.conversation : []).toHaveLength(HELD_CONVERSATION_LIMIT)
    // The prompt has aged out along with everything else: the bound is on the
    // whole list, not on "the prompt plus the last N".
    expect(state.held ? state.conversation.at(-1)!.text : '').toBe('line 99')
  })

  it('retains nothing for a session this panel does not hold', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')

    expect(registry.conversationState('sess-nobody')).toEqual({ held: false })
    port.end(0)
    // The stream is gone, so there is nothing first-hand left to claim.
    expect(registry.conversationState('sess-1')).toEqual({ held: false })
  })

  it('lets a message with no words in it go by without retaining an empty bubble', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')
    port.reportMessage(0, 'assistant', '')

    const state = registry.conversationState('sess-1')
    expect(state.held ? state.conversation : []).toHaveLength(1)
  })
})
