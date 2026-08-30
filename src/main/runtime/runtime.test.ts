import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import { SIMULATION_ENV_VAR, defaultConfig, defaultSimulationConfig } from '../config/config'
import type { PlatformAdapters } from '../platform/platformAdapters'
import { emptyLedger, type LedgerState } from '../domain/ledger'
import { emptyMaterialTotals } from '../domain/materials'
import type { FeedMessage } from '../domain/types'
import { nullLedgerStore } from '../ledger/ledgerStore'
import { MaterialLedger } from '../ledger/materialLedger'
import type { Provider } from '../providers/provider'
import type { TextDeliveryPort, TextDeliveryTarget } from '../textDelivery/port'
import { TierService, type TierThresholds } from '../tier/tierService'
import { AgentRuntime, expandHomePath } from './runtime'

function datePath(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}\\${month}\\${day}`
}

describe('expandHomePath', () => {
  const home = 'C:\\Users\\j'

  it.each([
    ['~', home],
    ['~/.claude', 'C:\\Users\\j\\.claude'],
    ['~\\.claude-work', 'C:\\Users\\j\\.claude-work'],
    ['C:\\custom\\claude', 'C:\\custom\\claude']
  ])('expands %s', (input, expected) => {
    expect(expandHomePath(input, home)).toBe(expected)
  })
})

describe('AgentRuntime activation', () => {
  const scan = vi.fn<Provider['scan']>().mockResolvedValue([
    {
      provider: 'claude',
      sessionId: 'session-1',
      cwd: 'C:\\work\\project',
      status: 'busy',
      updatedAt: 1,
      dwarfs: [
        {
          id: 'claude:session-1',
          provider: 'claude',
          role: 'worker',
          name: 'worker',
          status: 'working',
          sessionId: 'session-1',
          pid: 42
        }
      ]
    }
  ])

  function provider(feed: FeedMessage[] = []): Provider {
    return { kind: 'claude', scan, feed: vi.fn().mockResolvedValue(feed) }
  }

  it('focuses a known dwarf before consulting its transcript', async () => {
    const source = provider()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(true),
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: true,
      openedTerminal: false,
      feed: []
    })
    expect(source.feed).not.toHaveBeenCalled()
  })

  it('opens a terminal tailing the transcript when focus fails but a transcript path is known', async () => {
    const source: Provider = {
      kind: 'claude',
      scan,
      feed: vi.fn().mockResolvedValue([]),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: true,
      feed: []
    })
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
    expect(source.feed).not.toHaveBeenCalled()
  })

  it('falls back to the transcript feed when focus fails and no terminal could be opened', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
    const source: Provider = {
      kind: 'claude',
      scan,
      feed: vi.fn().mockResolvedValue(feed),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    const launchTerminal = vi.fn().mockResolvedValue(false)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
    expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
  })

  it('skips straight to the transcript feed when the provider exposes no transcript path', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
    const source = provider(feed)
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(launchTerminal).not.toHaveBeenCalled()
    expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
  })
})

describe('AgentRuntime dwarf lifecycle wiring', () => {
  it('keeps a disappeared dwarf visible as leaving, then drops it after dwarfLeaveGraceS', async () => {
    let now = 0
    const workingDwarf = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1'
    }
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [workingDwarf]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [{ kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }],
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([workingDwarf])

    now = 1_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([
      { id: 'claude:session-1', status: 'leaving' }
    ])

    now = 21_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([])
  })

  /**
   * Issue #46: a kick the panel WATCHED stop its agent retires the dwarf. The
   * provider is not the one that noticed, so it keeps reporting the session —
   * which is exactly why the decision has to survive the next poll.
   */
  it('walks a retired dwarf out even while the provider still reports it working', async () => {
    let now = 0
    const workingDwarf = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1'
    }
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [workingDwarf]
      }
    ])
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [{ kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }],
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([workingDwarf])

    now = 1_000
    runtime.retireDwarf('claude:session-1')
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([
      { id: 'claude:session-1', status: 'leaving' }
    ])

    now = 21_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([])

    // Sticky: the provider still has not noticed, and the dwarf must not
    // flicker back onto the rock.
    now = 41_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([])
  })

  it('leaves the other dwarfs of a retired dwarf-s mine alone', async () => {
    let now = 0
    const kicked = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1'
    }
    const spared = { ...kicked, id: 'claude:session-1:2', name: 'mate' }
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [kicked, spared]
      }
    ])
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [{ kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }],
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    runtime.retireDwarf('claude:session-1')
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs).toContainEqual(spared)
  })
})

/**
 * R3-leaving-dwarf-activation: a 'leaving' dwarf's agent has already
 * finished/disappeared, so its retained pid is stale (or, worst case, reused
 * by an unrelated process) — attempting to focus it serves no purpose and
 * risks focusing the wrong window. The terminal/feed fallbacks still read
 * from disk, so they should still work for as long as the dwarf stays in its
 * grace period.
 */
describe('AgentRuntime activation for a leaving dwarf', () => {
  function leavingScan() {
    const workingDwarf = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1',
      pid: 42
    }
    return vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [workingDwarf]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
  }

  it('skips focusing a leaving dwarf and opens a terminal tailing its transcript instead', async () => {
    const focus = vi.fn().mockResolvedValue(true)
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const source: Provider = {
      kind: 'claude',
      scan: leavingScan(),
      feed: vi.fn().mockResolvedValue([]),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [source],
      focus,
      launchTerminal,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh() // dwarf is 'working'
    now = 1_000
    await runtime.refresh() // the agent disappeared -> dwarf is now 'leaving'
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([{ status: 'leaving', pid: 42 }])

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: true,
      feed: []
    })
    expect(focus).not.toHaveBeenCalled()
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
  })

  it('falls all the way back to the transcript feed for a leaving dwarf when no terminal can be opened', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Final message', timestamp: 'now' }]
    const focus = vi.fn().mockResolvedValue(true)
    const launchTerminal = vi.fn().mockResolvedValue(false)
    const source: Provider = {
      kind: 'claude',
      scan: leavingScan(),
      feed: vi.fn().mockResolvedValue(feed),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [source],
      focus,
      launchTerminal,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([{ status: 'leaving' }])

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime.sendDwarfText', () => {
  const FOREMAN_ID = 'claude:session-1'
  const WORKER_ID = 'claude:session-1:agent-9'

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          },
          {
            id: WORKER_ID,
            provider: 'claude',
            role: 'worker',
            name: 'Explorer',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    } satisfies TextDeliveryPort
  }

  async function runtimeWith(
    targets: Record<string, TextDeliveryTarget>,
    port: TextDeliveryPort = fakePort()
  ) {
    const source: Provider = {
      kind: 'claude',
      scan: crewScan(),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) => targets[dwarfId] ?? null
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, port }
  }

  it('types the message into the console of a terminal-hosted dwarf', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.sendToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('relays the message to a headless session by name', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'status?', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'status?'
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it("routes a worker's message to its foreman under an explicit prefix", async () => {
    const { runtime, port } = await runtimeWith({
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' },
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: WORKER_ID, text: 'stop digging', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'foreman-relay' })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: '[for agent Explorer] stop digging'
    })
  })

  it('refuses a dwarf that is no longer on the floor', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.sendDwarfText({
      dwarfId: 'claude:ghost',
      text: 'hello',
      pressEnter: true
    })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('refuses a dwarf whose session type has no input channel', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'hello',
      pressEnter: true
    })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses an empty message instead of waking the agent for nothing', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })
    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: '   \n  ',
      pressEnter: true
    })
    expect(result.delivered).toBe(false)
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('trims the message to the 4000-character limit', async () => {
    const port = fakePort()
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)
    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'x'.repeat(5_000),
      pressEnter: false
    })
    expect(port.sendToConsole.mock.calls[0]?.[0].text).toHaveLength(4_000)
  })

  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
  })

  it('falls back to the relay when the console fails and the session has a name', async () => {
    const port = {
      sendToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    // The verdict names the channel that actually delivered, not the one that
    // was tried first, so the panel's ✓ stays honest about the fallback.
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.sendToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'run the tests'
    })
  })

  it('never touches the relay while the console delivery succeeds', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    // The relay is slower than keystrokes (a one-shot claude turn), so it is
    // strictly the fallback, never a parallel or default attempt.
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('combines both reasons, terminal first, when the relay fallback also fails', async () => {
    const port = {
      sendToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' }),
      relayToClaudeSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The relay timed out.' }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'Terminal: The terminal would not come forward.\nRelay fallback: The relay timed out.'
    })
  })

  it('never falls back for a terminal session that has no relay address', async () => {
    const port = {
      sendToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('keeps the message text out of the log on the fallback path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: false, error: 'still no' }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'my-secret-payload',
      pressEnter: false
    })
    const written = [...warn.mock.calls, ...log.mock.calls].flat().join(' ')
    expect(written).not.toContain('my-secret-payload')
    warn.mockRestore()
    log.mockRestore()
  })

  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn().mockRejectedValue(new Error('boom')),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('refuses a leaving dwarf, whose retained pid and session are already stale', async () => {
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: FOREMAN_ID,
              provider: 'claude',
              role: 'foreman',
              name: 'boss',
              status: 'working',
              sessionId: 'session-1',
              pid: 42
            }
          ]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const port = fakePort()
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [
        {
          kind: 'claude',
          scan,
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: () => ({ kind: 'terminal', pid: 42 })
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()

    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'hi',
      pressEnter: false
    })
    expect(result.delivered).toBe(false)
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('never writes the message content to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'my-secret-payload',
      pressEnter: false
    })
    const written = [...warn.mock.calls, ...log.mock.calls].flat().join(' ')
    expect(written).not.toContain('my-secret-payload')
    warn.mockRestore()
    log.mockRestore()
  })

  it('publishes the delivery channel on every dwarf so the panel can render it', async () => {
    const { runtime } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 },
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' }
    })
    const dwarfs = runtime.getMines()[0]!.dwarfs
    expect(dwarfs.find((dwarf) => dwarf.id === FOREMAN_ID)?.textDelivery).toBe('terminal')
    expect(dwarfs.find((dwarf) => dwarf.id === WORKER_ID)?.textDelivery).toBe('foreman-relay')
  })

  it('leaves a dwarf with no channel unmarked', async () => {
    const { runtime } = await runtimeWith({})
    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBeUndefined()
  })

  it('withholds the terminal channel where the platform cannot type into a console', async () => {
    // The session offers a console; this operating system cannot reach it
    // (Linux always, macOS until its osascript path is verified). The panel
    // must show the honest disabled button rather than a Send that types
    // nowhere, so the channel is never published at all.
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBeUndefined()
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false, via: 'none' })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('degrades a named terminal target to its relay where console input is unavailable', async () => {
    // An interactive session with a registry name is still name-addressable on
    // a platform that cannot type into consoles, so Send/Kick must stay
    // enabled — advertised and delivered as the relay, not disabled (issue #24).
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBe('claude-relay')
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'hi'
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('keeps the relay channel where console input is unavailable', async () => {
    // The relay spawns a CLI rather than talking to a window server, so it is
    // the tier that survives on every platform.
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' } },
      port
    )

    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBe('claude-relay')
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
  })
})

describe('AgentRuntime.kickDwarf', () => {
  const FOREMAN_ID = 'claude:session-1'
  const WORKER_ID = 'claude:session-1:agent-9'

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          },
          {
            id: WORKER_ID,
            provider: 'claude',
            role: 'worker',
            name: 'Explorer',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    } satisfies TextDeliveryPort
  }

  async function runtimeWith(
    targets: Record<string, TextDeliveryTarget>,
    port: TextDeliveryPort = fakePort()
  ) {
    const source: Provider = {
      kind: 'claude',
      scan: crewScan(),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) => targets[dwarfId] ?? null
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, port }
  }

  it('sends a raw interrupt keystroke to a terminal-hosted dwarf, never typed text', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'terminal'
    })
    expect(port.sendInterrupt).toHaveBeenCalledWith({ pid: 42 })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('relays the exact fixed cancel instruction to a headless session by name', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' }
    })

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it("routes a worker's kick to its foreman under the exact '[cancel agent X]' prefix", async () => {
    const { runtime, port } = await runtimeWith({
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' },
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' }
    })

    await expect(runtime.kickDwarf({ dwarfId: WORKER_ID })).resolves.toEqual({
      delivered: true,
      via: 'foreman-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: '[cancel agent Explorer] Stop that agent now. Interrupt its work, leave things in a safe state, and wait for further instructions.'
    })
  })

  it('refuses a dwarf that is no longer on the floor', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.kickDwarf({ dwarfId: 'claude:ghost' })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses a dwarf whose session type has no cancel channel (Codex, all shapes)', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('refuses a leaving dwarf, whose retained pid and session are already stale', async () => {
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: FOREMAN_ID,
              provider: 'claude',
              role: 'foreman',
              name: 'boss',
              status: 'working',
              sessionId: 'session-1',
              pid: 42
            }
          ]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const port = fakePort()
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [
        {
          kind: 'claude',
          scan,
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: () => ({ kind: 'terminal', pid: 42 })
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()

    const result = await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    expect(result.delivered).toBe(false)
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
  })

  it('falls back to the relay cancel instruction when the interrupt fails and the session has a name', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.sendInterrupt).toHaveBeenCalledWith({ pid: 42 })
    // The fallback carries the exact instruction the relay tier already uses —
    // a kick has no user text, only this fixed message.
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
  })

  it("prefixes the worker's cancel tag on the fallback, same as the relay tier", async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      {
        [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' },
        [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }
      },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: WORKER_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: '[cancel agent Explorer] Stop that agent now. Interrupt its work, leave things in a safe state, and wait for further instructions.'
    })
  })

  it('combines both reasons, terminal first, when the relay fallback also fails', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The relay timed out.' }),
      sendInterrupt: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'Terminal: The terminal would not come forward.\nRelay fallback: The relay timed out.'
    })
  })

  it('never falls back for a terminal session that has no relay address', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('kicks over the relay where console input is unavailable and the session has a name', async () => {
    // Same degrade as sendDwarfText: a named interactive session on a platform
    // with no console input keeps a working Kick through its relay address.
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn().mockRejectedValue(new Error('boom'))
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toMatchObject({
      delivered: false
    })
  })
})

describe('AgentRuntime provider wiring', () => {
  /**
   * R3-wiring-test-real-clock: this test builds a real (non-injected)
   * CodexProvider, which resolves "today" from Date.now() internally — using
   * the real clock here too was a flaky risk (a day-boundary tick between
   * computing fiveDaysAgo and the provider's own scan could shift which day
   * directory each side means). A fake clock keeps both sides reading the
   * exact same "now".
   */
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 7, 29, 12, 0, 0) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds the real CodexProvider from config.codexSessionsRoot (expanded) and config.codexScanDays', async () => {
    const home = 'C:\\Users\\j'
    const fake = new FakeFs()
    // 5 days back: only visible if codexScanDays (default 7) actually reaches
    // that day directory, proving both codexSessionsRoot and codexScanDays
    // are wired from config into the real CodexProvider (not just a fixed
    // path or a hardcoded today/yesterday scan).
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000)
    fake.addFile(
      `${home}\\.codex\\sessions\\${datePath(fiveDaysAgo)}\\rollout-wiring-check.jsonl`,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'wiring-session', cwd: 'C:\\Users\\j\\Desktop\\Wiring-Project' }
      }) + '\n',
      Date.now() - 5_000
    )

    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home,
      fs: fake,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    expect(runtime.getMines().map((mine) => mine.path)).toContain(
      'C:\\Users\\j\\Desktop\\Wiring-Project'
    )
  })
})

describe('AgentRuntime.nudge', () => {
  it('runs a scan out of band, without waiting for the poll interval', async () => {
    vi.useFakeTimers()
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([])
    const onMinesUpdated = vi.fn()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), pollIntervalMs: 60_000 },
      providers: [{ kind: 'claude', scan, feed: async () => null }],
      onMinesUpdated
    })
    try {
      runtime.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(onMinesUpdated).toHaveBeenCalledTimes(1)

      runtime.nudge()
      await vi.advanceTimersByTimeAsync(0)
      // The scan is what nudge() promises. This provider reports the same
      // empty world both times, so the publish gate (#25) holds the identical
      // second snapshot back rather than waking the panel to repaint nothing;
      // the test below covers a nudge that does find a change.
      expect(scan).toHaveBeenCalledTimes(2)
      expect(onMinesUpdated).toHaveBeenCalledTimes(1)
    } finally {
      runtime.stop()
      vi.useRealTimers()
    }
  })

  it('publishes as soon as an out-of-band scan finds something new', async () => {
    vi.useFakeTimers()
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([])
    const onMinesUpdated = vi.fn()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), pollIntervalMs: 60_000 },
      providers: [{ kind: 'claude', scan, feed: async () => null }],
      onMinesUpdated
    })
    try {
      runtime.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMinesUpdated).toHaveBeenCalledTimes(1)

      scan.mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\Users\\j\\Desktop\\Fresh-Project',
          status: 'busy',
          dwarfs: [
            {
              id: 'claude:session-1',
              provider: 'claude',
              role: 'foreman',
              name: 'fresh',
              status: 'working',
              sessionId: 'session-1'
            }
          ],
          updatedAt: 5_000
        }
      ])
      runtime.nudge()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMinesUpdated).toHaveBeenCalledTimes(2)
      expect(onMinesUpdated.mock.calls[1]?.[0]).toHaveLength(1)
    } finally {
      runtime.stop()
      vi.useRealTimers()
    }
  })

  it('stops republishing a world that has stopped changing', async () => {
    vi.useFakeTimers()
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([])
    const onMinesUpdated = vi.fn()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), pollIntervalMs: 2_000 },
      providers: [{ kind: 'claude', scan, feed: async () => null }],
      onMinesUpdated
    })
    try {
      runtime.start()
      await vi.advanceTimersByTimeAsync(10_000)
      // Six polls of an unchanged world cost exactly one push.
      expect(scan.mock.calls.length).toBeGreaterThanOrEqual(5)
      expect(onMinesUpdated).toHaveBeenCalledTimes(1)
    } finally {
      runtime.stop()
      vi.useRealTimers()
    }
  })

  it('coalesces a burst of push events into a single extra scan', async () => {
    vi.useFakeTimers()
    const scan = vi.fn<Provider['scan']>().mockResolvedValue([])
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), pollIntervalMs: 60_000 },
      providers: [{ kind: 'claude', scan, feed: async () => null }],
      onMinesUpdated: vi.fn()
    })
    try {
      for (let i = 0; i < 25; i++) runtime.nudge()
      await vi.advanceTimersByTimeAsync(1000)
      expect(scan).toHaveBeenCalledTimes(2)
    } finally {
      runtime.stop()
      vi.useRealTimers()
    }
  })
})

/**
 * Issue #21: "it feels slow" was previously unfalsifiable — the log carried a
 * verdict and nothing else. Each attempt now reports where its time went, with
 * exactly the same privacy rule as before: channels, stages, durations and
 * verdicts, never the message.
 */
describe('AgentRuntime delivery instrumentation', () => {
  const FOREMAN_ID = 'claude:session-1'

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  /** A runtime whose clock only moves when the delivery port says it did. */
  async function instrumentedRuntime(
    target: TextDeliveryTarget,
    port: TextDeliveryPort,
    clock: { value: number }
  ) {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [
        {
          kind: 'claude',
          scan: crewScan(),
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: (dwarfId: string) => (dwarfId === FOREMAN_ID ? target : null)
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => clock.value
    })
    await runtime.refresh()
    return runtime
  }

  function captureLog() {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    return {
      lines: () => log.mock.calls.map((call) => call.join(' ')),
      restore: () => log.mockRestore()
    }
  }

  it('logs the stages the console tier measured, alongside the verdict', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn().mockImplementation(async () => {
        clock.value += 45
        return { delivered: true, stages: { focusMs: 12, spawnMs: 30 } }
      }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)
    const logged = captureLog()

    await runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })

    const line = logged.lines().find((entry) => entry.includes('Message to')) ?? ''
    expect(line).toContain('focus=12ms')
    expect(line).toContain('spawn=30ms')
    expect(line).toContain('total=45ms')
    expect(line).toContain('delivered')
    logged.restore()
  })

  it('times the relay call itself — the tier that actually costs seconds', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockImplementation(async () => {
        clock.value += 5_210
        return { delivered: true }
      }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime(
      { kind: 'claude-relay', sessionName: 'sample-project-70' },
      port,
      clock
    )
    const logged = captureLog()

    await runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })

    const line = logged.lines().find((entry) => entry.includes('Message to')) ?? ''
    expect(line).toContain('relay=5210ms')
    expect(line).toContain('total=5210ms')
    logged.restore()
  })

  it('instruments a kick exactly like a message', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn().mockImplementation(async () => {
        clock.value += 20
        return { delivered: true, stages: { focusMs: 8, spawnMs: 12 } }
      })
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)
    const logged = captureLog()

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    const line = logged.lines().find((entry) => entry.includes('Kick for')) ?? ''
    expect(line).toContain('focus=8ms')
    expect(line).toContain('total=20ms')
    logged.restore()
  })

  it('times a failed attempt too — the slow ones are the ones worth measuring', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn().mockImplementation(async () => {
        clock.value += 90
        return { delivered: false, error: 'nope', stages: { focusMs: 90 } }
      }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)
    const logged = captureLog()

    await runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })

    const line = logged.lines().find((entry) => entry.includes('Message to')) ?? ''
    expect(line).toContain('failed')
    expect(line).toContain('focus=90ms')
    logged.restore()
  })

  it('instruments the relay fallback as its own attempt', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn().mockImplementation(async () => {
        clock.value += 40
        return { delivered: false, error: 'nope', stages: { focusMs: 40 } }
      }),
      relayToClaudeSession: vi.fn().mockImplementation(async () => {
        clock.value += 3_000
        return { delivered: true }
      }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime(
      { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' },
      port,
      clock
    )
    const logged = captureLog()

    await runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })

    const fallbackLine = logged.lines().find((entry) => entry.includes('Relay fallback')) ?? ''
    expect(fallbackLine).toContain('relay=3000ms')
    expect(fallbackLine).toContain('total=3000ms')
    logged.restore()
  })

  it('never lets the message anywhere near the instrumentation line', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({
        delivered: true,
        stages: { focusMs: 1, spawnMs: 2 }
      }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)
    const logged = captureLog()

    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'my-secret-payload',
      pressEnter: false
    })

    expect(logged.lines().join(' ')).not.toContain('my-secret-payload')
    logged.restore()
  })

  it('shuts the delivery port down when the runtime stops', async () => {
    const clock = { value: 0 }
    const dispose = vi.fn()
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn(),
      dispose
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)

    runtime.stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly when the delivery port has nothing to shut down', async () => {
    const clock = { value: 0 }
    const port: TextDeliveryPort = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    }
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)

    expect(() => runtime.stop()).not.toThrow()
  })
})

/**
 * Two-stage kick semantics (issue #21, from field research on a comparable
 * agent monitor): the FIRST kick is always the polite interrupt, and nothing
 * escalates to anything harder without a second explicit user request. A
 * session killed mid-write can corrupt its own transcript, so this invariant is
 * pinned here to stop a future change from quietly breaking it.
 */
describe('AgentRuntime kick escalation policy', () => {
  const FOREMAN_ID = 'claude:session-1'
  const HARSH = /kill|terminate|force|sigkill|taskkill|destroy/i

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  async function kickRuntime(target: TextDeliveryTarget) {
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    } satisfies TextDeliveryPort
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [
        {
          kind: 'claude',
          scan: crewScan(),
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: (dwarfId: string) => (dwarfId === FOREMAN_ID ? target : null)
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, port }
  }

  it('carries nothing but the pid — there is no escalation dial to turn', async () => {
    const { runtime, port } = await kickRuntime({ kind: 'terminal', pid: 42 })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    expect(port.sendInterrupt).toHaveBeenCalledWith({ pid: 42 })
    expect(Object.keys(port.sendInterrupt.mock.calls[0]?.[0] ?? {})).toEqual(['pid'])
  })

  it('repeats the identical polite interrupt on a second kick', async () => {
    const { runtime, port } = await kickRuntime({ kind: 'terminal', pid: 42 })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    expect(port.sendInterrupt.mock.calls).toEqual([[{ pid: 42 }], [{ pid: 42 }], [{ pid: 42 }]])
  })

  it('asks a relayed session to stop and never orders it killed', async () => {
    const { runtime, port } = await kickRuntime({
      kind: 'claude-relay',
      sessionName: 'sample-project-70'
    })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    const texts = port.relayToClaudeSession.mock.calls.map((call) => call[0].text as string)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe(texts[1])
    for (const text of texts) {
      expect(text).toMatch(/stop/i)
      expect(text).not.toMatch(HARSH)
    }
  })

  it('never reaches for the console typing path to cancel', async () => {
    const { runtime, port } = await kickRuntime({ kind: 'terminal', pid: 42 })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    expect(port.sendToConsole).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime material vault', () => {
  /** A provider whose one session's counter reads whatever the caller last set. */
  function countingProvider(): { provider: Provider; setTokens: (n: number) => void } {
    let tokens = 0
    const provider: Provider = {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\work\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: 'claude:session-1',
              provider: 'claude',
              role: 'worker',
              name: 'worker',
              status: 'working',
              sessionId: 'session-1',
              tokensObserved: tokens
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
    return { provider, setTokens: (n) => (tokens = n) }
  }

  /** A provider reporting an empty mine — the whole crew has gone home. */
  function emptyProvider(): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\work\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
  }

  /**
   * The project path the aggregator keys these mines on. countingProvider
   * reports its cwd as 'C:\work\project', and JavaScript drops both
   * backslashes there (neither \w nor \p is an escape sequence), so the mine's
   * path — and therefore the tier cache key — is exactly this string.
   */
  const VAULT_PROJECT = 'C:workproject'

  /** Tiny thresholds so a few KB of fixture crosses a real tier boundary. */
  const VAULT_THRESHOLDS: TierThresholds = {
    copperKb: 1,
    silverKb: 5,
    goldKb: 20,
    uraniumKb: 100
  }

  /**
   * A runtime whose tier walk has ALREADY finished, so accrual is not held
   * back by the provisional-tier rule (#41). The fake project holds no source
   * at all, which lands on a *computed* bronze — the same value tierOf used to
   * serve as a placeholder, except this one was actually measured.
   */
  async function vaultRuntime(
    providers: Provider[],
    ledger: MaterialLedger
  ): Promise<AgentRuntime> {
    const tiers = new TierService({
      fs: new FakeFs(),
      thresholds: VAULT_THRESHOLDS,
      ttlS: 600,
      now: () => 1_000
    })
    tiers.tierOf(VAULT_PROJECT)
    await tiers.settle()
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers,
      ledger,
      tiers,
      onMinesUpdated: vi.fn(),
      now: () => 1_000
    })
  }

  it('stamps every published mine with its persisted material breakdown', async () => {
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    const { provider, setTokens } = countingProvider()
    const runtime = await vaultRuntime([provider], ledger)

    setTokens(1_000)
    await runtime.refresh()
    setTokens(4_000)
    await runtime.refresh()

    // The tier callback has not resolved yet, so the mine is still bronze.
    expect(runtime.getMines()[0]!.materials?.bronze).toBe(3_000)
  })

  it('keeps the live tokensObserved gauge working alongside the breakdown', async () => {
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    const { provider, setTokens } = countingProvider()
    const runtime = await vaultRuntime([provider], ledger)

    setTokens(2_500)
    await runtime.refresh()

    expect(runtime.getMines()[0]!.tokensObserved).toBe(2_500)
  })

  it('keeps a mine material after its whole crew leaves', async () => {
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    const { provider, setTokens } = countingProvider()
    const runtime = await vaultRuntime([provider], ledger)

    setTokens(1_000)
    await runtime.refresh()
    setTokens(6_000)
    await runtime.refresh()

    const departed = await vaultRuntime([emptyProvider()], ledger)
    await departed.refresh()

    expect(departed.getMines()[0]!.materials?.bronze).toBe(5_000)
    expect(departed.getMines()[0]!.tokensObserved).toBe(0)
  })

  it('reports a global total that includes coal no mine produced', async () => {
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal('mine:archived', 90_000)
    const { provider, setTokens } = countingProvider()
    const runtime = await vaultRuntime([provider], ledger)

    setTokens(100)
    await runtime.refresh()
    setTokens(700)
    await runtime.refresh()

    expect(runtime.materialTotals().coal).toBe(90_000)
    expect(runtime.materialTotals().bronze).toBe(600)
  })

  it('hands the material totals to onMinesUpdated alongside the mines', async () => {
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal('mine:archived', 500)
    const onMinesUpdated = vi.fn()
    const { provider } = countingProvider()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [provider],
      ledger,
      onMinesUpdated,
      now: () => 1_000
    })

    await runtime.refresh()

    expect(onMinesUpdated.mock.calls[0]![1].coal).toBe(500)
  })

  it('forces a final write on stop so the last poll is never lost', async () => {
    const saves: LedgerState[] = []
    const ledger = new MaterialLedger({
      store: { load: async () => emptyLedger(), save: async (s) => void saves.push(s) }
    })
    await ledger.load()
    const { provider, setTokens } = countingProvider()
    const runtime = await vaultRuntime([provider], ledger)

    setTokens(1_000)
    await runtime.refresh()
    setTokens(9_000)
    await runtime.refresh()
    const mineId = runtime.getMines()[0]!.id
    runtime.stop()
    // The poll loop never awaits a write, so let the queued ones drain.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // Exactly one: the shutdown write must not race the throttled one onto
    // the same temp path.
    expect(saves).toHaveLength(1)
    expect(saves[0]!.mines[mineId]?.bronze).toBe(8_000)
  })

  it('runs without a ledger wired in, persisting nothing', async () => {
    // Every existing embedding (and every other test) constructs the runtime
    // with no vault; that must stay a working, disk-free configuration.
    const { provider, setTokens } = countingProvider()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [provider],
      onMinesUpdated: vi.fn()
    })
    setTokens(1_000)
    await expect(runtime.refresh()).resolves.toBeUndefined()
    expect(runtime.materialTotals().bronze).toBe(0)
  })

  /**
   * A filesystem whose directory walk hangs until release() is called, so a
   * test can hold the tier walk mid-flight and watch what the vault does while
   * the tier is still nothing but a placeholder.
   */
  function gatedFs(inner: FakeFs): FsLike & { release: () => void } {
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    return {
      readTextTail: (path, maxBytes) => inner.readTextTail(path, maxBytes),
      readTextHead: (path, maxBytes) => inner.readTextHead(path, maxBytes),
      readJson: (path) => inner.readJson(path),
      listDir: async (path) => {
        await gate
        return inner.listDir(path)
      },
      stat: (path) => inner.stat(path),
      exists: (path) => inner.exists(path),
      release: () => open()
    }
  }

  it('credits no phantom bronze while the mine tier is still being computed (#41)', async () => {
    // The live ledger carried 12 094 bronze on a project that has always been
    // silver: every poll between app start and the first completed walk was
    // sealed with the placeholder tierOf serves until then.
    const project = new FakeFs()
    project.addFile(`${VAULT_PROJECT}\\src\\app.ts`, 'a'.repeat(6 * 1024))
    const fs = gatedFs(project)
    const tiers = new TierService({
      fs,
      thresholds: VAULT_THRESHOLDS,
      ttlS: 600,
      now: () => 1_000
    })
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    const { provider, setTokens } = countingProvider()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [provider],
      ledger,
      tiers,
      onMinesUpdated: vi.fn(),
      now: () => 1_000
    })

    setTokens(1_000)
    await runtime.refresh()
    setTokens(50_000)
    await runtime.refresh()

    // The mound still draws bronze — that half was never the bug — but the
    // vault has credited nothing at all.
    expect(runtime.getMines()[0]!.tier).toBe('bronze')
    expect(runtime.materialTotals()).toEqual(emptyMaterialTotals())

    fs.release()
    await tiers.settle()
    setTokens(60_000)
    await runtime.refresh()

    // Every token since the first counter the vault ever saw, as silver, in
    // one credit — the wait costs nothing and duplicates nothing.
    expect(runtime.getMines()[0]!.tier).toBe('silver')
    expect(runtime.materialTotals().silver).toBe(59_000)
    expect(runtime.materialTotals().bronze).toBe(0)
  })
})

describe('AgentRuntime simulated provider wiring (#42)', () => {
  const ON = { [SIMULATION_ENV_VAR]: '1' }

  function fakeAdapters(): PlatformAdapters {
    return {
      platform: 'win32',
      focusPid: vi.fn().mockResolvedValue(false),
      launchTranscriptViewer: vi.fn().mockResolvedValue(false),
      viewerScriptPath: 'C:\viewer.mjs',
      textDelivery: {
        sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
        relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
        sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
      },
      processProbe: {
        isCodexProcessRunning: vi.fn().mockResolvedValue(false),
        processStartTimeMs: vi.fn().mockResolvedValue(null)
      }
    }
  }

  /**
   * A runtime built the way index.ts builds one — its OWN providers, not
   * injected ones — because the gate under test lives exactly there. The real
   * detectors are pointed at an empty FakeFs, so "no simulation" means "no
   * mines at all" and the assertions stay unambiguous.
   */
  function simulatedRuntime(options: {
    env?: Record<string, string>
    isPackaged: boolean
    ledger?: MaterialLedger
    now?: () => number
  }) {
    return new AgentRuntime({
      config: defaultConfig(),
      home: 'C:\Users\test',
      fs: new FakeFs(),
      sqlite: { openReadOnly: async () => null },
      platformAdapters: fakeAdapters(),
      appPaths: { isPackaged: options.isPackaged, resourcesPath: '', appPath: 'C:\app' },
      simulationEnv: options.env ?? {},
      ledger: options.ledger,
      now: options.now,
      onMinesUpdated: vi.fn()
    })
  }

  it('invents no mines when nothing asks for a simulation', async () => {
    const runtime = simulatedRuntime({ isPackaged: false })
    await runtime.refresh()
    expect(runtime.getMines()).toEqual([])
  })

  it('fills the valley when an unpackaged build explicitly asks for it', async () => {
    const runtime = simulatedRuntime({ env: ON, isPackaged: false })
    await runtime.refresh()

    const mines = runtime.getMines()
    expect(mines.length).toBe(defaultSimulationConfig().mines)
    expect(mines.every((mine) => mine.path.toLowerCase().includes('simulated'))).toBe(true)
    expect(mines.some((mine) => mine.dwarfs.length > 0)).toBe(true)
  })

  it('refuses to invent mines in a packaged build, however the environment is arranged', async () => {
    // The guarantee a user depends on: #38 gave a packaged app a real config
    // path, so the switch cannot be a config value. app.isPackaged is decided
    // by Electron from the running executable and no packaged build can lie.
    const runtime = simulatedRuntime({ env: ON, isPackaged: true })
    await runtime.refresh()
    expect(runtime.getMines()).toEqual([])
  })

  it('publishes a spread of tiers rather than a valley of identical bronze mounds', async () => {
    const runtime = simulatedRuntime({ env: ON, isPackaged: false })
    await runtime.refresh()
    // A real TierService would walk these paths, find nothing and call them all
    // bronze; the simulation has to own its own tier answers or the spread the
    // demo exists to show would be invisible.
    expect(new Set(runtime.getMines().map((mine) => mine.tier)).size).toBeGreaterThan(1)
  })

  it('shows every dwarf status in the published crew, foremen included', async () => {
    const runtime = simulatedRuntime({ env: ON, isPackaged: false })
    await runtime.refresh()
    const dwarfs = runtime.getMines().flatMap((mine) => mine.dwarfs)
    expect(new Set(dwarfs.map((dwarf) => dwarf.status))).toEqual(
      new Set(['working', 'waiting', 'leaving'])
    )
    expect(dwarfs.some((dwarf) => dwarf.role === 'foreman')).toBe(true)
  })

  it('keeps phantom ore out of the real vault while still accruing a visible one', async () => {
    // "A demo must never put phantom ore in a real vault." The persisted vault
    // index.ts hands in is dropped on the floor for the whole simulated run:
    // never observed, never saved. The panel still gets a live, growing vault
    // from an in-memory twin, so the pile caps of #22 are genuinely exercised.
    const save = vi.fn().mockResolvedValue(undefined)
    const persisted = new MaterialLedger({
      store: { load: async () => emptyLedger(), save }
    })
    let now = 1_000_000
    const runtime = simulatedRuntime({
      env: ON,
      isPackaged: false,
      ledger: persisted,
      now: () => now
    })

    for (let step = 0; step < 6; step++) {
      await runtime.refresh()
      now += defaultSimulationConfig().stepMs
    }
    runtime.stop()
    await Promise.resolve()

    expect(save).not.toHaveBeenCalled()
    expect(persisted.totals()).toEqual(emptyMaterialTotals())
    // ...and the vault the panel sees really did fill up.
    const totals = runtime.materialTotals()
    expect(Object.values(totals).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0)
  })

  it('leaves the real providers and the real vault alone once the switch is off', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const persisted = new MaterialLedger({
      store: { load: async () => emptyLedger(), save }
    })
    const runtime = simulatedRuntime({ isPackaged: false, ledger: persisted })
    await runtime.refresh()
    expect(runtime.getMines()).toEqual([])
    expect(persisted.totals()).toEqual(emptyMaterialTotals())
  })
})
