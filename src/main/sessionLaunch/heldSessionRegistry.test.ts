import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { HELD_CONVERSATION_LIMIT } from '../domain/types'
import { createCliDetector, type CliDetector } from '../platform/cliDetection'
import {
  HeldSessionRegistry,
  TUNING_NOT_HELD,
  TUNING_REFUSED,
  TUNING_TIMED_OUT,
  TUNING_UNSUPPORTED
} from './heldSessionRegistry'
import { HELD_CONTEXT_USAGE_TIMEOUT_MS, HELD_TUNING_TIMEOUT_MS } from './heldSession'
import type {
  HeldAnswer,
  HeldPermission,
  HeldPermissionAnswer,
  HeldSessionContextUsage,
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
  /** Which sessions were asked to cut their turn short, in order (#210). */
  readonly interrupted: number[] = []
  /** Whatever the host handed back for each ask, in the order the asks were made. */
  readonly answered: HeldAnswer[] = []
  /** Set to make the next start reject, as a CLI that will not launch would. */
  failWith: Error | undefined = undefined
  /** Set false to make the stream refuse an interrupt, as one already ending would. */
  interruptTakes = true
  /*
   * AMENDED for #237, step 5. Both acts became OPTIONAL on the handle when a
   * second held protocol arrived documenting neither — see HeldSessionHandle
   * on why absent and `false` are different claims. Both default true, so
   * every existing assertion here is unchanged.
   */
  /** Set false to hand back a handle with no `interrupt` at all. */
  offersInterrupt = true
  /** Set false to hand back a handle with no `contextUsage` at all. */
  offersContextUsage = true
  /** Set false to make the stream refuse a send, as one already closing would (#245). */
  sendTakes = true
  /*
   * AMENDED for #96 (was: a handle carrying only close/send/interrupt). The
   * context reading is the one piece of telemetry no stream message carries,
   * so the port grew a PULL — `contextUsage()` — and the fake has to satisfy
   * it. No existing assertion changed.
   */
  /** Which sessions were asked for a context reading, in order. */
  readonly contextUsageAsks: number[] = []
  /** What the session answers a pull with; null is "it could not say". */
  contextUsageAnswer: HeldSessionContextUsage | null = { usedTokens: 41_237, maxTokens: 200_000 }
  /** Set true to make the pull hang, as a session that never answers would. */
  contextUsageHangs = false
  /*
   * AMENDED for #96's mutating slice (was: a handle carrying
   * close/send/interrupt/contextUsage). `setModel` and `setEffort` are
   * OPTIONAL capabilities of the engine behind a session, so the fake has to
   * be able to leave either one OFF — that absence is what a held session on
   * an engine with no such act looks like, and it is a case with its own
   * tests. No existing assertion changed.
   */
  /** Which models this session was asked to switch to, in order. */
  readonly modelsSet: string[] = []
  /** Which efforts this session was asked to switch to, in order. */
  readonly effortsSet: string[] = []
  /** Set false to leave `setModel` off the handle, as an engine without one has it. */
  offersSetModel = true
  /** Set false to leave `setEffort` off the handle, on the same terms. */
  offersSetEffort = true
  /** Set false to make the session refuse a tuning change, as a closing one would. */
  tuningTakes = true
  /** Set true to make a tuning change hang, as a session that never answers would. */
  tuningHangs = false

  readonly start: HeldSessionPort = async (request) => {
    if (this.failWith !== undefined) throw this.failWith
    const index = this.started.length
    this.started.push(request)
    return {
      close: () => this.closed.push(index),
      send: (text: string) => {
        if (!this.sendTakes) return false
        this.sent.push(text)
        return true
      },
      ...(this.offersInterrupt
        ? {
            interrupt: async () => {
              this.interrupted.push(index)
              return this.interruptTakes
            }
          }
        : {}),
      ...(this.offersContextUsage
        ? {
            contextUsage: () => {
              this.contextUsageAsks.push(index)
              if (this.contextUsageHangs) return new Promise<never>(() => {})
              return Promise.resolve(this.contextUsageAnswer)
            }
          }
        : {}),
      ...(this.offersSetModel
        ? {
            setModel: (model: string) => {
              this.modelsSet.push(model)
              if (this.tuningHangs) return new Promise<never>(() => {})
              return Promise.resolve(this.tuningTakes)
            }
          }
        : {}),
      ...(this.offersSetEffort
        ? {
            setEffort: (effort: string) => {
              this.effortsSet.push(effort)
              if (this.tuningHangs) return new Promise<never>(() => {})
              return Promise.resolve(this.tuningTakes)
            }
          }
        : {})
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

  /** Any other tool reaching canUseTool (#203). Resolves when the host decides. */
  permission(
    index: number,
    toolUseId: string,
    overrides: Partial<HeldPermission> = {}
  ): Promise<HeldPermissionAnswer> {
    return this.started[index]!.onPermission({
      toolUseId,
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      title: 'Claude wants to run pnpm test',
      ...overrides
    })
  }

  end(index: number, reason = 'the turn finished'): void {
    this.started[index]!.onEnd(reason)
  }

  /** The CLI's own init/result fields, arriving off the message loop (issue #96). */
  reportTelemetry(index: number, update: HeldSessionTelemetryUpdate): void {
    this.started[index]!.onTelemetry(update)
  }

  /** One message the stream carried, as the loop reads it (#159). */
  reportMessage(
    index: number,
    role: 'user' | 'assistant',
    text: string,
    activity?: { kind: 'edit' | 'run' | 'read' | 'search'; target: string }
  ): void {
    this.started[index]!.onMessage(role, text, activity)
  }
}

function registryOver(port: FakePort, detector: CliDetector = installedDetector()) {
  return new HeldSessionRegistry({
    detector,
    // AMENDED for #237, step 5 (was: `start: port.start`). The port became a
    // table keyed by provider when a second engine arrived; every existing
    // assertion is unchanged, and this fake is still the only Claude engine.
    start: { claude: port.start },
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

/*
 * Issue #96, the read-only command surface. Context usage is the one thing
 * the held stream never reports: neither `init` nor `result` carries a
 * context breakdown, so it has to be PULLED off the session's own
 * `getContextUsage()` control request. The refresh policy the maintainer
 * settled on 2026-09-07 is what these pin — on demand (the mine opening) and
 * at the end of a turn, never on a poll, with a deadline and no retry storm.
 */
describe('HeldSessionRegistry context usage (#96)', () => {
  async function held(port: FakePort): Promise<HeldSessionRegistry> {
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    return registry
  }

  it('pulls a reading on demand and keeps it beside what the stream reported', async () => {
    const port = new FakePort()
    const registry = await held(port)
    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })

    await registry.refreshContextUsage('sess-1')

    expect(port.contextUsageAsks).toEqual([0])
    expect(registry.telemetryState('sess-1')).toEqual({
      held: true,
      model: 'claude-haiku-4-5',
      contextUsage: { usedTokens: 41_237, maxTokens: 200_000 }
    })
  })

  it('asks nothing at all for a session this panel does not hold', async () => {
    const port = new FakePort()
    const registry = await held(port)

    await registry.refreshContextUsage('sess-nobody')

    expect(port.contextUsageAsks).toEqual([])
  })

  it('pulls exactly once when a turn ends, which is the only thing that triggers one', async () => {
    // Never on a poll: the poll never reaches this registry for a reading, and
    // an `init` starting a turn is not a completed one either.
    const port = new FakePort()
    const registry = await held(port)

    port.reportTelemetry(0, { model: 'claude-haiku-4-5', turn: 'started' })
    expect(port.contextUsageAsks).toEqual([])

    port.reportTelemetry(0, { totalCostUsd: 0.01, turn: 'ended' })
    await registry.refreshContextUsage('sess-1')

    expect(port.contextUsageAsks).toEqual([0])
    expect(registry.telemetryState('sess-1').contextUsage).toEqual({
      usedTokens: 41_237,
      maxTokens: 200_000
    })
  })

  it('joins a pull already in flight rather than starting a second one', async () => {
    // The no-retry-storm half of the policy: a mine opened twice in a second,
    // or a turn ending while the last reading is still on its way, must not
    // put two control requests on the same stream.
    const port = new FakePort()
    const registry = await held(port)

    await Promise.all([
      registry.refreshContextUsage('sess-1'),
      registry.refreshContextUsage('sess-1')
    ])

    expect(port.contextUsageAsks).toEqual([0])
  })

  it('gives up on a pull the session never answers, leaving the last reading alone', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const registry = await held(port)
      await registry.refreshContextUsage('sess-1')

      port.contextUsageHangs = true
      const pull = registry.refreshContextUsage('sess-1')
      await vi.advanceTimersByTimeAsync(HELD_CONTEXT_USAGE_TIMEOUT_MS)
      await pull

      // The reading that DID arrive still stands: a deadline that reached
      // nothing says nothing about the last measurement taken.
      expect(registry.telemetryState('sess-1').contextUsage).toEqual({
        usedTokens: 41_237,
        maxTokens: 200_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a fresh pull after one timed out, rather than latching the session off', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const registry = await held(port)
      port.contextUsageHangs = true
      const timedOut = registry.refreshContextUsage('sess-1')
      await vi.advanceTimersByTimeAsync(HELD_CONTEXT_USAGE_TIMEOUT_MS)
      await timedOut

      port.contextUsageHangs = false
      port.contextUsageAnswer = { usedTokens: 9, maxTokens: 200_000 }
      await registry.refreshContextUsage('sess-1')

      expect(port.contextUsageAsks).toEqual([0, 0])
      expect(registry.telemetryState('sess-1').contextUsage).toEqual({
        usedTokens: 9,
        maxTokens: 200_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records nothing when the session answers that it could not say', async () => {
    const port = new FakePort()
    const registry = await held(port)
    port.contextUsageAnswer = null

    await registry.refreshContextUsage('sess-1')

    expect(registry.telemetryState('sess-1')).toEqual({ held: true })
  })

  it('discards the reading with the session, exactly as it discards the rest', async () => {
    const port = new FakePort()
    const registry = await held(port)
    await registry.refreshContextUsage('sess-1')

    port.end(0)

    expect(registry.telemetryState('sess-1')).toEqual({ held: false })
  })
})

/*
 * Issue #96's MUTATING slice. Changing a running session's model is one
 * control request on the stream this process already owns — ~2 ms, measured
 * live — and the thing that makes it safe to offer is not the request but its
 * VERIFICATION: the session's own next context reading names the model the CLI
 * believes is in force, so the change is proved without spending a paid turn.
 *
 * Effort is the other half and it is deliberately weaker. `applyFlagSettings`
 * resolves cleanly on a model that supports no effort and silently does
 * nothing, so nothing about accepting the request proves anything; the only
 * confirmation is the next `init` re-announcing the session's own effort, and
 * until that arrives the panel says "requested".
 */
describe('HeldSessionRegistry tuning (#96)', () => {
  async function held(port: FakePort): Promise<HeldSessionRegistry> {
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })
    return registry
  }

  it('forwards a model change to the session and re-pulls the reading that proves it', async () => {
    const port = new FakePort()
    const registry = await held(port)
    // What the session will report once it has switched: the SDK's context
    // response carries the model beside the counts, which is the whole route.
    port.contextUsageAnswer = {
      usedTokens: 41_237,
      maxTokens: 1_000_000,
      model: 'claude-sonnet-5'
    }

    const verdict = await registry.setTuning('sess-1', {
      kind: 'model',
      model: 'claude-sonnet-5'
    })

    expect(verdict).toEqual({ applied: true })
    expect(port.modelsSet).toEqual(['claude-sonnet-5'])
    // Not a second poll and not a turn: the pull is the confirmation.
    expect(port.contextUsageAsks).toEqual([0])
    expect(registry.telemetryState('sess-1').model).toBe('claude-sonnet-5')
    // Confirmed, so nothing is left pending for the strip to hedge about.
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('changes the model on an engine with no context reading, and waits for the next init', async () => {
    /*
     * The combination #237 step 5 made possible: `setModel` present,
     * `contextUsage` absent. The two capabilities are independent, so this is
     * a real handle shape rather than a gap.
     *
     * The change is MADE. Refusing an act this engine can perform, because a
     * second act it never claimed is missing, would be the panel inventing a
     * limitation the session does not have. What is missing is only the
     * cheap witness — so the request stands as pending, no reading is pulled
     * (there is none to pull), and the next `init` naming the model is what
     * clears it. Exactly the shape effort already has, for the same reason.
     */
    const port = new FakePort()
    port.offersContextUsage = false
    const registry = await held(port)

    expect(await registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })).toEqual(
      { applied: true }
    )

    expect(port.modelsSet).toEqual(['claude-sonnet-5'])
    expect(port.contextUsageAsks).toEqual([])
    // Pending, and honestly so: nothing has confirmed it yet.
    expect(registry.telemetryState('sess-1').model).toBe('claude-haiku-4-5')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true, pendingModel: 'claude-sonnet-5' }
    })

    port.reportTelemetry(0, { model: 'claude-sonnet-5', turn: 'started' })

    expect(registry.telemetryState('sess-1').model).toBe('claude-sonnet-5')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('verifies against a reading started AFTER the change, never one already on the wire', async () => {
    /*
     * The trap this closes. A pull already in flight was started BEFORE the
     * model changed, so its answer cannot speak to the change — and
     * `refreshContextUsage` deliberately JOINS a pull rather than stacking a
     * second request on the same stream (the no-retry-storm rule). Joining
     * one here would leave the change unverified until some later trigger
     * happened to fire, and the strip stuck on "pending" for a change that had
     * already taken effect.
     *
     * The fix is not a second concurrent request: it is waiting for the stale
     * one, then asking again.
     */
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const registry = await held(port)
      port.contextUsageHangs = true
      const stale = registry.refreshContextUsage('sess-1')

      port.contextUsageHangs = false
      port.contextUsageAnswer = { usedTokens: 1, maxTokens: 1_000_000, model: 'claude-sonnet-5' }
      const tuned = registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })
      await vi.advanceTimersByTimeAsync(HELD_CONTEXT_USAGE_TIMEOUT_MS)
      await stale

      expect(await tuned).toEqual({ applied: true })
      // Two asks: the stale one that could say nothing about the change, and
      // the fresh one that could.
      expect(port.contextUsageAsks).toEqual([0, 0])
      expect(registry.telemetryState('sess-1').model).toBe('claude-sonnet-5')
      expect(registry.tuningState('sess-1')).toEqual({
        held: true,
        tuning: { canSetModel: true, canSetEffort: true }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the model pending while the reading still names the old one', async () => {
    // The one case the whole verification rule exists for: the request was
    // accepted, and the session has not switched yet. Showing the new name
    // here would be this panel claiming a change on the strength of a request.
    const port = new FakePort()
    const registry = await held(port)
    port.contextUsageAnswer = {
      usedTokens: 100,
      maxTokens: 200_000,
      model: 'claude-haiku-4-5'
    }

    expect(await registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })).toEqual(
      { applied: true }
    )

    expect(registry.telemetryState('sess-1').model).toBe('claude-haiku-4-5')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true, pendingModel: 'claude-sonnet-5' }
    })
  })

  it('clears the pending model on a later reading that finally names it', async () => {
    const port = new FakePort()
    const registry = await held(port)
    port.contextUsageAnswer = { usedTokens: 100, maxTokens: 200_000, model: 'claude-haiku-4-5' }
    await registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })

    port.contextUsageAnswer = { usedTokens: 120, maxTokens: 1_000_000, model: 'claude-sonnet-5' }
    await registry.refreshContextUsage('sess-1')

    expect(registry.telemetryState('sess-1').model).toBe('claude-sonnet-5')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('clears the pending model on the next init naming it, not only on a reading', async () => {
    // `init` is re-emitted at the start of every turn and carries the model
    // too. It is the same CLI saying the same thing, so it confirms as well.
    const port = new FakePort()
    const registry = await held(port)
    port.contextUsageAnswer = { usedTokens: 100, maxTokens: 200_000, model: 'claude-haiku-4-5' }
    await registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })

    port.reportTelemetry(0, { model: 'claude-sonnet-5', turn: 'started' })

    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('refuses a model change on a session whose engine has no such act', async () => {
    // The handle simply has no `setModel`, which is how an engine with no
    // mid-run model change declares itself. Nothing is attempted and nothing
    // is left pending: the strip disables the control and states the reason.
    const port = new FakePort()
    port.offersSetModel = false
    const registry = await held(port)

    const verdict = await registry.setTuning('sess-1', {
      kind: 'model',
      model: 'claude-sonnet-5'
    })

    expect(verdict).toEqual({ applied: false, reason: TUNING_UNSUPPORTED })
    expect(port.contextUsageAsks).toEqual([])
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: false, canSetEffort: true }
    })
  })

  it('refuses a change the stream would not take, leaving the old value showing', async () => {
    const port = new FakePort()
    port.tuningTakes = false
    const registry = await held(port)

    const verdict = await registry.setTuning('sess-1', {
      kind: 'model',
      model: 'claude-sonnet-5'
    })

    expect(verdict).toEqual({ applied: false, reason: TUNING_REFUSED })
    expect(registry.telemetryState('sess-1').model).toBe('claude-haiku-4-5')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('gives up on a change the session never accepts, and never retries it', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      port.tuningHangs = true
      const registry = await held(port)

      const pending = registry.setTuning('sess-1', { kind: 'model', model: 'claude-sonnet-5' })
      await vi.advanceTimersByTimeAsync(HELD_TUNING_TIMEOUT_MS)

      expect(await pending).toEqual({ applied: false, reason: TUNING_TIMED_OUT })
      // One request, and no reading pulled for a change nothing accepted.
      expect(port.modelsSet).toEqual(['claude-sonnet-5'])
      expect(port.contextUsageAsks).toEqual([])
      expect(registry.tuningState('sess-1')).toEqual({
        held: true,
        tuning: { canSetModel: true, canSetEffort: true }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a change for a session this panel does not hold, in its own words', async () => {
    const port = new FakePort()
    const registry = await held(port)

    expect(
      await registry.setTuning('sess-nobody', { kind: 'model', model: 'claude-sonnet-5' })
    ).toEqual({ applied: false, reason: TUNING_NOT_HELD })
    expect(port.modelsSet).toEqual([])
  })

  it('reports not-held for a session this panel does not hold', () => {
    const registry = registryOver(new FakePort())
    expect(registry.tuningState('sess-nobody')).toEqual({ held: false })
  })

  it('forwards an effort change and pulls NO reading, because none can confirm it', async () => {
    // A context reading names a model and says nothing at all about effort, so
    // pulling one here would be a control request that could not answer the
    // question it was made for.
    const port = new FakePort()
    const registry = await held(port)

    const verdict = await registry.setTuning('sess-1', { kind: 'effort', effort: 'high' })

    expect(verdict).toEqual({ applied: true })
    expect(port.effortsSet).toEqual(['high'])
    expect(port.contextUsageAsks).toEqual([])
    // "Requested", not "set": nothing has echoed it back yet.
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true, pendingEffort: 'high' }
    })
  })

  it("clears a requested effort once an init re-announces the session's own", async () => {
    const port = new FakePort()
    const registry = await held(port)
    await registry.setTuning('sess-1', { kind: 'effort', effort: 'high' })

    port.reportTelemetry(0, { model: 'claude-haiku-4-5', effort: 'high', turn: 'started' })

    expect(registry.telemetryState('sess-1').effort).toBe('high')
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true }
    })
  })

  it('keeps an effort requested when the next init announces a different one', async () => {
    // The honest reading of a setting the CLI accepted and then did not adopt.
    const port = new FakePort()
    const registry = await held(port)
    await registry.setTuning('sess-1', { kind: 'effort', effort: 'high' })

    port.reportTelemetry(0, { model: 'claude-haiku-4-5', effort: 'low', turn: 'started' })

    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: true, pendingEffort: 'high' }
    })
  })

  it('refuses an effort change on a session whose engine has no such act', async () => {
    const port = new FakePort()
    port.offersSetEffort = false
    const registry = await held(port)

    expect(await registry.setTuning('sess-1', { kind: 'effort', effort: 'high' })).toEqual({
      applied: false,
      reason: TUNING_UNSUPPORTED
    })
    expect(registry.tuningState('sess-1')).toEqual({
      held: true,
      tuning: { canSetModel: true, canSetEffort: false }
    })
  })

  it('discards a pending change with the session, exactly as it discards the rest', async () => {
    const port = new FakePort()
    const registry = await held(port)
    await registry.setTuning('sess-1', { kind: 'effort', effort: 'high' })

    port.end(0)

    expect(registry.tuningState('sess-1')).toEqual({ held: false })
  })
})

/*
 * Issue #245. A held session's registry entry never carries a `status`, so
 * the Claude provider read it as idle and every held dwarf drew `waiting`
 * whatever it was actually doing, with no `waitingReason` for an open ask or
 * permission prompt either. `activityState` is the fact `stampHeldStatus`
 * stamps onto the foreman, and these pin the table the issue lays out.
 */
describe('HeldSessionRegistry activity (#245)', () => {
  it('reports not-held for a session this panel does not hold, so the provider stands', () => {
    const registry = registryOver(new FakePort())
    expect(registry.activityState('sess-nobody')).toEqual({ held: false })
  })

  it('reads working from the moment the session is named, before any result', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })

    // Named or not, the launch prompt already started the first turn.
    expect(registry.activityState('sess-1')).toEqual({ held: false })
    port.reportSessionId(0, 'sess-1')
    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'working' })
  })

  it("reads waiting once the turn's result arrives, with no reason", async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.reportTelemetry(0, { totalCostUsd: 0.01, turn: 'ended' })

    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'waiting' })
  })

  it('reads working again once a next turn starts, whether by init or by a sent message', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { turn: 'ended' })
    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'waiting' })

    // An init re-emitted at the start of the next turn.
    port.reportTelemetry(0, { model: 'claude-haiku-4-5', turn: 'started' })
    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'working' })

    // And, independently, a message the panel itself sent.
    port.reportTelemetry(0, { turn: 'ended' })
    registry.sendText('sess-1', 'keep going')
    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'working' })
  })

  it('never starts a turn for a send the stream refused', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { turn: 'ended' })
    port.sendTakes = false

    expect(registry.sendText('sess-1', 'keep going')).toBe(false)
    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'waiting' })
  })

  it('reads user-input while an ask is open, whatever the turn state', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    void port.ask(0, 'toolu_01')
    await Promise.resolve()

    expect(registry.activityState('sess-1')).toEqual({
      held: true,
      status: 'waiting',
      waitingReason: 'user-input'
    })
  })

  it('reads approval while a permission prompt is open', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    void port.permission(0, 'toolu_p1')
    await Promise.resolve()

    expect(registry.activityState('sess-1')).toEqual({
      held: true,
      status: 'waiting',
      waitingReason: 'approval'
    })
  })

  it('reads user-input over approval when both an ask and a permission prompt are open', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    void port.permission(0, 'toolu_p1')
    void port.ask(0, 'toolu_01')
    await Promise.resolve()

    expect(registry.activityState('sess-1')).toMatchObject({ waitingReason: 'user-input' })
  })

  it('reads plain waiting again once every open ask and permission is settled', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { turn: 'ended' })

    void port.ask(0, 'toolu_01')
    await Promise.resolve()
    registry.answer({
      sessionId: 'sess-1',
      toolUseId: 'toolu_01',
      answers: { 'Which colour?': 'Green' }
    })

    expect(registry.activityState('sess-1')).toEqual({ held: true, status: 'waiting' })
  })

  it('reports not-held once the session ends, dissolved exactly as its telemetry is', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    port.end(0)

    expect(registry.activityState('sess-1')).toEqual({ held: false })
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

  it('interrupts the turn on a session it holds, and refuses one it does not (#210)', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    // AMENDED for #237, step 5 (was: `.toBe(true)` / `.toBe(false)`). The
    // boolean became a named verdict when a second held protocol arrived with
    // no cancellation in it at all — 'unsupported' and 'refused' are different
    // facts and the panel says different things about them. Nothing about what
    // this test proves has moved: the turn is cut on a session held, and an
    // interrupt aimed at one that is not reaches no stream.
    await expect(registry.interrupt('sess-1')).resolves.toBe('interrupted')
    expect(port.interrupted).toEqual([0])

    await expect(registry.interrupt('sess-nobody')).resolves.toBe('not-held')
    // Refused, never attempted against whatever else is held: an interrupt
    // aimed at a session this panel does not hold has no stream to reach.
    expect(port.interrupted).toEqual([0])
    // And the session it does hold is still held — an interrupt ends the turn,
    // not the session, which is the whole distinction from close (#210).
    expect(port.closed).toEqual([])
    expect(registry.count()).toBe(1)
  })

  it('reports an interrupt the stream would not take, instead of claiming one (#210)', async () => {
    const port = new FakePort()
    port.interruptTakes = false
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    // AMENDED for #237, step 5 (was: `.toBe(false)`). A stream that HAS an
    // interrupt and would not take it is 'refused' — see the verdict's own doc
    // comment on why that is not the same answer as a protocol without one.
    await expect(registry.interrupt('sess-1')).resolves.toBe('refused')
    expect(port.interrupted).toEqual([0])
  })

  /*
   * Issue #237, step 5. The other half of that verdict, and the acceptance
   * gate this registry is responsible for: a held session whose protocol
   * documents no cancellation offers no `interrupt` on its handle at all, and
   * the answer must name that rather than borrowing the sentence for a stream
   * that tried and failed.
   */
  it('says a protocol has no interrupt, rather than that one was refused', async () => {
    const port = new FakePort()
    port.offersInterrupt = false
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    await expect(registry.interrupt('sess-1')).resolves.toBe('unsupported')
    // Nothing was attempted, which is the point: there was nothing to attempt.
    expect(port.interrupted).toEqual([])
    expect(registry.count()).toBe(1)
  })

  /*
   * The same absence on the pull side (#237, step 5). A context reading is
   * asked for on a schedule the runtime owns, so a session whose protocol
   * exposes none must be a silent no-op rather than a timeout every mine
   * opening pays for.
   */
  it('asks no context reading of a protocol that exposes none', async () => {
    const port = new FakePort()
    port.offersContextUsage = false
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    await registry.refreshContextUsage('sess-1')
    expect(port.contextUsageAsks).toEqual([])
    expect(registry.telemetryState('sess-1').contextUsage).toBeUndefined()
  })

  /*
   * Issue #237, step 5. One provider's own store cannot say which folder a
   * held conversation belongs to — an Antigravity stream-json conversation
   * writes no `history.jsonl` record at all — so the registry answers with the
   * folder it started the session in. First-hand, and only ever for a session
   * this panel is actually holding.
   */
  it('names the folder a held session was started in, and nothing for one it does not hold', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')

    expect(registry.heldWorkspace('sess-1')).toBe(MINE)
    expect(registry.heldWorkspace('sess-nobody')).toBeUndefined()
  })

  /*
   * Issue #237, step 5. `HELDABLE_PROVIDERS` says a provider MAY be held; the
   * engine table says which implementation answers when it is. A name in the
   * list with no engine is refused by name — never started under whichever
   * engine happened to be composed, which is the substitution #168 removed.
   */
  it('refuses a heldable provider with no engine behind it, and starts nothing', async () => {
    const port = new FakePort()
    const registry = new HeldSessionRegistry({
      detector: installedDetector(),
      // Claude is heldable and has no row here.
      start: {},
      now: () => 1_700_000_000_000,
      log: () => {}
    })

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig'
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('claude')
    expect(port.started).toHaveLength(0)
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

  it('carries a tool-call line through with its activity, same as a spoken message (#240)', async () => {
    const port = new FakePort()
    const registry = registryOver(port)
    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')

    port.reportMessage(0, 'assistant', 'Ran pnpm test', { kind: 'run', target: 'pnpm test' })

    const state = registry.conversationState('sess-1')
    expect(state.held ? state.conversation.at(-1) : undefined).toEqual({
      role: 'assistant',
      text: 'Ran pnpm test',
      timestamp: AT,
      activity: { kind: 'run', target: 'pnpm test' }
    })
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

/*
 * Issue #203. Before this, canUseTool answered every tool but AskUserQuestion
 * with an immediate refusal, so a session launched from the panel could read
 * and write nothing. A permission prompt is now parked exactly as an ask is:
 * the blocked call waits on the panel, and only the panel (or the session's
 * own end) releases it.
 */
describe('HeldSessionRegistry permissions (#203)', () => {
  async function launched(port: FakePort) {
    const registry = registryOver(port)
    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    port.reportSessionId(0, 'sess-1')
    return registry
  }

  it("makes an arriving prompt the held session's pending permission, stamped with this host's clock", async () => {
    const port = new FakePort()
    const registry = await launched(port)

    void port.permission(0, 'toolu_p1')
    await Promise.resolve()

    expect(registry.questionState('sess-1')).toEqual({
      held: true,
      permission: {
        toolUseId: 'toolu_p1',
        toolName: 'Bash',
        title: 'Claude wants to run pnpm test',
        input: 'pnpm test',
        channel: 'held',
        askedAt: '2023-11-14T22:13:20.000Z'
      }
    })
  })

  it('releases the blocked call with allow when the panel allows it', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    const asked = port.permission(0, 'toolu_p1')
    await Promise.resolve()

    expect(
      registry.decidePermission({ sessionId: 'sess-1', toolUseId: 'toolu_p1', decision: 'allow' })
    ).toEqual({ answered: true })
    await expect(asked).resolves.toEqual({ decision: 'allow' })
    expect(registry.questionState('sess-1')).toEqual({ held: true })
  })

  it('releases it with deny and a stated reason when the panel denies it', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    const asked = port.permission(0, 'toolu_p1')
    await Promise.resolve()

    expect(
      registry.decidePermission({ sessionId: 'sess-1', toolUseId: 'toolu_p1', decision: 'deny' })
    ).toEqual({ answered: true })
    const answer = await asked
    expect(answer.decision).toBe('deny')
    expect(answer.decision === 'deny' ? answer.reason : '').toContain('panel')
  })

  it('refuses a decision for a session this panel is not holding', () => {
    const registry = registryOver(new FakePort())
    const result = registry.decidePermission({
      sessionId: 'sess-nobody',
      toolUseId: 'toolu_p1',
      decision: 'allow'
    })
    expect(result.answered).toBe(false)
    expect(result.error).not.toBeUndefined()
  })

  it('refuses a decision naming a prompt that is no longer open, and leaves the call blocked', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    let settled = false
    void port.permission(0, 'toolu_p1').then(() => {
      settled = true
    })
    await Promise.resolve()

    const result = registry.decidePermission({
      sessionId: 'sess-1',
      toolUseId: 'toolu_gone',
      decision: 'allow'
    })
    await Promise.resolve()

    expect(result.answered).toBe(false)
    expect(settled).toBe(false)
    expect(registry.questionState('sess-1')).toMatchObject({
      permission: { toolUseId: 'toolu_p1' }
    })
  })

  it('never lets a decision about a permission release an ask, however the ids line up', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    let askSettled = false
    void port.ask(0, 'toolu_shared').then(() => {
      askSettled = true
    })
    await Promise.resolve()

    const result = registry.decidePermission({
      sessionId: 'sess-1',
      toolUseId: 'toolu_shared',
      decision: 'allow'
    })
    await Promise.resolve()
    expect(result.answered).toBe(false)
    expect(askSettled).toBe(false)
  })

  it('shows the latest of two open prompts, and decides either by its own id', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    const first = port.permission(0, 'toolu_first')
    void port.permission(0, 'toolu_second', { toolName: 'Edit', input: { file_path: 'a.ts' } })
    await Promise.resolve()
    expect(registry.questionState('sess-1')).toMatchObject({
      permission: { toolUseId: 'toolu_second', toolName: 'Edit' }
    })

    registry.decidePermission({ sessionId: 'sess-1', toolUseId: 'toolu_first', decision: 'deny' })
    expect((await first).decision).toBe('deny')
    expect(registry.questionState('sess-1')).toMatchObject({
      permission: { toolUseId: 'toolu_second' }
    })
  })

  it('reports an open ask and an open permission side by side', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    void port.ask(0, 'toolu_ask')
    void port.permission(0, 'toolu_perm')
    await Promise.resolve()

    expect(registry.questionState('sess-1')).toMatchObject({
      held: true,
      question: { toolUseId: 'toolu_ask' },
      permission: { toolUseId: 'toolu_perm' }
    })
  })

  it('dissolves an open prompt as a denial when the session ends, never as an approval', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    const asked = port.permission(0, 'toolu_p1')
    await Promise.resolve()

    port.end(0)

    const answer = await asked
    expect(answer.decision).toBe('deny')
    expect(registry.questionState('sess-1')).toEqual({ held: false })
  })

  it('dissolves every open prompt on shutdown', async () => {
    const port = new FakePort()
    const registry = await launched(port)
    const asked = port.permission(0, 'toolu_p1')
    await Promise.resolve()

    registry.closeAll()

    expect((await asked).decision).toBe('deny')
    expect(registry.count()).toBe(0)
  })
})

describe('a held launch that names a model and an effort (#239)', () => {
  /**
   * The registry's own configured model, which is what every held session ran
   * on before this issue. It is deliberately kept: a request that names no
   * model still gets it.
   */
  function tunedRegistry(port: FakePort, options: { model?: string } = {}) {
    return new HeldSessionRegistry({
      detector: installedDetector(),
      // AMENDED for #237, step 5 (was: `start: port.start`). The port became a
      // table keyed by provider when a second engine arrived; every existing
      // assertion is unchanged, and this fake is still the only Claude engine.
      start: { claude: port.start },
      now: () => 1_700_000_000_000,
      log: () => {},
      ...(options.model === undefined ? {} : { model: options.model })
    })
  }

  it('forwards a model the request named, over the registry’s configured one', async () => {
    // The change #239 made here: the model used to belong to the REGISTRY, so
    // every session it would ever start ran the same one and the Add Panel had
    // no way to say anything about the session it was starting.
    const port = new FakePort()
    const registry = tunedRegistry(port, { model: 'claude-haiku-4-5' })

    expect(
      await registry.launch({
        mineId: 'mine-1',
        provider: 'claude',
        minePath: MINE,
        prompt: 'dig',
        model: 'sonnet'
      })
    ).toEqual({ launched: true })
    expect(port.started[0]!.model).toBe('sonnet')
  })

  it('falls back to the configured model when the request names none', async () => {
    const port = new FakePort()
    const registry = tunedRegistry(port, { model: 'claude-haiku-4-5' })

    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    expect(port.started[0]!.model).toBe('claude-haiku-4-5')
  })

  it('leaves the model unset when neither the request nor the config names one', async () => {
    // Unset is an instruction, not a gap: it is what leaves the CLI on its own
    // default, which is what every untuned launch must keep doing.
    const port = new FakePort()
    const registry = tunedRegistry(port)

    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    expect(port.started[0]!.model).toBeUndefined()
    expect('model' in port.started[0]!).toBe(false)
  })

  it('forwards an effort the request named, and none when it named none', async () => {
    const port = new FakePort()
    const registry = tunedRegistry(port)

    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig',
      effort: 'xhigh'
    })
    expect(port.started[0]!.effort).toBe('xhigh')

    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    expect(port.started[1]!.effort).toBeUndefined()
    expect('effort' in port.started[1]!).toBe(false)
  })

  it('has no configured effort to fall back to, unlike the model', async () => {
    // Effort has never been a registry-level setting and does not become one:
    // there is nowhere for a stale default to live, so the only two answers
    // are the one this launch asked for and the CLI's own.
    const port = new FakePort()
    const registry = new HeldSessionRegistry({
      detector: installedDetector(),
      // AMENDED for #237, step 5 (was: `start: port.start`). The port became a
      // table keyed by provider when a second engine arrived; every existing
      // assertion is unchanged, and this fake is still the only Claude engine.
      start: { claude: port.start },
      now: () => 1_700_000_000_000,
      log: () => {},
      ...({ effort: 'low' } as object)
    })

    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    expect(port.started[0]!.effort).toBeUndefined()
  })

  it('refuses a provider it cannot hold before it reads any tuning', async () => {
    // The #168 refusal is unchanged and still comes first: a Codex chip is
    // answered by name, not by a Claude session tuned the way Codex was.
    const port = new FakePort()
    const registry = tunedRegistry(port)

    const result = await registry.launch({
      mineId: 'mine-1',
      provider: 'codex',
      minePath: MINE,
      prompt: 'dig',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('codex')
    expect(port.started).toHaveLength(0)
  })

  it('says nothing about the model in the verdict, and logs only the prompt’s length', async () => {
    const port = new FakePort()
    const logged: string[] = []
    const registry = new HeldSessionRegistry({
      detector: installedDetector(),
      // AMENDED for #237, step 5 (was: `start: port.start`). The port became a
      // table keyed by provider when a second engine arrived; every existing
      // assertion is unchanged, and this fake is still the only Claude engine.
      start: { claude: port.start },
      now: () => 1_700_000_000_000,
      log: (message) => logged.push(message)
    })

    expect(
      await registry.launch({
        mineId: 'mine-1',
        provider: 'claude',
        minePath: MINE,
        prompt: 'dig the east gallery',
        model: 'sonnet',
        effort: 'max'
      })
    ).toEqual({ launched: true })
    // What model a session runs is the CLI's to report, through `init` every
    // turn. Repeating our own request back would be a claim, not a reading.
    expect(logged.join(' ')).not.toContain('sonnet')
    expect(logged.join(' ')).not.toContain('dig the east gallery')
  })

  it('forwards a permission mode the request named, and none when it named none', async () => {
    const port = new FakePort()
    const registry = tunedRegistry(port)

    await registry.launch({
      mineId: 'mine-1',
      provider: 'claude',
      minePath: MINE,
      prompt: 'dig',
      permissionMode: 'plan'
    })
    expect(port.started[0]!.permissionMode).toBe('plan')

    await registry.launch({ mineId: 'mine-1', provider: 'claude', minePath: MINE, prompt: 'dig' })
    expect(port.started[1]!.permissionMode).toBeUndefined()
    expect('permissionMode' in port.started[1]!).toBe(false)
  })
})
