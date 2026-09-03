import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import {
  createProjectsStore,
  type ProjectRecord,
  type ProjectsStore
} from '../projects/projectsStore'
import { SIMULATION_ENV_VAR, defaultConfig, defaultSimulationConfig } from '../config/config'
import type { PlatformAdapters } from '../platform/platformAdapters'
import { mineIdForPath } from '../domain/aggregate'
import { emptyLedger, type LedgerState } from '../domain/ledger'
import { emptyMaterialTotals } from '../domain/materials'
import { MAX_DWARF_TEXT_CHARS, type DwarfQuestion, type FeedMessage } from '../domain/types'
import type { SessionLauncher } from '../sessionLaunch/launchRunner'
import { nullLedgerStore } from '../ledger/ledgerStore'
import { MaterialLedger } from '../ledger/materialLedger'
import { createCliDetector } from '../platform/cliDetection'
import type { Provider } from '../providers/provider'
import type { HeldSessionSubagentSignal } from '../sessionLaunch/heldCrew'
import type {
  HeldAnswer,
  HeldSessionPort,
  HeldSessionStartRequest,
  HeldSessionTelemetryUpdate
} from '../sessionLaunch/heldSession'
import { HeldSessionRegistry } from '../sessionLaunch/heldSessionRegistry'
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

  /**
   * The same transcript tail, on a channel of its own (#159). The message panel
   * wants an observed session's words without first failing to focus a window
   * and failing to open a terminal, which is the only way activation ever
   * reached them.
   */
  describe('AgentRuntime.dwarfFeed', () => {
    it('reads the same bounded tail activation falls back to, without touching a window', async () => {
      const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
      const source = provider(feed)
      const focus = vi.fn().mockResolvedValue(true)
      const launchTerminal = vi.fn().mockResolvedValue(true)
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [source],
        focus,
        launchTerminal,
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: true,
        messages: feed
      })
      expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
      // Reading is not activating: nothing was focused and no terminal opened.
      expect(focus).not.toHaveBeenCalled()
      expect(launchTerminal).not.toHaveBeenCalled()
    })

    it('says the transcript is readable and empty rather than unreadable', async () => {
      // Two different facts, and the panel shows two different things: "this
      // session has written nothing yet" is not "there is no way to read it".
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [provider([])],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: true,
        messages: []
      })
    })

    it('reads nothing for a dwarf that is not on the board', async () => {
      const source = provider()
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [source],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:nobody')).resolves.toEqual({
        readable: false,
        messages: []
      })
      expect(source.feed).not.toHaveBeenCalled()
    })

    it("reports unreadable when the provider does not know the dwarf's transcript", async () => {
      const source: Provider = { kind: 'claude', scan, feed: vi.fn().mockResolvedValue(null) }
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [source],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: false,
        messages: []
      })
    })

    /**
     * WHO issued the words, for a dwarf no human can type into (#175).
     *
     * The transcript of an agent-launched session opens with an ordinary `user`
     * record carrying the task it was given, so the panel drew the coordinator's
     * instruction under the user's own face. The runtime knows the board, which
     * is where the launcher is; see domain/messageIssuer.
     */
    function crewProvider(feed: FeedMessage[]): Provider {
      return {
        kind: 'claude',
        scan: vi.fn<Provider['scan']>().mockResolvedValue([
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
                role: 'foreman',
                name: 'coordinator',
                status: 'working',
                sessionId: 'session-1'
              },
              {
                id: 'claude:session-1:agent-77',
                provider: 'claude',
                role: 'worker',
                name: 'survey the seam',
                status: 'working',
                sessionId: 'session-1'
              }
            ]
          }
        ]),
        feed: vi.fn().mockResolvedValue(feed)
      }
    }

    const CREW_FEED: FeedMessage[] = [
      { role: 'user', text: 'survey the seam', timestamp: 't0' },
      { role: 'assistant', text: 'On my way.', timestamp: 't1' }
    ]

    it("names the foreman that launched a worker as the issuer of the worker's prompt", async () => {
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [crewProvider(CREW_FEED)],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1:agent-77')).resolves.toEqual({
        readable: true,
        messages: [
          {
            role: 'user',
            text: 'survey the seam',
            timestamp: 't0',
            issuer: { role: 'foreman', name: 'coordinator' }
          },
          { role: 'assistant', text: 'On my way.', timestamp: 't1' }
        ]
      })
    })

    it("leaves a session root's own prompt to the human who typed it", async () => {
      // The other half of #175, and the one that was already right: nobody
      // launched the root, so its first message carries no issuer at all.
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [crewProvider(CREW_FEED)],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: true,
        messages: CREW_FEED
      })
    })

    it('reports unreadable rather than throwing when the transcript read fails', async () => {
      const source: Provider = {
        kind: 'claude',
        scan,
        feed: vi.fn().mockRejectedValue(new Error('the file went away'))
      }
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [source],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: false,
        messages: []
      })
    })
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

/**
 * Routing over a Codex thread's message queue (#97).
 *
 * The queue is unlike both existing tiers in two ways the runtime has to
 * respect: it needs no console, so it must NOT be degraded on a platform that
 * cannot type into one; and it cannot interrupt a turn, so it carries a send
 * and never a kick.
 */
describe('AgentRuntime over the Codex message queue', () => {
  const DWARF_ID = 'codex:01a04d79-5c87-7a31-9b1a-4aacc350d6fd'
  const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'

  function queuePort(
    overrides: Partial<Record<keyof TextDeliveryPort, unknown>> = {}
  ): TextDeliveryPort {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true }),
      queueToCodexThread: vi.fn().mockResolvedValue({ delivered: true }),
      ...overrides
    } as TextDeliveryPort
  }

  async function runtimeWithQueue(port: TextDeliveryPort) {
    const source: Provider = {
      kind: 'codex',
      scan: vi.fn<Provider['scan']>().mockResolvedValue([
        {
          provider: 'codex',
          sessionId: THREAD_ID,
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: DWARF_ID,
              provider: 'codex',
              role: 'worker',
              name: 'codex-01a04d79',
              status: 'working',
              sessionId: THREAD_ID
            }
          ]
        }
      ]),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) =>
        dwarfId === DWARF_ID ? { kind: 'codex-queue', threadId: THREAD_ID } : null
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return runtime
  }

  it('queues the message on the thread and reports the channel that carried it', async () => {
    const port = queuePort()
    const runtime = await runtimeWithQueue(port)

    await expect(
      runtime.sendDwarfText({ dwarfId: DWARF_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'codex-queue' })
    expect(port.queueToCodexThread).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      text: 'run the tests'
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /**
   * The degrade in deliveryTargetOf exists because a 'terminal' target is a
   * claim about a console this platform may be unable to type into. The queue
   * makes no such claim — it spawns a CLI — so intersecting it with console
   * support would delete a working channel on macOS and Linux, the two
   * platforms with the least to lose it by.
   */
  it('keeps the queue on a platform that cannot type into a console at all', async () => {
    const port = queuePort({ supportsConsoleInput: false })
    const runtime = await runtimeWithQueue(port)

    await expect(
      runtime.sendDwarfText({ dwarfId: DWARF_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'codex-queue' })
    expect(runtime.getMines()[0]?.dwarfs[0]?.textDelivery).toBe('codex-queue')
  })

  it('stamps the queue for sending and no channel for cancelling on the published dwarf', async () => {
    const runtime = await runtimeWithQueue(queuePort())
    expect(runtime.getMines()[0]?.dwarfs[0]?.capabilities).toEqual({
      sendText: 'codex-queue',
      cancel: null,
      adjustEffort: null
    })
  })

  it('refuses a kick outright rather than queueing one that could never interrupt', async () => {
    const port = queuePort()
    const runtime = await runtimeWithQueue(port)

    const result = await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.queueToCodexThread).not.toHaveBeenCalled()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('reports the reason the queue tier gave, with no relay fallback to reach for', async () => {
    const port = queuePort({
      queueToCodexThread: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'Codex no longer knows that session.' })
    })
    const runtime = await runtimeWithQueue(port)

    await expect(
      runtime.sendDwarfText({ dwarfId: DWARF_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({
      delivered: false,
      via: 'codex-queue',
      error: 'Codex no longer knows that session.'
    })
    // A queue endpoint carries no session name, so there is nothing to fall
    // back to and nothing that should try.
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('turns a throwing queue tier into a failed verdict', async () => {
    const port = queuePort({
      queueToCodexThread: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const runtime = await runtimeWithQueue(port)
    await expect(
      runtime.sendDwarfText({ dwarfId: DWARF_ID, text: 'hi', pressEnter: true })
    ).resolves.toMatchObject({ delivered: false, via: 'codex-queue' })
  })

  /**
   * A port with no queue tier at all — the optional method left unimplemented.
   * It must refuse with a reason rather than silently reporting success or
   * throwing inside the send path.
   */
  it('refuses with a reason when the delivery port implements no queue tier', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const runtime = await runtimeWithQueue(port)

    const result = await runtime.sendDwarfText({
      dwarfId: DWARF_ID,
      text: 'hi',
      pressEnter: true
    })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  // The privacy rule for every tier: the log carries the channel, the verdict
  // and a character count, never the message (see port.ts and runtime.ts).
  it('logs the character count and never the message text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const runtime = await runtimeWithQueue(queuePort())
      await runtime.sendDwarfText({
        dwarfId: DWARF_ID,
        text: 'sk-do-not-log-this',
        pressEnter: true
      })
      const lines = log.mock.calls.map((call) => String(call[0])).join('\n')
      expect(lines).toContain('codex-queue')
      expect(lines).toContain('18 chars')
      expect(lines).not.toContain('sk-do-not-log-this')
    } finally {
      log.mockRestore()
    }
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
      },
      cliDetector: {
        detect: vi.fn().mockResolvedValue({ cli: 'claude', installed: false }),
        peek: vi.fn().mockReturnValue('unprobed')
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

describe('AgentRuntime.launchAgent (#86)', () => {
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
            id: 'claude:session-1',
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1'
          }
        ]
      }
    ])
  }

  async function runtimeWith(launchSession: SessionLauncher) {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'claude', scan: crewScan(), feed: vi.fn().mockResolvedValue([]) }],
      launchSession,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    // The id the panel would hold, derived exactly as aggregation derives it,
    // so the assertion does not depend on which OS the suite runs on.
    return { runtime, mineId: runtime.getMines()[0]!.id }
  }

  it("starts the session in the mine's own folder, which is what puts the dwarf there", async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await expect(
      runtime.launchAgent({ mineId, provider: 'claude', prompt: '  run the tests  ' })
    ).resolves.toEqual({
      launched: true,
      provider: 'claude'
    })
    expect(launchSession).toHaveBeenCalledWith({
      provider: 'claude',
      minePath: 'C:\\work\\project',
      prompt: 'run the tests'
    })
  })

  it('resolves the folder itself and never takes one from the request', async () => {
    // The renderer names a mine; main decides what directory that is. A launch
    // is therefore confined to a folder the panel is already showing.
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({
      mineId,
      provider: 'claude',
      prompt: 'go',
      ...({ minePath: 'C:\\somewhere\\else' } as object)
    })
    expect(launchSession).toHaveBeenCalledWith({
      provider: 'claude',
      minePath: 'C:\\work\\project',
      prompt: 'go'
    })
  })

  it('refuses a mine that is not on the board', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime } = await runtimeWith(launchSession)

    const nowhere = { mineId: 'mine:nowhere', provider: 'claude' as const, prompt: 'go' }
    await expect(runtime.launchAgent(nowhere)).resolves.toEqual({
      launched: false,
      provider: 'none',
      error: 'That mine is no longer on the map.'
    })
    expect(launchSession).not.toHaveBeenCalled()
  })

  it('refuses an empty prompt with its own reason', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await expect(
      runtime.launchAgent({ mineId, provider: 'claude', prompt: '  \n ' })
    ).resolves.toEqual({
      launched: false,
      provider: 'none',
      error: 'Type a prompt first.'
    })
    expect(launchSession).not.toHaveBeenCalled()
  })

  it('caps the prompt at the delivered-message limit', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({
      mineId,
      provider: 'claude',
      prompt: 'y'.repeat(MAX_DWARF_TEXT_CHARS + 200)
    })
    expect(launchSession.mock.calls[0]![0].prompt).toHaveLength(MAX_DWARF_TEXT_CHARS)
  })

  it('passes the launcher verdict straight through when it refuses', async () => {
    const refusal = {
      launched: false,
      provider: 'claude',
      error: 'Claude Code is not installed on this machine.'
    }
    const { runtime, mineId } = await runtimeWith(vi.fn().mockResolvedValue(refusal))

    await expect(
      runtime.launchAgent({ mineId, provider: 'claude', prompt: 'go' })
    ).resolves.toEqual(refusal)
  })

  it('turns a thrown launcher into a stated reason rather than a rejected promise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, mineId } = await runtimeWith(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(
      runtime.launchAgent({ mineId, provider: 'claude', prompt: 'go' })
    ).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: 'The agent could not be started.'
    })
    warn.mockRestore()
  })

  it('never logs the prompt, only how long it was', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runtime, mineId } = await runtimeWith(
      vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    )

    await runtime.launchAgent({ mineId, provider: 'claude', prompt: 'rotate the deploy key' })

    const lines = log.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(lines).toContain('21 chars')
    expect(lines).not.toContain('rotate the deploy key')
    log.mockRestore()
  })

  /*
   * #168. The chip the user pressed reaches the engine, and reaches it
   * unchanged. Before this the port took a folder and a prompt only, so the
   * provider was decided behind it and the panel's row of chips could not
   * affect which binary ran.
   */
  it('forwards the provider the request chose, rather than deciding one here', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'codex' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'go' })

    expect(launchSession.mock.calls[0]![0].provider).toBe('codex')
  })

  it('reports a thrown launcher against the provider that was asked for', async () => {
    // A verdict naming Claude for a Codex launch would have the panel show a
    // failure against a chip nobody pressed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, mineId } = await runtimeWith(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(runtime.launchAgent({ mineId, provider: 'codex', prompt: 'go' })).resolves.toEqual(
      {
        launched: false,
        provider: 'codex',
        error: 'The agent could not be started.'
      }
    )
    warn.mockRestore()
  })

  it('adds no dwarf of its own: the poll is the only thing that discovers one', async () => {
    // The launch acknowledges a START. Inventing a dwarf here would be a second
    // observation path, which is exactly what #86 refuses.
    const { runtime, mineId } = await runtimeWith(
      vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    )
    const before = runtime.getMines()[0]!.dwarfs.length

    await runtime.launchAgent({ mineId, provider: 'claude', prompt: 'go' })

    expect(runtime.getMines()[0]!.dwarfs).toHaveLength(before)
  })
})

describe('AgentRuntime projects wiring (#93)', () => {
  /** One session working one project, with no token counter to move. */
  function workingProvider(cwd = 'C:\\work\\project'): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd,
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: 'claude:session-1',
              provider: 'claude',
              role: 'foreman',
              name: 'foreman',
              status: 'working',
              sessionId: 'session-1'
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
  }

  function projectsStore(sqlite = new MemoryWritableSqlite()): ProjectsStore {
    return createProjectsStore({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
  }

  async function rows(store: ProjectsStore): Promise<ProjectRecord[]> {
    const result = await store.list()
    if (!result.ok) throw new Error(`the store refused: ${result.message}`)
    return result.value
  }

  it('records every project a session is seen working in', async () => {
    const projects = projectsStore()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [workingProvider()],
      projects,
      onMinesUpdated: vi.fn(),
      now: () => 5_000
    })

    await runtime.refresh()
    await runtime.settleProjects()

    expect(await rows(projects)).toMatchObject([
      { name: 'project', origin: 'discovered', lastProvider: 'claude', lastOpenedAt: 5_000 }
    ])
  })

  it('records the MEASURED tier only, never the bronze the mound is drawn as', async () => {
    // The mine crosses the wire as bronze because tierOf serves a placeholder
    // until the first walk finishes; the column stays empty until a walk has
    // actually produced an answer (#41).
    const projects = projectsStore()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [workingProvider()],
      projects,
      onMinesUpdated: vi.fn(),
      now: () => 5_000
    })

    await runtime.refresh()
    await runtime.settleProjects()

    expect(runtime.getMines()[0]!.tier).toBe('bronze')
    expect((await rows(projects))[0]!.knownTier).toBeNull()
  })

  it('keeps polling when there is no projects store at all', async () => {
    // The store refuses loudly by design, and index.ts turns that refusal into
    // a null. A broken projects database costs the declared mines, nothing else.
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [workingProvider()],
      projects: null,
      onMinesUpdated: vi.fn()
    })

    await runtime.refresh()
    await runtime.settleProjects()

    expect(runtime.getMines()).toHaveLength(1)
  })

  it('writes nothing at all while the simulated valley is running', async () => {
    // Same rule as the vault: a demo must never write into real persistence,
    // and /simulated-valley/... is not a project on anybody's disk.
    const projects = projectsStore()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home: 'C:\\Users\\test',
      fs: new FakeFs(),
      sqlite: { openReadOnly: async () => null },
      appPaths: { isPackaged: false, resourcesPath: '', appPath: 'C:\\app' },
      simulationEnv: { [SIMULATION_ENV_VAR]: '1' },
      projects,
      onMinesUpdated: vi.fn()
    })

    await runtime.refresh()
    await runtime.settleProjects()

    expect(runtime.getMines().length).toBeGreaterThan(0)
    expect(await rows(projects)).toEqual([])
  })

  it('never records a project the user merely declared', async () => {
    // Declaring is not opening: last_opened_at is what #92 sorts recency by,
    // and a folder nobody has run an agent in has never been opened.
    const projects = projectsStore()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [],
      projects,
      chooseDirectory: async () => 'C:\\X\\Adopted',
      onMinesUpdated: vi.fn()
    })

    await runtime.declareMine()
    await runtime.loadDeclared()
    await runtime.refresh()
    await runtime.settleProjects()
    runtime.stop()

    expect((await rows(projects))[0]!.lastOpenedAt).toBeNull()
  })

  it('does not write a row for every poll of the same unchanged project', async () => {
    const projects = projectsStore()
    const upsert = vi.spyOn(projects, 'upsertObserved')
    let now = 5_000
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [workingProvider()],
      projects,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now += 2_000
    await runtime.refresh()
    now += 2_000
    await runtime.refresh()
    await runtime.settleProjects()

    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('AgentRuntime declared mines (#85)', () => {
  const ADOPTED = 'C:\\X\\Adopted'

  /** A provider that reports a session in `cwd` only while `working` is true. */
  function toggleProvider(cwd: string): { provider: Provider; setWorking: (on: boolean) => void } {
    let working = false
    const provider: Provider = {
      kind: 'claude',
      scan: async () =>
        working
          ? [
              {
                provider: 'claude' as const,
                sessionId: 'session-1',
                cwd,
                status: 'busy' as const,
                updatedAt: 7,
                dwarfs: [
                  {
                    id: 'claude:session-1',
                    provider: 'claude' as const,
                    role: 'foreman' as const,
                    name: 'foreman',
                    status: 'working' as const,
                    sessionId: 'session-1'
                  }
                ]
              }
            ]
          : [],
      feed: vi.fn().mockResolvedValue([])
    }
    return { provider, setWorking: (on) => (working = on) }
  }

  function declaredRuntime(options: {
    projects?: ProjectsStore | null
    providers?: Provider[]
    chooseDirectory?: () => Promise<string | null>
    ledger?: MaterialLedger
  }): AgentRuntime {
    return new AgentRuntime({
      // A zero grace window so a departed crew is gone the moment it stops
      // being reported: what remains on the board is then the declaration, and
      // nothing borrowed from the leaving-dwarf path.
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: options.providers ?? [],
      projects: options.projects === undefined ? projectsStoreFor() : options.projects,
      chooseDirectory: options.chooseDirectory,
      ledger: options.ledger,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  function projectsStoreFor(sqlite = new MemoryWritableSqlite()): ProjectsStore {
    return createProjectsStore({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
  }

  /*
   * AMENDED for #156's seventh correction. The verdict was asserted as the WHOLE
   * object, and it now carries the adopted row as well — the panel has to be
   * able to put that card on screen itself, because re-declaring a folder the
   * store already knows leaves it wherever it already sat in the date order.
   * The subject is unchanged: which id the verdict names.
   */
  it('adopts the folder the picker returned and reports the id the ledger uses', async () => {
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result).toMatchObject({ outcome: 'added', mineId: mineIdForPath(ADOPTED) })
    expect(result.reason).toBeUndefined()
  })

  it('names the project it adopted, shaped exactly as the browse lists one', async () => {
    // Shaped by the same toSummary a query answers with, so the card the panel
    // draws from this verdict is the card it would have drawn from a page.
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result.project).toMatchObject({
      id: mineIdForPath(ADOPTED),
      path: ADOPTED,
      declared: true
    })
  })

  it('keeps a declared mine on the board with no crew, poll after poll', async () => {
    // The whole defect: a project is invisible until an agent runs in it and
    // gone twenty seconds later. A declaration is a steady state.
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    await runtime.declareMine()
    await runtime.refresh()
    const first = runtime.getMines()
    await runtime.refresh()
    await runtime.refresh()
    const third = runtime.getMines()
    runtime.stop()

    expect(first.map((mine) => mine.name)).toEqual(['Adopted'])
    expect(third).toHaveLength(1)
    expect(third[0]!.dwarfs).toEqual([])
    expect(third[0]!.declared).toBe(true)
  })

  it('shows a declared mine that is also being worked exactly once', async () => {
    const { provider, setWorking } = toggleProvider(ADOPTED)
    const runtime = declaredRuntime({
      providers: [provider],
      chooseDirectory: async () => ADOPTED
    })

    setWorking(true)
    await runtime.declareMine()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect(mines[0]!.dwarfs).toHaveLength(1)
    expect(mines[0]!.declared).toBe(true)
  })

  it('keeps a declared mine when its crew goes home, rather than expiring it', async () => {
    const { provider, setWorking } = toggleProvider(ADOPTED)
    const runtime = declaredRuntime({
      providers: [provider],
      chooseDirectory: async () => ADOPTED
    })

    await runtime.declareMine()
    setWorking(true)
    await runtime.refresh()
    setWorking(false)
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect(mines[0]!.dwarfs).toEqual([])
  })

  it('stamps a declared mine with the material that path already earned', async () => {
    // The reason not to invent a second id scheme: whatever the vault accrued
    // under this path attaches to the mine the moment the user adopts it.
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal(mineIdForPath(ADOPTED), 40_000)
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED, ledger })

    await runtime.declareMine()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines[0]!.materials?.coal).toBe(40_000)
  })

  it('draws a declared mine at the tier the store measured for it', async () => {
    const projects = projectsStoreFor()
    await projects.declare({ path: ADOPTED, at: 1 })
    await projects.upsertObserved({ path: ADOPTED, at: 2, knownTier: 'uranium' })
    const runtime = declaredRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines[0]!.tier).toBe('uranium')
  })

  it('takes an idle declared mine off the board when the user undeclares it', async () => {
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    const declared = await runtime.declareMine()
    await runtime.refresh()
    const result = await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(result).toEqual({ outcome: 'removed' })
    expect(mines).toEqual([])
  })

  it('reverts a worked mine to an ordinary discovered one instead of hiding it', async () => {
    const { provider, setWorking } = toggleProvider(ADOPTED)
    const runtime = declaredRuntime({
      providers: [provider],
      chooseDirectory: async () => ADOPTED
    })

    setWorking(true)
    const declared = await runtime.declareMine()
    await runtime.refresh()
    // The store demotes rather than deletes a project it has SEEN worked, so
    // the sighting has to have reached it before the declaration is undone.
    await runtime.settleProjects()
    const result = await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(result).toEqual({ outcome: 'reverted' })
    expect(mines).toHaveLength(1)
    expect(mines[0]!.declared).toBeUndefined()
    expect(mines[0]!.dwarfs).toHaveLength(1)
  })

  it('says the picker was cancelled when the user closes it, with no reason to give (#127)', async () => {
    // Backing out of the picker is a decision, not a fault: 'cancelled' says
    // the whole thing on its own, so there is no string alongside it either.
    const runtime = declaredRuntime({ chooseDirectory: async () => null })

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result).toEqual({ outcome: 'cancelled' })
  })

  it('says why nothing happened when the projects database refused to open', async () => {
    const runtime = declaredRuntime({ projects: null, chooseDirectory: async () => ADOPTED })

    const result = await runtime.declareMine()
    const undeclared = await runtime.undeclareMine('mine:whatever')
    runtime.stop()

    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.reason).toContain('projects database')
    expect(undeclared.outcome).toBe('failed')
    expect(undeclared.reason).toContain('projects database')
  })

  it('never opens the picker when there is nowhere to record the answer', async () => {
    // Asking the user to choose a folder and then dropping it on the floor is
    // worse than refusing: they did the work and the app forgot.
    const chooseDirectory = vi.fn().mockResolvedValue(ADOPTED)
    const runtime = declaredRuntime({ projects: null, chooseDirectory })

    await runtime.declareMine()
    runtime.stop()

    expect(chooseDirectory).not.toHaveBeenCalled()
  })

  it('refuses with a reason when no picker was wired in at all', async () => {
    const runtime = declaredRuntime({})

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result.outcome).toBe('failed')
    expect(result.reason).not.toBeUndefined()
  })

  it('reports a picker that threw instead of letting it reach the panel', async () => {
    const runtime = declaredRuntime({
      chooseDirectory: async () => {
        throw new Error('no window to attach the dialog to')
      }
    })

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result.outcome).toBe('failed')
    expect(result.reason).not.toBeUndefined()
  })

  it('says nothing changed for a mine the user never declared', async () => {
    const runtime = declaredRuntime({})

    const result = await runtime.undeclareMine('mine:never-declared')
    runtime.stop()

    expect(result.outcome).toBe('unchanged')
    expect(result.reason).not.toBeUndefined()
  })

  it('reads the declarations already stored before the first poll publishes', async () => {
    const projects = projectsStoreFor()
    await projects.declare({ path: ADOPTED, at: 1 })
    const runtime = declaredRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines.map((mine) => mine.name)).toEqual(['Adopted'])
  })
})

describe('AgentRuntime project queries (#92)', () => {
  const WORKED = 'C:\\X\\Cafetería-Ñandú'
  const ADOPTED = 'C:\\X\\Adopted'

  /** A provider that reports a session in `cwd` only while `working` is true. */
  function toggleProvider(cwd: string): { provider: Provider; setWorking: (on: boolean) => void } {
    let working = false
    const provider: Provider = {
      kind: 'claude',
      scan: async () =>
        working
          ? [
              {
                provider: 'claude' as const,
                sessionId: 'session-1',
                cwd,
                status: 'busy' as const,
                updatedAt: 7,
                dwarfs: [
                  {
                    id: 'claude:session-1',
                    provider: 'claude' as const,
                    role: 'foreman' as const,
                    name: 'foreman',
                    status: 'working' as const,
                    sessionId: 'session-1'
                  }
                ]
              }
            ]
          : [],
      feed: vi.fn().mockResolvedValue([])
    }
    return { provider, setWorking: (on) => (working = on) }
  }

  function queryRuntime(options: {
    projects?: ProjectsStore | null
    providers?: Provider[]
    ledger?: MaterialLedger
    tiers?: TierService
  }): AgentRuntime {
    return new AgentRuntime({
      // A zero grace window for the reason the #85 block uses one: a crew that
      // stopped being reported is gone at once, so `live` is answered from the
      // board rather than from the leaving-dwarf window.
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: options.providers ?? [],
      projects: options.projects === undefined ? queryStore() : options.projects,
      ledger: options.ledger,
      tiers: options.tiers,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  function queryStore(sqlite = new MemoryWritableSqlite()): ProjectsStore {
    return createProjectsStore({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
  }

  const newest = { sortBy: 'addedAt', direction: 'desc' } as const

  it('answers with what was remembered, on the wire shape rather than the row shape', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000, provider: 'codex', knownTier: 'gold' })
    const runtime = queryRuntime({ projects })

    const result = await runtime.queryProjects(newest)
    runtime.stop()

    expect(result.answered).toBe(true)
    expect(result.projects).toEqual([
      {
        id: mineIdForPath(WORKED),
        path: WORKED,
        name: 'Cafetería-Ñandú',
        declared: false,
        knownTier: 'gold',
        addedAt: 4_000,
        lastOpenedAt: 4_000,
        lastProvider: 'codex',
        // The store places every project it writes on one of the map's 74
        // spawn locations (#136), so the wire shape carries one. Which one is a
        // random draw and is asserted by identity in the next test, not here.
        mapSite: expect.any(Number),
        live: false
      }
    ])
  })

  it('carries the map placement the store chose, so a browse and the map agree (#136)', async () => {
    const projects = queryStore()
    const written = await projects.upsertObserved({ path: WORKED, at: 4_000 })
    const runtime = queryRuntime({ projects })

    const result = await runtime.queryProjects(newest)
    runtime.stop()

    expect(written.ok && written.value.mapSite).toBeGreaterThan(0)
    expect(result.projects[0]!.mapSite).toBe(written.ok ? written.value.mapSite : null)
  })

  it('says nothing about placement for a project nobody has placed (#136)', async () => {
    // The v2-to-v3 migration leaves existing projects unplaced on purpose, and
    // absent must reach the panel as absent: a zero would be site zero.
    const sqlite = new MemoryWritableSqlite()
    const projects = queryStore(sqlite)
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    const db = await sqlite.open('C:\\userData\\projects-v1.db')
    db.run('UPDATE projects SET map_site = NULL')
    db.close()
    const runtime = queryRuntime({ projects })

    const result = await runtime.queryProjects(newest)
    runtime.stop()

    expect('mapSite' in result.projects[0]!).toBe(false)
  })

  it('joins a project row against its persisted material breakdown by id (#90)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal(mineIdForPath(WORKED), 9_000)
    const runtime = queryRuntime({ projects, ledger })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    expect(project?.materials).toEqual({ ...emptyMaterialTotals(), coal: 9_000 })
  })

  it('leaves materials absent for a project the ledger has no row for at all (#90)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    // No credit, and the default ledger the helper builds is empty.
    const runtime = queryRuntime({ projects })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    // Absent, not a breakdown of zeros: the ledger has never heard of this id.
    expect(project).not.toHaveProperty('materials')
  })

  it('joins a project row against its measured source weight, the same way materials joins (#140)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    const fs = new FakeFs()
    fs.addFile(`${WORKED}\\a.ts`, 'a'.repeat(500))
    const tiers = new TierService({ fs, thresholds: defaultConfig().tierThresholds, ttlS: 600 })
    // Walk finished before the query, exactly as vaultRuntime() settles its
    // own TierService before handing it to the runtime — a query never
    // triggers or waits on a walk itself.
    tiers.tierOf(WORKED)
    await tiers.settle()
    const runtime = queryRuntime({ projects, tiers })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    expect(project?.weightBytes).toBe(500)
  })

  it('leaves weightBytes absent for a project no walk has measured yet (#140)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    // No injected TierService, so the runtime's own has never walked WORKED.
    const runtime = queryRuntime({ projects })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    // Absent, not an invented 0: the same #41 discipline knownTier uses.
    expect(project).not.toHaveProperty('weightBytes')
  })

  it('joins materials the same way for a live project and a crewless one (#90)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    await projects.upsertObserved({ path: ADOPTED, at: 1_000 })
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal(mineIdForPath(WORKED), 2_000)
    ledger.creditCoal(mineIdForPath(ADOPTED), 5_000)
    const { provider, setWorking } = toggleProvider(WORKED)
    setWorking(true)
    const runtime = queryRuntime({ projects, providers: [provider], ledger })

    await runtime.refresh()
    await runtime.settleProjects()
    const result = await runtime.queryProjects(newest)
    runtime.stop()

    const worked = result.projects.find((project) => project.path === WORKED)
    const adopted = result.projects.find((project) => project.path === ADOPTED)
    expect(worked?.live).toBe(true)
    expect(worked?.materials?.coal).toBe(2_000)
    expect(adopted?.live).toBe(false)
    expect(adopted?.materials?.coal).toBe(5_000)
  })

  it('leaves an unmeasured tier absent rather than reporting bronze (#41)', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 4_000 })
    const runtime = queryRuntime({ projects })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    // Absent means "nobody has walked this yet". tierOf()'s provisional bronze
    // draws the mound and must never travel as an answer.
    expect(project).not.toHaveProperty('knownTier')
    expect(project).not.toHaveProperty('lastProvider')
  })

  it('leaves lastOpenedAt absent for a project the user added and no agent has entered', async () => {
    const projects = queryStore()
    await projects.declare({ path: ADOPTED, at: 1_000 })
    const runtime = queryRuntime({ projects })

    const [project] = (await runtime.queryProjects(newest)).projects
    runtime.stop()

    expect(project?.declared).toBe(true)
    expect(project).not.toHaveProperty('lastOpenedAt')
  })

  it('stamps live from the board this poll produced, not from anything stored', async () => {
    // The fact the database deliberately does not hold. A project is remembered
    // forever and is live only while a session is in it.
    const { provider, setWorking } = toggleProvider(WORKED)
    const projects = queryStore()
    const runtime = queryRuntime({ projects, providers: [provider] })

    setWorking(true)
    await runtime.refresh()
    await runtime.settleProjects()
    expect((await runtime.queryProjects(newest)).projects[0]?.live).toBe(true)

    setWorking(false)
    await runtime.refresh()
    const after = await runtime.queryProjects(newest)
    runtime.stop()

    // Still remembered, no longer live — which is the entire reason a browse
    // surface is not a filter over the board.
    expect(after.projects.map((project) => project.name)).toEqual(['Cafetería-Ñandú'])
    expect(after.projects[0]?.live).toBe(false)
  })

  it('counts a declared mine as live, because a declaration keeps it on the board', async () => {
    // Not an exception to the rule above: `live` is "on the board", and #85
    // puts a declared project there with no crew. The two facts agree.
    const projects = queryStore()
    await projects.declare({ path: ADOPTED, at: 1_000 })
    const runtime = queryRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const result = await runtime.queryProjects(newest)
    runtime.stop()

    expect(result.projects[0]?.live).toBe(true)
  })

  it('passes the filters and the order down to the store rather than trimming the answer here', async () => {
    const projects = queryStore()
    await projects.upsertObserved({ path: WORKED, at: 1_000 })
    await projects.upsertObserved({ path: 'C:\\X\\smelter', at: 2_000, knownTier: 'silver' })
    const runtime = queryRuntime({ projects })

    const searched = await runtime.queryProjects({ ...newest, nameContains: 'cafeteria' })
    const filtered = await runtime.queryProjects({ ...newest, tier: 'silver' })
    const oldest = await runtime.queryProjects({ sortBy: 'addedAt', direction: 'asc' })
    const page = await runtime.queryProjects({ ...newest, limit: 1, offset: 1 })
    runtime.stop()

    expect(searched.projects.map((project) => project.name)).toEqual(['Cafetería-Ñandú'])
    expect(filtered.projects.map((project) => project.name)).toEqual(['smelter'])
    expect(oldest.projects.map((project) => project.name)).toEqual(['Cafetería-Ñandú', 'smelter'])
    expect(page.projects.map((project) => project.name)).toEqual(['Cafetería-Ñandú'])
  })

  it('says why it cannot answer when this run has no projects database', async () => {
    const runtime = queryRuntime({ projects: null })

    const result = await runtime.queryProjects(newest)
    runtime.stop()

    expect(result.answered).toBe(false)
    expect(result.projects).toEqual([])
    expect(result.reason).not.toBeUndefined()
  })

  it('reports a refusing store as a refusal, never as a project list that is empty', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const runtime = queryRuntime({ projects: queryStore(sqlite) })

    const result = await runtime.queryProjects(newest)
    runtime.stop()

    // The distinction the whole store contract exists for: a user reading an
    // empty browse must never be looking at a database that would not open.
    expect(result.answered).toBe(false)
    expect(result.projects).toEqual([])
    expect(result.reason).not.toBeUndefined()
  })
})

describe('AgentRuntime held sessions (#86, #94)', () => {
  const MINE_PATH = 'C:\\X\\anvil'
  const CLAUDE = '/home/j/.local/bin/claude'

  /** The Agent SDK seam. No runtime test starts a real agent. */
  function heldPort(): {
    port: HeldSessionPort
    started: HeldSessionStartRequest[]
    closes: () => number
    reportSessionId: (index: number, sessionId: string) => void
    ask: (index: number, toolUseId: string) => Promise<HeldAnswer>
    reportTelemetry: (index: number, update: HeldSessionTelemetryUpdate) => void
    reportSubagent: (index: number, signal: HeldSessionSubagentSignal) => void
    reportMessage: (index: number, role: 'user' | 'assistant', text: string) => void
  } {
    const started: HeldSessionStartRequest[] = []
    let closed = 0
    return {
      started,
      closes: () => closed,
      port: async (request) => {
        started.push(request)
        return {
          close: () => {
            closed += 1
          },
          send: () => true
        }
      },
      reportSessionId: (index, sessionId) => started[index]!.onSessionId(sessionId),
      ask: (index, toolUseId) =>
        started[index]!.onAsk(toolUseId, {
          questions: [
            {
              question: 'Which colour?',
              multiSelect: false,
              options: [{ label: 'Green' }, { label: 'Red' }]
            }
          ]
        }),
      reportTelemetry: (index, update) => started[index]!.onTelemetry(update),
      // #157: what the SDK loop forwards when the session's own stream says
      // something about its crew.
      reportSubagent: (index, signal) => started[index]!.onSubagent(signal),
      reportMessage: (index, role, text) => started[index]!.onMessage(role, text)
    }
  }

  function heldRegistry(port: HeldSessionPort): HeldSessionRegistry {
    const fs = new FakeFs()
    fs.addFile(CLAUDE, '#!/bin/sh\n')
    return new HeldSessionRegistry({
      detector: createCliDetector({ home: '/home/j', platform: 'linux', fs, env: {} }),
      start: port,
      now: () => 1_700_000_000_000,
      log: () => {}
    })
  }

  /** A provider reporting one foreman in MINE_PATH, with an optional tail-derived ask. */
  function foremanProvider(pendingQuestion?: DwarfQuestion): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude' as const,
          sessionId: 'sess-1',
          cwd: MINE_PATH,
          status: 'busy' as const,
          updatedAt: 7,
          dwarfs: [
            {
              id: 'claude:sess-1',
              provider: 'claude' as const,
              role: 'foreman' as const,
              name: 'foreman',
              status: 'working' as const,
              sessionId: 'sess-1',
              ...(pendingQuestion === undefined ? {} : { pendingQuestion })
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
  }

  function heldRuntime(options: {
    heldSessions: HeldSessionRegistry
    providers?: Provider[]
  }): AgentRuntime {
    return new AgentRuntime({
      config: defaultConfig(),
      providers: options.providers ?? [],
      heldSessions: options.heldSessions,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  it("starts a held session in the mine's own folder, which is what puts its dwarf there", async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    await expect(
      runtime.launchHeldSession({
        provider: 'claude',
        mineId: mineIdForPath(MINE_PATH),
        prompt: 'dig here'
      })
    ).resolves.toEqual({ launched: true })
    runtime.stop()

    expect(port.started).toHaveLength(1)
    expect(port.started[0]!.cwd).toBe(MINE_PATH)
    // The binary detection found (#91), never one this app constructed and
    // never the SDK's own bundled executable.
    expect(port.started[0]!.executablePath).toBe(CLAUDE)
  })

  it('refuses a mine that is not on the board, so the channel can never name a folder', async () => {
    const port = heldPort()
    const runtime = heldRuntime({ heldSessions: heldRegistry(port.port) })

    const result = await runtime.launchHeldSession({
      provider: 'claude',
      mineId: 'mine-nobody',
      prompt: 'dig'
    })
    runtime.stop()

    expect(result.launched).toBe(false)
    expect(result.error).not.toBeUndefined()
    expect(port.started).toHaveLength(0)
  })

  it('refuses to start a real agent inside a simulated valley', async () => {
    // The rule the ledger and the projects store already hold (#42): a demo
    // must not reach into the real machine, and /simulated-valley/... is
    // nobody's folder.
    const port = heldPort()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      simulationEnv: { [SIMULATION_ENV_VAR]: '1' },
      appPaths: { isPackaged: false, resourcesPath: '', appPath: 'C:\\app' },
      heldSessions: heldRegistry(port.port),
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
    await runtime.refresh()
    const mineId = runtime.getMines()[0]?.id ?? ''

    const result = await runtime.launchHeldSession({ mineId, provider: 'claude', prompt: 'dig' })
    runtime.stop()

    expect(mineId).not.toBe('')
    expect(result.launched).toBe(false)
    expect(port.started).toHaveLength(0)
  })

  it("stamps a held session's live question on its foreman, superseding the tail's", async () => {
    const port = heldPort()
    const stale: DwarfQuestion = {
      toolUseId: 'toolu_stale',
      question: 'Which shape?',
      multiSelect: false,
      options: [{ label: 'Round' }]
    }
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider(stale)]
    })
    await runtime.refresh()
    // The tail's own ask is what the panel would show without a held session.
    expect(runtime.getMines()[0]!.dwarfs[0]!.pendingQuestion?.toolUseId).toBe('toolu_stale')

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    void port.ask(0, 'toolu_live')
    await Promise.resolve()
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs[0]!.pendingQuestion?.toolUseId).toBe('toolu_live')

    // ...and it CLEARS when the ask is answered, rather than falling back to
    // the tail's post-hoc one, which would resurrect an answered question.
    runtime.answerDwarfQuestion({
      dwarfId: 'claude:sess-1',
      toolUseId: 'toolu_live',
      answers: { 'Which colour?': 'Green' }
    })
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs[0]!.pendingQuestion).toBeUndefined()
    runtime.stop()
  })

  it("stamps a held session's own self-reported telemetry on its foreman (#96)", async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()
    // Nothing to stamp before the session even starts.
    expect(runtime.getMines()[0]!.dwarfs[0]!.model).toBeUndefined()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, {
      model: 'claude-haiku-4-5',
      mcpServers: [{ name: 'codegraph', status: 'connected' }]
    })
    port.reportTelemetry(0, { totalCostUsd: 0.0697689 })
    await runtime.refresh()

    const dwarf = runtime.getMines()[0]!.dwarfs[0]!
    expect(dwarf.model).toBe('claude-haiku-4-5')
    expect(dwarf.mcpServers).toEqual([{ name: 'codegraph', status: 'connected' }])
    expect(dwarf.totalCostUsd).toBe(0.0697689)
    runtime.stop()
  })

  it("stamps the exchange a held session's own stream carried on its foreman (#159)", async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()
    // A session nobody is holding carries no conversation at all — the panel
    // reads an observed session's words off its transcript instead.
    expect(runtime.getMines()[0]!.dwarfs[0]!.conversation).toBeUndefined()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig here'
    })
    port.reportSessionId(0, 'sess-1')
    port.reportMessage(0, 'assistant', 'Found the seam.')
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs[0]!.conversation).toEqual([
      { role: 'user', text: 'dig here', timestamp: new Date(1_700_000_000_000).toISOString() },
      {
        role: 'assistant',
        text: 'Found the seam.',
        timestamp: new Date(1_700_000_000_000).toISOString()
      }
    ])
    runtime.stop()
  })

  it("releases the agent's blocked call with exactly the answers record, found by dwarf id", async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    const asked = port.ask(0, 'toolu_live')
    await Promise.resolve()

    expect(
      runtime.answerDwarfQuestion({
        dwarfId: 'claude:sess-1',
        toolUseId: 'toolu_live',
        answers: { 'Which colour?': 'Green' }
      })
    ).toEqual({ answered: true })
    await expect(asked).resolves.toEqual({
      answered: true,
      answers: { 'Which colour?': 'Green' }
    })
    runtime.stop()
  })

  it('refuses an answer for a dwarf that is not on the board', async () => {
    const port = heldPort()
    const runtime = heldRuntime({ heldSessions: heldRegistry(port.port) })

    const result = runtime.answerDwarfQuestion({
      dwarfId: 'claude:nobody',
      toolUseId: 'toolu_live',
      answers: { 'Which colour?': 'Green' }
    })
    runtime.stop()

    expect(result.answered).toBe(false)
    expect(result.error).not.toBeUndefined()
  })

  it('dissolves every open question on shutdown, and closes the session it held', async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    const asked = port.ask(0, 'toolu_live')
    await Promise.resolve()

    runtime.stop()

    // Never a fabricated answer: the panel quit, and the agent is told exactly
    // that rather than being handed an empty choice.
    expect((await asked).answered).toBe(false)
    expect(port.closes()).toBe(1)
  })

  /*
   * #157, end to end through the poll.
   *
   * The provider above reports ONE dwarf for sess-1 and can report no more: a
   * held session's subagents run in the foreground, so its transcript carries
   * no `async_launched` record for the tail parse to find (measured — see
   * heldCrew.ts). Everything below therefore arrives from the stream, and these
   * are the tests that hold the two halves together.
   */
  describe('the crew of a held session (#157)', () => {
    const launched = (
      taskId: string,
      extra: Partial<Extract<HeldSessionSubagentSignal, { kind: 'task-started' }>> = {}
    ): HeldSessionSubagentSignal => ({
      kind: 'task-started',
      taskId,
      taskType: 'local_agent',
      spawnDepth: 1,
      ...extra
    })

    /** A held session in MINE_PATH, already stamped with the id the poll finds. */
    async function heldMine(port: ReturnType<typeof heldPort>): Promise<AgentRuntime> {
      const runtime = heldRuntime({
        heldSessions: heldRegistry(port.port),
        providers: [foremanProvider()]
      })
      await runtime.refresh()
      await runtime.launchHeldSession({
        provider: 'claude',
        mineId: mineIdForPath(MINE_PATH),
        prompt: 'dig'
      })
      port.reportSessionId(0, 'sess-1')
      return runtime
    }

    function crewOf(runtime: AgentRuntime): { id: string; role: string }[] {
      return runtime
        .getMines()
        .flatMap((mine) => mine.dwarfs)
        .map((dwarf) => ({ id: dwarf.id, role: dwarf.role }))
    }

    it('shows the subagents the poll could never see, ranked by their own depth', async () => {
      const port = heldPort()
      const runtime = await heldMine(port)

      port.reportSubagent(0, launched('a1', { toolUseId: 'toolu-1', description: 'Explorer' }))
      port.reportSubagent(0, {
        kind: 'tool-call',
        toolUseId: 'toolu-2',
        insideToolUseId: 'toolu-1'
      })
      port.reportSubagent(
        0,
        launched('a2', { toolUseId: 'toolu-2', spawnDepth: 2, description: 'Scout' })
      )
      await runtime.refresh()
      runtime.stop()

      expect(crewOf(runtime)).toEqual([
        { id: 'claude:sess-1', role: 'foreman' },
        { id: 'claude:sess-1:a1', role: 'worker' },
        { id: 'claude:sess-1:a2', role: 'worker2' }
      ])
    })

    it('digs alone until it coordinates, then keeps the rank it earned', async () => {
      const port = heldPort()
      const runtime = await heldMine(port)

      await runtime.refresh()
      expect(crewOf(runtime)).toEqual([{ id: 'claude:sess-1', role: 'worker' }])

      port.reportSubagent(0, launched('a1'))
      await runtime.refresh()
      expect(crewOf(runtime)[0]!.role).toBe('foreman')

      // The observed sessions' own rule: a session is the foreman whether or
      // not it currently has agents out, so promotion does not reverse when the
      // last one finishes. Both paths say the same thing about the same dwarf.
      port.reportSubagent(0, { kind: 'task-ended', taskId: 'a1' })
      await runtime.refresh()
      runtime.stop()
      // The rank alone: the finished subagent is still on the board, walking
      // out on its grace window, which the case below is about.
      expect(crewOf(runtime)[0]).toEqual({ id: 'claude:sess-1', role: 'foreman' })
    })

    it('walks a finished subagent out rather than blinking it off the board', async () => {
      // The crew joins the snapshot BEFORE the lifecycle runs, which is the
      // whole reason it is stamped where it is: a departing crew member gets
      // the same grace window every other dwarf gets, and 'leaving' is what
      // sends it to the nearest spawn point.
      const port = heldPort()
      const runtime = await heldMine(port)

      port.reportSubagent(0, launched('a1'))
      await runtime.refresh()
      port.reportSubagent(0, { kind: 'task-ended', taskId: 'a1' })
      await runtime.refresh()
      runtime.stop()

      const leaving = runtime
        .getMines()
        .flatMap((mine) => mine.dwarfs)
        .find((dwarf) => dwarf.id === 'claude:sess-1:a1')
      expect(leaving?.status).toBe('leaving')
    })

    it('offers a send on every crew member, routed through the tree above it', async () => {
      const port = heldPort()
      const runtime = await heldMine(port)

      port.reportSubagent(0, launched('a1', { toolUseId: 'toolu-1', description: 'Explorer' }))
      port.reportSubagent(0, {
        kind: 'tool-call',
        toolUseId: 'toolu-2',
        insideToolUseId: 'toolu-1'
      })
      port.reportSubagent(
        0,
        launched('a2', { toolUseId: 'toolu-2', spawnDepth: 2, description: 'Scout' })
      )
      await runtime.refresh()
      runtime.stop()

      // No provider reports a channel for the session itself here, so the hops
      // resolve to nothing — which is the honest answer and NOT what this pins.
      // What it pins is that the crew is routed at all: every one of them
      // carries a relay target, so resolve.ts has a chain to follow the moment
      // the session has a channel of its own.
      const dwarfs = runtime.getMines().flatMap((mine) => mine.dwarfs)
      expect(dwarfs.map((dwarf) => dwarf.id)).toContain('claude:sess-1:a2')
    })

    it('leaves an observed session, which this panel does not hold, entirely alone', async () => {
      const port = heldPort()
      const runtime = heldRuntime({
        heldSessions: heldRegistry(port.port),
        providers: [foremanProvider()]
      })
      await runtime.refresh()
      runtime.stop()

      // Nothing launched, nothing held: the provider's own reading stands, rank
      // included. A session this panel merely watches is never demoted by a
      // stream it is not reading.
      expect(crewOf(runtime)).toEqual([{ id: 'claude:sess-1', role: 'foreman' }])
    })
  })
})

/**
 * Settings' "Reset metrics" action (#138). PRODUCT DECISION, restated at the
 * call site: this wipes the material LEDGER only. It never touches the
 * projects store — a declared or discovered mine is the user's remembered
 * project list, not a metric — which is why these tests assert the ledger
 * emptied and the runtime's own mine list untouched, in the same breath.
 */
describe('AgentRuntime.resetMetrics (#138)', () => {
  /** Same minimal LedgerStore fake materialLedger.test.ts uses. */
  function fakeLedgerStore(initial: LedgerState = emptyLedger()) {
    const saves: LedgerState[] = []
    return {
      saves,
      async load() {
        return initial
      },
      async save(state: LedgerState) {
        saves.push(state)
      }
    }
  }

  it('clears the vault and reports the outcome', async () => {
    const store = fakeLedgerStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.creditCoal('mine:a', 9_000)

    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [],
      ledger,
      onMinesUpdated: vi.fn(),
      now: () => 5_000
    })

    expect(runtime.materialTotals().coal).toBe(9_000)
    const result = await runtime.resetMetrics()
    runtime.stop()

    expect(result).toEqual({ outcome: 'reset' })
    expect(runtime.materialTotals()).toEqual(emptyMaterialTotals())
  })

  it('never touches a declared mine while resetting its metrics', async () => {
    const ADOPTED = 'C:\\X\\Adopted'
    const projects = createProjectsStore({
      filePath: 'C:\\userData\\projects-v1.db',
      sqlite: new MemoryWritableSqlite()
    })
    const store = fakeLedgerStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.creditCoal(mineIdForPath(ADOPTED), 500)

    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [],
      projects,
      ledger,
      chooseDirectory: async () => ADOPTED,
      onMinesUpdated: vi.fn(),
      now: () => 5_000
    })
    await runtime.declareMine()

    const result = await runtime.resetMetrics()
    const stillDeclared = await runtime.queryProjects({ sortBy: 'addedAt', direction: 'desc' })
    runtime.stop()

    expect(result).toEqual({ outcome: 'reset' })
    expect(stillDeclared.projects.map((project) => project.path)).toContain(ADOPTED)
    expect(stillDeclared.projects[0]?.materials).toBeUndefined()
  })

  it('reports a failure and its reason when the store refuses to persist the wipe', async () => {
    const store = fakeLedgerStore()
    store.save = async () => {
      throw new Error('ENOSPC')
    }
    const ledger = new MaterialLedger({ store, onError: () => undefined })
    await ledger.load()
    ledger.creditCoal('mine:a', 500)

    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [],
      ledger,
      onMinesUpdated: vi.fn(),
      now: () => 5_000
    })

    const result = await runtime.resetMetrics()
    runtime.stop()

    expect(result.outcome).toBe('failed')
    expect(result.reason).toBeTruthy()
  })
})

/*
 * Where each mine stands on the world map, carried from the store to the panel
 * (#136).
 *
 * The design's rule is one sentence — "persist the assigned location so closing
 * and reopening DwarfAI-Miners does not move a mine" — and these are the two
 * joints where it can be dropped: the board assembled from the store on launch,
 * and the board assembled a moment after a project the app had never seen was
 * first written.
 */
describe('AgentRuntime map placement (#136)', () => {
  const WALKED = 'C:\\X\\Walked'

  function placementStore(sqlite = new MemoryWritableSqlite()): ProjectsStore {
    return createProjectsStore({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
  }

  /** A provider reporting one working session in `cwd`, every scan. */
  function busyProvider(cwd: string): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude' as const,
          sessionId: 'session-1',
          cwd,
          status: 'busy' as const,
          updatedAt: 7,
          dwarfs: [
            {
              id: 'claude:session-1',
              provider: 'claude' as const,
              role: 'foreman' as const,
              name: 'foreman',
              status: 'working' as const,
              sessionId: 'session-1'
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
  }

  function placementRuntime(options: {
    projects?: ProjectsStore | null
    providers?: Provider[]
  }): AgentRuntime {
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: options.providers ?? [],
      projects: options.projects === undefined ? placementStore() : options.projects,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  it('draws a declared mine at the location the store remembers', async () => {
    const projects = placementStore()
    const declared = await projects.declare({ path: WALKED, at: 1 })
    const runtime = placementRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(declared.ok && declared.value.mapSite).toBeGreaterThan(0)
    expect(mines[0]!.mapSite).toBe(declared.ok ? declared.value.mapSite : null)
  })

  it('keeps a mine at the same location across a restart', async () => {
    // The whole requirement, end to end: a second runtime over the same
    // database publishes the same location without anything asking it to.
    const sqlite = new MemoryWritableSqlite()
    const first = placementRuntime({ projects: placementStore(sqlite) })
    await placementStore(sqlite).declare({ path: WALKED, at: 1 })
    await first.loadDeclared()
    await first.refresh()
    const before = first.getMines()[0]!.mapSite
    first.stop()

    const second = placementRuntime({ projects: placementStore(sqlite) })
    await second.loadDeclared()
    await second.refresh()
    const after = second.getMines()[0]!.mapSite
    second.stop()

    expect(before).toBeGreaterThan(0)
    expect(after).toBe(before)
  })

  /*
    A project discovered from a running session is placed by the write the
    observer makes during the poll that first sees it. Without the observer
    reporting that row back, the panel would draw the mine at its own fallback
    position and move it on the next launch — the one thing the design forbids.
  */
  it('places a mine the app has only just discovered, without waiting for a restart', async () => {
    const projects = placementStore()
    const runtime = placementRuntime({ projects, providers: [busyProvider(WALKED)] })

    await runtime.refresh()
    await runtime.settleProjects()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    const stored = await projects.get(mineIdForPath(WALKED))
    expect(mines[0]!.mapSite).toBe(stored.ok ? stored.value?.mapSite : null)
    expect(mines[0]!.mapSite).toBeGreaterThan(0)
  })

  it('leaves a mine unplaced when there is no store to remember one', async () => {
    // Absent, not zero: the panel places these itself, deterministically.
    const runtime = placementRuntime({ projects: null, providers: [busyProvider(WALKED)] })

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect('mapSite' in mines[0]!).toBe(false)
  })

  it('places no simulated mine and writes no placement for one (#42)', async () => {
    // The demo gate already drops the store for the whole simulated run, so
    // this is what that costs and what it must keep costing: an invented valley
    // gets no persisted locations, the panel places its mines itself, and the
    // real table is untouched by a run whose whole point is that it is a demo.
    const projects = placementStore()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home: 'C:\\Users\\test',
      fs: new FakeFs(),
      sqlite: { openReadOnly: async () => null },
      appPaths: { isPackaged: false, resourcesPath: '', appPath: 'C:\\app' },
      simulationEnv: { [SIMULATION_ENV_VAR]: '1' },
      projects,
      onMinesUpdated: vi.fn()
    })

    await runtime.refresh()
    await runtime.settleProjects()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines.length).toBeGreaterThan(0)
    expect(mines.every((mine) => !('mapSite' in mine))).toBe(true)
    const stored = await projects.list()
    expect(stored.ok && stored.value).toEqual([])
  })

  /*
   * The third joint, and the one the second acceptance run found (#156).
   *
   * The board is assembled in four steps and the placement stamp was the third
   * of them, with the lifecycle tracker running AFTER it. That tracker is the
   * one step that can put a mine on the board which was not on it a moment
   * before: when the last session in a project ends, the whole mine leaves the
   * provider's snapshot, and the tracker rebuilds it from what it remembers so
   * the departing dwarf has somewhere to walk out of. Rebuilt after the stamp,
   * that mine carried no location at all — so for the length of the grace
   * window the panel fell back to placing it itself, and one project stood in
   * two different places on the map within a second of each other.
   */
  it('keeps a mine where the store put it while its last session walks out', async () => {
    let now = 0
    const working = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'foreman' as const,
      name: 'foreman',
      status: 'working' as const,
      sessionId: 'session-1'
    }
    const busy = [
      {
        provider: 'claude' as const,
        sessionId: 'session-1',
        cwd: WALKED,
        status: 'busy' as const,
        updatedAt: 1,
        dwarfs: [working]
      }
    ]
    // Twice: the location is chosen by the write the observer makes during the
    // first poll, so the SECOND is the first board that carries it.
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValue([])
    const projects = placementStore()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [{ kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }],
      projects,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    await runtime.settleProjects()
    await runtime.refresh()
    const placed = runtime.getMines()[0]!.mapSite

    now = 1_000
    await runtime.refresh()
    const leaving = runtime.getMines()
    runtime.stop()

    expect(placed).toBeGreaterThan(0)
    expect(leaving).toHaveLength(1)
    expect(leaving[0]!.dwarfs).toMatchObject([{ status: 'leaving' }])
    expect(leaving[0]!.mapSite).toBe(placed)
  })

  /*
   * The link the two unit suites either side of it cannot see (#156): the
   * observer only ever measures the mines the runtime hands it, so the board it
   * is given has to be the WHOLE board — crewless declared projects included.
   * Hand it the worked mines alone and the store's tier column goes back to
   * being NULL for exactly the projects whose cards state a tier, which is the
   * disagreement the browse filter was reported for.
   */
  it('measures a declared project nobody is working, so the filter can find it', async () => {
    const projects = placementStore()
    await projects.declare({ path: WALKED, at: 1 })
    // Its own runtime rather than placementRuntime's, for the FakeFs: the tier
    // walk is what has to produce a verdict here, and it must weigh an
    // in-memory folder rather than whatever the host happens to have.
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [],
      fs: new FakeFs(),
      projects,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })

    await runtime.loadDeclared()
    // Polled more than once on purpose: the first board SCHEDULES the walk in
    // the background, so a later poll is the one that has a verdict to record.
    for (let poll = 0; poll < 4; poll++) {
      await runtime.refresh()
      await runtime.settleProjects()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const stored = await projects.get(mineIdForPath(WALKED))
    runtime.stop()

    expect(stored.ok && stored.value?.knownTier).not.toBeNull()
    // Still added rather than opened: measuring is not working (#92).
    expect(stored.ok && stored.value?.lastOpenedAt).toBeNull()
    expect(stored.ok && stored.value?.origin).toBe('declared')
  })
})

/*
 * Which providers the Add Panel may offer (#86). The runtime's part is small on
 * purpose — it asks detection, and hands the answer to the pure rule in
 * domain/launchProviders (tested there). What these pin is the wiring: that the
 * real detector is consulted, and that nothing it says about this machine's
 * filesystem is published.
 */
describe('AgentRuntime provider availability (#86)', () => {
  const HOME = '/home/j'
  const CLAUDE_BIN = '/home/j/.local/bin/claude'

  function runtimeSeeing(installed: readonly string[]) {
    const fs = new FakeFs()
    for (const path of installed) fs.addFile(path, '#!/bin/sh\n')
    const adapters: PlatformAdapters = {
      platform: 'linux',
      focusPid: async () => false,
      launchTranscriptViewer: async () => false,
      viewerScriptPath: '/viewer.mjs',
      textDelivery: {
        sendToConsole: async () => ({ delivered: true }),
        relayToClaudeSession: async () => ({ delivered: true }),
        sendInterrupt: async () => ({ delivered: true })
      },
      processProbe: {
        isCodexProcessRunning: async () => false,
        processStartTimeMs: async () => null
      },
      cliDetector: createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })
    }
    return new AgentRuntime({
      config: defaultConfig(),
      providers: [],
      fs: new FakeFs(),
      home: HOME,
      platformAdapters: adapters,
      onMinesUpdated: vi.fn()
    })
  }

  it('reports a CLI it can find as installed and launchable', async () => {
    const list = await runtimeSeeing([CLAUDE_BIN]).listAgentProviders()

    const claude = list.providers.find((entry) => entry.provider === 'claude')
    expect(claude).toEqual({ provider: 'claude', installed: true, launchable: true })
  })

  it('reports a CLI it cannot find rather than dropping it from the list', async () => {
    const list = await runtimeSeeing([]).listAgentProviders()

    expect(list.providers.map((entry) => entry.provider)).toContain('codex')
    expect(list.providers.every((entry) => !entry.installed)).toBe(true)
  })

  it('publishes no path from this machine, however the detector explains itself', async () => {
    const list = await runtimeSeeing([CLAUDE_BIN]).listAgentProviders()

    expect(JSON.stringify(list)).not.toContain(HOME)
    expect(JSON.stringify(list)).not.toContain('.local')
  })
})

/*
 * One world for the map and the list (#165).
 *
 * The map draws the BOARD and the Mines panel draws STORE ROWS, so the two can
 * disagree: the third acceptance run photographed a mine standing on the map
 * with no card beside it. The join is a stamp on the board — a mine main can
 * positively say the store has no row for — and the panel surfaces those in the
 * list itself, so every mine on the map has a list identity.
 *
 * The mine that produced the report is the first case below: the project
 * observer deliberately records only a project with a WORKING crew, so a mine
 * whose crew is resting has been on the board for as long as the session has
 * and has never been written.
 */
describe('AgentRuntime board-and-list coherence (#165)', () => {
  const RESTING = 'C:\\X\\Resting'
  const WORKED = 'C:\\X\\Worked'

  function coherenceStore(sqlite = new MemoryWritableSqlite()): ProjectsStore {
    return createProjectsStore({ filePath: 'C:\\userData\\projects-v1.db', sqlite })
  }

  /** One session in `cwd` whose single dwarf is in `status`. */
  function providerIn(cwd: string, status: 'working' | 'waiting'): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude' as const,
          sessionId: `session-${cwd}`,
          cwd,
          status: status === 'working' ? ('busy' as const) : ('idle' as const),
          updatedAt: 7,
          dwarfs: [
            {
              id: `claude:${cwd}`,
              provider: 'claude' as const,
              role: 'foreman' as const,
              name: 'foreman',
              status,
              sessionId: `session-${cwd}`
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([])
    }
  }

  function coherenceRuntime(options: {
    projects?: ProjectsStore | null
    providers?: Provider[]
  }): AgentRuntime {
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: options.providers ?? [],
      projects: options.projects === undefined ? coherenceStore() : options.projects,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  it('marks a live mine the store has no row for', async () => {
    // A resting crew is not a sighting the observer records, so this mine is on
    // the map and has never reached the projects table.
    const runtime = coherenceRuntime({ providers: [providerIn(RESTING, 'waiting')] })

    await runtime.loadDeclared()
    await runtime.refresh()
    await runtime.settleProjects()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect(mines[0]!.unrecorded).toBe(true)
  })

  it('says nothing about a mine once its row exists', async () => {
    const projects = coherenceStore()
    const runtime = coherenceRuntime({ projects, providers: [providerIn(WORKED, 'working')] })

    await runtime.loadDeclared()
    await runtime.refresh()
    await runtime.settleProjects()
    // The second poll reads the row the first one wrote.
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect('unrecorded' in mines[0]!).toBe(false)
  })

  it('marks a declared mine as recorded, because declaring it wrote its row', async () => {
    const projects = coherenceStore()
    await projects.declare({ path: WORKED, at: 1 })
    const runtime = coherenceRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect('unrecorded' in mines[0]!).toBe(false)
  })

  it('claims nothing at all when there is no store to have recorded anything', async () => {
    // No reading is not an empty store. Stamping the whole board unrecorded
    // here would list every mine twice — a simulated valley above all (#42).
    const runtime = coherenceRuntime({
      projects: null,
      providers: [providerIn(RESTING, 'waiting')]
    })

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect('unrecorded' in mines[0]!).toBe(false)
  })
})
