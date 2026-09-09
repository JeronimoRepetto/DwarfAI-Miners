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
import {
  MAX_DWARF_TEXT_CHARS,
  PANEL_OBSERVER,
  type Dwarf,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type DwarfStatus,
  type FeedMessage,
  type LaunchFailedPush,
  type ProviderSnapshot
} from '../domain/types'
import type { HookEvent } from '../hooks/hookPayload'
import type { CodexThreadModel } from '../domain/agentModelCatalog'
import type { SessionLauncher } from '../sessionLaunch/launchRunner'
import {
  MODEL_CATALOG_TIMEOUT_MS,
  type ClaudeModelCatalogPort
} from '../sessionLaunch/sdkHeldSession'
import type { AntigravityModelCatalogPort } from '../providers/antigravity/models'
import { nullLedgerStore } from '../ledger/ledgerStore'
import { MaterialLedger } from '../ledger/materialLedger'
import { createCliDetector } from '../platform/cliDetection'
import type { Provider } from '../providers/provider'
import type { PermissionKeystroke } from '../textDelivery/permissionKeys'
import type { HeldSessionSubagentSignal } from '../sessionLaunch/heldCrew'
import type {
  HeldAnswer,
  HeldPermissionAnswer,
  HeldSessionPort,
  HeldSessionStartRequest,
  HeldSessionTelemetryUpdate
} from '../sessionLaunch/heldSession'
import { HeldSessionRegistry } from '../sessionLaunch/heldSessionRegistry'
import { SHELL_METACHARACTER_REFUSAL } from '../sessionLaunch/hostedCommand'
import {
  HostedProcessRegistry,
  type HostedProcessPort,
  type HostedProcessStartRequest
} from '../sessionLaunch/hostedProcesses'
import { createAppDatabase } from '../appDatabase/appDatabase'
import { createSqliteLaunchedSessionStore } from '../sessionLaunch/launchedSessionStore'
import {
  LaunchedSessionRegistry,
  type LaunchedProcess,
  type LaunchFailure
} from '../sessionLaunch/launchedSessions'
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

    it("names a Codex agent's parent thread on the live board, never its id prefix", async () => {
      // #218 on the path the issue measured. A Codex sub-agent is a thread of
      // its own, so its dwarf id is `codex:<uuid>` exactly like a root's — and
      // the launcher used to be read out of that id, which named the literal
      // `codex`, matched no dwarf, and left every spawned agent's prompt under
      // the human's face. The edge the provider now declares says who.
      const codexCrew: Provider = {
        kind: 'codex',
        scan: vi.fn<Provider['scan']>().mockResolvedValue([
          {
            provider: 'codex',
            sessionId: 'thread-p',
            cwd: 'C:\work\project',
            status: 'busy',
            updatedAt: 1,
            dwarfs: [
              {
                id: 'codex:thread-p',
                provider: 'codex',
                role: 'foreman',
                name: 'codex-thread-p',
                status: 'working',
                sessionId: 'thread-p'
              }
            ]
          },
          {
            provider: 'codex',
            sessionId: 'thread-c',
            cwd: 'C:\work\project',
            status: 'busy',
            updatedAt: 1,
            dwarfs: [
              {
                id: 'codex:thread-c',
                provider: 'codex',
                role: 'worker',
                name: 'Bernoulli',
                status: 'working',
                sessionId: 'thread-c',
                parentId: 'codex:thread-p',
                description: '/root/audit_chain_report'
              }
            ]
          }
        ]),
        feed: vi.fn().mockResolvedValue(CREW_FEED)
      }
      const runtime = new AgentRuntime({
        config: defaultConfig(),
        providers: [codexCrew],
        onMinesUpdated: vi.fn()
      })
      await runtime.refresh()

      await expect(runtime.dwarfFeed('codex:thread-c')).resolves.toEqual({
        readable: true,
        messages: [
          {
            role: 'user',
            text: 'survey the seam',
            timestamp: 't0',
            issuer: { role: 'foreman', name: 'codex-thread-p' }
          },
          { role: 'assistant', text: 'On my way.', timestamp: 't1' }
        ]
      })
    })

    /**
     * #192: the poll that first reports a dwarf as leaving is the first that
     * can carry its final reply, so the panel reads once more at that edge.
     * Unlike a send or a kick, a read has nothing unsafe to do to a stale pid,
     * so the runtime must keep answering for a leaving dwarf rather than
     * refusing it the way sendDwarfText does.
     */
    it('still reads the feed of a dwarf that is leaving', async () => {
      const final = [{ role: 'assistant' as const, text: 'Packing up.', timestamp: 't2' }]
      const source: Provider = {
        kind: 'claude',
        scan: vi
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
                  id: 'claude:session-1',
                  provider: 'claude',
                  role: 'worker',
                  name: 'worker',
                  status: 'working',
                  sessionId: 'session-1'
                }
              ]
            }
          ])
          .mockResolvedValue([]),
        feed: vi.fn().mockResolvedValue(final)
      }
      const runtime = new AgentRuntime({
        config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
        providers: [source],
        onMinesUpdated: vi.fn(),
        now: () => 0
      })
      await runtime.refresh()
      await runtime.refresh()
      expect(runtime.getMines().flatMap((mine) => mine.dwarfs)).toMatchObject([
        { id: 'claude:session-1', status: 'leaving' }
      ])

      await expect(runtime.dwarfFeed('claude:session-1')).resolves.toEqual({
        readable: true,
        messages: final
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

/**
 * The renderer telling main which observed dwarf its message panel has open
 * (#196), so a poll that already re-scanned that dwarf's transcript reads its
 * feed in the same pass and carries it with the snapshot — never a second,
 * renderer-driven pull a tick later.
 */
describe('AgentRuntime.watchDwarfFeed (#196)', () => {
  const DWARF_ID = 'claude:session-1'

  function scanWith(transcriptUpdatedAt: number): ProviderSnapshot[] {
    return [
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: transcriptUpdatedAt,
        dwarfs: [
          {
            id: DWARF_ID,
            provider: 'claude',
            role: 'worker',
            name: 'worker',
            status: 'working',
            sessionId: 'session-1',
            transcriptUpdatedAt
          }
        ]
      }
    ]
  }

  it("reads and publishes the watched dwarf's feed the first time its signal is seen", async () => {
    const scan = vi.fn<Provider['scan']>().mockResolvedValue(scanWith(100))
    const feed = vi
      .fn()
      .mockResolvedValue([{ role: 'assistant', text: 'hi', timestamp: 'now' } as FeedMessage])
    const onMinesUpdated = vi.fn()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'claude', scan, feed }],
      onMinesUpdated
    })

    runtime.watchDwarfFeed(DWARF_ID)
    await runtime.refresh()

    expect(feed).toHaveBeenCalledWith(DWARF_ID, 12)
    expect(onMinesUpdated).toHaveBeenCalledTimes(1)
    expect(onMinesUpdated.mock.calls[0]?.[2]).toEqual({
      dwarfId: DWARF_ID,
      feed: { readable: true, messages: [{ role: 'assistant', text: 'hi', timestamp: 'now' }] }
    })
  })

  it('never reads a feed for a dwarf nobody is watching', async () => {
    const scan = vi.fn<Provider['scan']>().mockResolvedValue(scanWith(100))
    const feed = vi.fn().mockResolvedValue([])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'claude', scan, feed }],
      onMinesUpdated: vi.fn()
    })

    await runtime.refresh()

    expect(feed).not.toHaveBeenCalled()
  })

  it("does not re-read once the watched dwarf's signal has stopped moving", async () => {
    const scan = vi.fn<Provider['scan']>().mockResolvedValue(scanWith(100))
    const feed = vi.fn().mockResolvedValue([])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'claude', scan, feed }],
      onMinesUpdated: vi.fn()
    })

    runtime.watchDwarfFeed(DWARF_ID)
    await runtime.refresh()
    expect(feed).toHaveBeenCalledTimes(1)

    // The second poll observes the identical signal, so nothing is re-read.
    await runtime.refresh()
    expect(feed).toHaveBeenCalledTimes(1)
  })

  it('reads again once the signal moves a second time', async () => {
    const scan = vi.fn<Provider['scan']>()
    scan.mockResolvedValueOnce(scanWith(100))
    scan.mockResolvedValueOnce(scanWith(100))
    scan.mockResolvedValueOnce(scanWith(200))
    const feed = vi.fn().mockResolvedValue([])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'claude', scan, feed }],
      onMinesUpdated: vi.fn()
    })

    runtime.watchDwarfFeed(DWARF_ID)
    await runtime.refresh() // 100, first sight: read #1
    await runtime.refresh() // 100 again: no read
    await runtime.refresh() // 200: read #2
    expect(feed).toHaveBeenCalledTimes(2)
  })

  it('carries the feed on a nudge, not only on the ordinary poll', async () => {
    vi.useFakeTimers()
    const scan = vi.fn<Provider['scan']>().mockResolvedValue(scanWith(100))
    const feed = vi
      .fn()
      .mockResolvedValue([{ role: 'assistant', text: 'hi', timestamp: 'now' } as FeedMessage])
    const onMinesUpdated = vi.fn()
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), pollIntervalMs: 60_000 },
      providers: [{ kind: 'claude', scan, feed }],
      // #348: the poll now resolves each session's project off the filesystem,
      // and a tick driven by fake timers must not be waiting on the real disk.
      fs: new FakeFs(),
      onMinesUpdated
    })
    try {
      runtime.watchDwarfFeed(DWARF_ID)
      runtime.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMinesUpdated).toHaveBeenCalledTimes(1)
      expect((onMinesUpdated.mock.calls[0]?.[2] as { dwarfId: string })?.dwarfId).toBe(DWARF_ID)

      scan.mockResolvedValue(scanWith(200))
      runtime.nudge()
      await vi.advanceTimersByTimeAsync(0)
      expect(onMinesUpdated).toHaveBeenCalledTimes(2)
      expect(onMinesUpdated.mock.calls[1]?.[2]).toEqual({
        dwarfId: DWARF_ID,
        feed: { readable: true, messages: [{ role: 'assistant', text: 'hi', timestamp: 'now' }] }
      })
    } finally {
      runtime.stop()
      vi.useRealTimers()
    }
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

  // pasteToConsole is the message tier since #319 (sendToConsole still TYPES,
  // for the permission digit of #203). A fake for both is on the port so a test
  // can assert which one a message reached.
  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      pasteToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true }),
      // AMENDED for #329: the terminal tier ENDS the session now, so a fake
      // port needs the tier the kick actually takes. sendInterrupt stays on it
      // — the permission deny of #203 still presses Esc — and every 'nothing
      // was sent' assertion still reads it.
      endConsoleSession: vi.fn().mockResolvedValue({ delivered: true })
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

  // AMENDED for #319 (was: 'types the message into the console of a
  // terminal-hosted dwarf', which asserted `sendToConsole` was called). A
  // message PASTES now — it reaches `pasteToConsole`, never the typing tier.
  it('pastes the message into the console of a terminal-hosted dwarf', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.pasteToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
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

  // AMENDED for #319: the trimmed text reaches `pasteToConsole` now, the tier a
  // message takes, not `sendToConsole`.
  it('trims the message to the 4000-character limit', async () => {
    const port = fakePort()
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)
    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'x'.repeat(5_000),
      pressEnter: false
    })
    expect(port.pasteToConsole.mock.calls[0]?.[0].text).toHaveLength(4_000)
  })

  // AMENDED for #319: the failing tier is the console PASTE now (`pasteToConsole`),
  // not the typing `sendToConsole`. Same verdict shape, same channel.
  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi
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

  /*
   * AMENDED for #319 (was, under #308: 'falls back to the console when the relay
   * could not be started at all', which asserted the relay was tried first and
   * the console second, verdict `via: 'terminal'`).
   *
   * The two tiers swapped back. The console PASTE is the primary; when it
   * proves it delivered nothing (a window that would not come forward,
   * `neverStarted`), the relay behind it takes the same text. The verdict names
   * the channel that actually delivered, so the ✓ stays honest.
   */
  it('falls back to the relay when the console paste could not focus at all', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The agent terminal could not be brought to the foreground.',
        neverStarted: true
      }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.pasteToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'run the tests'
    })
  })

  /*
   * AMENDED for #319 (was, under #308: 'never touches the console while the
   * relay delivers', which asserted the relay was the primary and
   * `sendToConsole` was never called, verdict `via: 'claude-relay'`).
   *
   * The mirror of that sentence. The console paste is the primary again — it
   * lands the message at once, as the person's own prompt — so a paste that
   * succeeds never reaches for the relay.
   */
  it('never touches the relay while the console paste delivers', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.pasteToConsole).toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /*
   * AMENDED for #319 (was, under #308: 'combines both reasons, relay first, when
   * the console fallback also fails', which asserted
   * `'Relay: …\nConsole fallback: …'` and `via: 'claude-relay'`).
   *
   * Both reasons still travel, one line each, in the order they were tried —
   * which is reversed again: the console paste first, the relay behind it. The
   * verdict names the primary the panel was told about.
   */
  it('combines both reasons, console first, when the relay fallback also fails', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The agent terminal could not be brought to the foreground.',
        neverStarted: true
      }),
      relayToClaudeSession: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The relay could not be started.'
      }),
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
      error:
        'Terminal: The agent terminal could not be brought to the foreground.\n' +
        'Relay fallback: The relay could not be started.'
    })
  })

  // AMENDED for #319: the primary is the console PASTE; a nameless terminal has
  // no relay address to fall back to, so a failed paste stops there.
  it('never falls back for a terminal session that has no relay address', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The agent terminal could not be brought to the foreground.',
        neverStarted: true
      }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The agent terminal could not be brought to the foreground.'
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  // AMENDED for #319: the fallback path is the console paste (`neverStarted`)
  // then the relay behind it. Nothing else changed — it asserted the payload
  // stays out of the log before, and it asserts the same thing now.
  it('keeps the message text out of the log on the fallback path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'nope', neverStarted: true }),
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

  // AMENDED for #319: the tier a message throws from is the console PASTE now.
  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockRejectedValue(new Error('boom')),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  /*
   * AMENDED for #293 (was: 'refuses a leaving dwarf, whose retained pid and
   * session are already stale'). The pid and the session name are still stale
   * and still never touched — what changed is that the person now has a way to
   * say "get this finished worker off the rock", which is a decision about the
   * BOARD and needs no channel at all.
   */
  it('dismisses a leaving dwarf rather than reaching for its stale pid', async () => {
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

  // AMENDED for #319: the message tier is `pasteToConsole` now.
  it('never writes the message content to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' }),
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

  /*
   * AMENDED for #319 (was, under #308: 'relays a named console session on
   * Windows, where the console tier does exist', which asserted the relay was
   * the primary here too, `via: 'claude-relay'`, `sendToConsole` never called).
   *
   * #319 pastes the message at the console again — the primary tier on the one
   * platform that has one. The console defect was the letter-by-letter typing,
   * not the console itself; a paste lands the message at once, as the person's
   * own prompt, so the console wins the primary slot back and the relay is its
   * fallback.
   *
   * The platform is fixed to Windows on purpose: it is the ONE platform where
   * the console tier exists at all, so it is the only place the order differs.
   */
  it('pastes at a named console session on Windows, the console tier primary again', async () => {
    const port = { ...fakePort(), supportsConsoleInput: true }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.pasteToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /*
   * AMENDED for #319 (was, under #308: 'advertises the relay for sending and the
   * console for cancelling on the same dwarf', which asserted
   * `textDelivery: 'claude-relay'` with `sendText: 'claude-relay'`, `cancel:
   * 'terminal'` — the two halves disagreeing).
   *
   * The message pastes at the console now, so both halves are 'terminal' again:
   * the capability the bar reads is the console the send will actually use.
   */
  it('advertises the console for both sending and cancelling on the same dwarf', async () => {
    const port = { ...fakePort(), supportsConsoleInput: true }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    const dwarf = runtime.getMines()[0]!.dwarfs.find((item) => item.id === FOREMAN_ID)
    expect(dwarf?.textDelivery).toBe('terminal')
    expect(dwarf?.capabilities).toMatchObject({ sendText: 'terminal', cancel: 'terminal' })
  })

  it('relays for a session with a name and no console of its own', async () => {
    const port = { ...fakePort(), supportsConsoleInput: true }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  // AMENDED for #319: a nameless console session PASTES too (`pasteToConsole`).
  it('pastes into the console of a session with a pid and no name, its only channel', async () => {
    const port = { ...fakePort(), supportsConsoleInput: true }
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.pasteToConsole).toHaveBeenCalledWith({ pid: 42, text: 'hi', pressEnter: true })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /*
   * AMENDED for #319 (was, under #308: 'does not fall back after a relay that ran
   * and exited non-zero', which gated the console fallback on the RELAY's
   * `neverStarted`). The tiers reversed, so the gate is now on the console
   * PASTE: a paste that RAN and reported a non-zero exit may already have landed
   * — Ctrl+V can put the clipboard into the window before the command fails — so
   * the runtime must not relay the same text behind it. Only a paste that
   * proved it delivered nothing (a window that would not come forward,
   * `neverStarted`) may fall back.
   */
  it('does not fall back to the relay after a paste that ran and reported failure', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The paste keystroke could not be sent to the terminal.'
      }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
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
      error: 'The paste keystroke could not be sent to the terminal.'
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /*
   * AMENDED for #319 (was, under #308: 'does not fall back after a relay that
   * timed out, which may have delivered first'). Same rule, the paste's second
   * failure mode: a paste that THREW may have landed after the throw, so it is
   * not `neverStarted` and the runtime must not relay behind it.
   */
  it('does not fall back to the relay after a paste that threw, which may have landed first', async () => {
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockRejectedValue(new Error('boom mid-paste')),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false, via: 'terminal' })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('has no console to fall back to for a session that never had one', async () => {
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({
        delivered: false,
        error: 'The relay could not be started.',
        neverStarted: true
      }),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'sample-project-70' } },
      port
    )

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'claude-relay',
      error: 'The relay could not be started.'
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime.kickDwarf', () => {
  const FOREMAN_ID = 'claude:session-1'
  const WORKER_ID = 'claude:session-1:agent-9'

  /*
   * AMENDED for the #329 review: the scan reports the pid's VERIFIED creation
   * time beside the pid. A dwarf without one is a dwarf whose pid nothing
   * proved, and the kick refuses to signal it — see the block at the end of
   * this describe, which pins exactly that.
   */
  const VERIFIED_START_MS = 1_788_001_972_136

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
            pid: 42,
            pidStartedAt: VERIFIED_START_MS
          },
          {
            id: WORKER_ID,
            provider: 'claude',
            role: 'worker',
            name: 'Explorer',
            status: 'working',
            sessionId: 'session-1',
            pid: 42,
            pidStartedAt: VERIFIED_START_MS
          }
        ]
      }
    ])
  }

  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true }),
      // AMENDED for #329: the terminal tier ENDS the session now, so a fake
      // port needs the tier the kick actually takes. sendInterrupt stays on it
      // — the permission deny of #203 still presses Esc — and every 'nothing
      // was sent' assertion still reads it.
      endConsoleSession: vi.fn().mockResolvedValue({ delivered: true })
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

  /*
   * AMENDED for #329 (was: 'sends a raw interrupt keystroke to a
   * terminal-hosted dwarf, never typed text', asserting sendInterrupt with the
   * pid). The keystroke was the defect: a session in a terminal TAB cannot be
   * foregrounded on its own, so the Esc reached whichever tab was in front. The
   * tier ends the session's process now — same pid, no window — and the three
   * "nothing else was reached" assertions are unchanged, with the keystroke
   * itself joining them.
   */
  it('ends the session of a terminal-hosted dwarf, pressing nothing at any window', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'terminal'
    })
    expect(port.endConsoleSession).toHaveBeenCalledWith({
      pid: 42,
      expectedStartMs: VERIFIED_START_MS
    })
    expect(port.sendInterrupt).not.toHaveBeenCalled()
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

  /*
   * AMENDED for #293 (was: 'refuses a dwarf whose session type has no cancel
   * channel (Codex, all shapes)', asserting delivered:false with a reason).
   * A kick nothing can carry is no longer a refusal: the person asked for this
   * dwarf to go, so it is dismissed from the board and nothing is sent
   * anywhere. The two "nothing was sent" assertions are the half that matters
   * and they are unchanged.
   */
  it('dismisses a dwarf whose session type has no cancel channel, sending nothing', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    expect(result).toEqual({ delivered: true, via: 'dismiss' })
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
    expect(result).toEqual({ delivered: true, via: 'dismiss' })
    expect(port.sendInterrupt).not.toHaveBeenCalled()

    // The walk ends at once: that walk is what was being dismissed.
    await runtime.refresh()
    expect(runtime.getMines().flatMap((mine) => mine.dwarfs)).toEqual([])
  })

  // AMENDED for #329: the reason now comes off the END the tier performs.
  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'This session could not be ended.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'This session could not be ended.'
    })
  })

  // AMENDED for #329 (was: '...when the interrupt fails...'). The fallback
  // itself is unchanged — see the runtime's own note on why a cancel
  // instruction is still worth trying behind a refused end.
  it('falls back to the relay cancel instruction when the end fails and the session has a name', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'This session could not be ended.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.endConsoleSession).toHaveBeenCalledWith({
      pid: 42,
      expectedStartMs: VERIFIED_START_MS
    })
    // The fallback carries the exact instruction the relay tier already uses —
    // a kick has no user text, only this fixed message.
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
  })

  // AMENDED for #329: the attempt the fallback stands behind is the end.
  it("prefixes the worker's cancel tag on the fallback, same as the relay tier", async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' })
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

  // AMENDED for #329: both reasons still combine, terminal first; the terminal
  // one is a refused end rather than a window that would not come forward.
  it('combines both reasons, terminal first, when the relay fallback also fails', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The relay timed out.' }),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'This session could not be ended.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'Terminal: This session could not be ended.\nRelay fallback: The relay timed out.'
    })
  })

  // AMENDED for #329: same rule, driven by a refused end.
  it('never falls back for a terminal session that has no relay address', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'This session could not be ended.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'This session could not be ended.'
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
    expect(port.endConsoleSession).not.toHaveBeenCalled()
  })

  // AMENDED for #329: the tier that can throw on this path is the end.
  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi.fn().mockRejectedValue(new Error('boom'))
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toMatchObject({
      delivered: false
    })
  })

  /**
   * The half #308 left alone, pinned so the next reordering has to say so.
   *
   * A MESSAGE to this exact dwarf pastes at its console with the relay behind
   * it (#319), and the kick does not share that order: it stays on the terminal
   * tier outright, with no relay in front of it.
   *
   * AMENDED for #329 (was: 'still interrupts at the console of a named session,
   * where the message no longer goes (#308)'). What the tier DOES changed —
   * ending the session rather than pressing Esc — and the reason the old title
   * gave for keeping it at the console is exactly the one the report disproved:
   * an interrupt carries no user text, but a keystroke does land in the wrong
   * window. What this test pins is unchanged: a named session's kick is not
   * routed to the relay.
   */
  it('still acts at the terminal of a named session rather than over its relay (#308)', async () => {
    const port = { ...fakePort(), supportsConsoleInput: true }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' } },
      port
    )

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'terminal'
    })
    expect(port.endConsoleSession).toHaveBeenCalledWith({
      pid: 42,
      expectedStartMs: VERIFIED_START_MS
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })
})

/**
 * Kick ends the session it was pressed on (#329).
 *
 * The terminal tier pressed Esc at a focused window from #24 until here, and
 * the report is what a focused window turned out to be worth: two Claude
 * sessions in two tabs of ONE Windows Terminal window, and the Esc reached the
 * tab that happened to be active rather than the dwarf the person pointed at.
 * A pid cannot be the wrong session, so the act is the tree kill #217 already
 * built — and the pid it is pointed at is the session's OWN, never an ancestor
 * every tab of that window shares.
 */
describe('AgentRuntime.kickDwarf — the terminal tier ends the session (#329)', () => {
  const DWARF_ID = 'claude:session-1'
  const SESSION_PID = 4242
  /** The pid's creation time, as the provider verified it against the machine. */
  const VERIFIED_START_MS = 1_788_001_972_136

  /**
   * The tree measured live, as a table a test can assert against: two sessions
   * in two tabs, so every process ABOVE either of them is shared. Ending one of
   * those ancestors would take both tabs — and the terminal window with them.
   */
  const PROCESS_TABLE = [
    { pid: SESSION_PID, parentPid: 3131, name: 'claude.exe' },
    { pid: 5252, parentPid: 3132, name: 'claude.exe' },
    { pid: 3131, parentPid: 2020, name: 'cmd.exe' },
    { pid: 3132, parentPid: 2020, name: 'cmd.exe' },
    { pid: 2020, parentPid: 1010, name: 'WindowsTerminal.exe' },
    { pid: 1010, parentPid: 1, name: 'conhost.exe' },
    { pid: 1, parentPid: 0, name: 'bash' }
  ]

  /** Every pid in that table that is NOT the kicked session's own process. */
  function othersInTheTable(): number[] {
    return PROCESS_TABLE.filter((process) => process.pid !== SESSION_PID).map(
      (process) => process.pid
    )
  }

  /** Every keystroke tier is a bare spy: reaching one at all would be the defect. */
  function terminalPort(endConsoleSession = vi.fn().mockResolvedValue({ delivered: true })) {
    return {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn(),
      endConsoleSession
    } satisfies TextDeliveryPort
  }

  /**
   * `verified: false` is the dwarf whose pid the provider could NOT prove — no
   * procStart in the registry, no probe wired, a probe that would not answer.
   * It is on the board exactly like any other (a pid-reuse guard must not hide
   * a live session) and carries no creation time.
   */
  function scanOf(verified = true) {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: DWARF_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working' as const,
            sessionId: 'session-1',
            pid: SESSION_PID,
            ...(verified ? { pidStartedAt: VERIFIED_START_MS } : {})
          }
        ]
      }
    ])
  }

  async function runtimeWith(
    port: TextDeliveryPort,
    target: TextDeliveryTarget = { kind: 'terminal', pid: SESSION_PID },
    verified = true
  ) {
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [
        {
          kind: 'claude',
          scan: scanOf(verified),
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: () => target
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => now
    })
    await runtime.refresh()
    return { runtime, advance: (ms: number) => (now += ms) }
  }

  it("ends the session's own process and never an ancestor every tab shares", async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port)

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'terminal'
    })
    expect(port.endConsoleSession).toHaveBeenCalledWith({
      pid: SESSION_PID,
      expectedStartMs: VERIFIED_START_MS
    })
    // The pid the provider reported, and nothing derived from it: no walk, so
    // cmd.exe, WindowsTerminal.exe, conhost.exe and the root are unreachable
    // from here even by accident.
    const ended = port.endConsoleSession.mock.calls.map((call) => call[0]?.pid)
    for (const other of othersInTheTable()) expect(ended).not.toContain(other)
  })

  it('presses nothing at any window, so no other tab can notice', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port)

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(port.sendInterrupt).not.toHaveBeenCalled()
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /*
   * The provider goes on reporting a session its own liveness window has not
   * given up on yet — this scan reports it 'working' forever — so without this
   * the dwarf would stand on the rock after its process was gone. Retired
   * through #46's path rather than #293's dismissal, and the scan above is why:
   * a dismissal lifts on a 'working' status, which is exactly what a session
   * kicked mid-turn was last reported as. Ending the process is the observed
   * stop #46 asks for, made rather than watched for.
   */
  it('starts the walk at once instead of waiting out the provider liveness window', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port)

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    await runtime.refresh()

    const dwarfs = runtime.getMines().flatMap((mine) => mine.dwarfs)
    expect(dwarfs.map((dwarf) => dwarf.status)).toEqual(['leaving'])
  })

  it('leaves the dwarf exactly where it was when the end was refused', async () => {
    const port = terminalPort(
      vi.fn().mockResolvedValue({ delivered: false, error: 'Access is denied.' })
    )
    const { runtime } = await runtimeWith(port)

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toMatchObject({
      delivered: false
    })
    await runtime.refresh()
    expect(runtime.getMines().flatMap((dwarf) => dwarf.dwarfs)[0]?.status).toBe('working')
  })

  /*
   * The relay fallback #24 built is kept for a refused end, and it is the only
   * second tier this path has ever had. Weaker than what was asked for — a
   * cancel instruction, not an exit — but it is the difference between a person
   * being told nothing happened and something being tried.
   */
  it('falls back to the relay cancel instruction when the end is refused and the session has a name', async () => {
    const port = terminalPort(
      vi.fn().mockResolvedValue({ delivered: false, error: 'Access is denied.' })
    )
    const { runtime } = await runtimeWith(port, {
      kind: 'terminal',
      pid: SESSION_PID,
      sessionName: 'sample-project-70'
    })

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
  })

  it('refuses with a reason on a port that implements no end tier at all', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith(port)

    const result = await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(result).toMatchObject({ delivered: false, via: 'terminal' })
    expect(result.error).toBeTruthy()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  /*
   * A pid is a number the OS recycles, and this app owns a tree kill: signalling
   * a remembered number is how an unrelated process gets killed (#231). The
   * provider stamps `pidStartedAt` only where probing the pid AGREED with the
   * registry's record of when that process was created, so its absence is a
   * verdict of 'unknown' — no procStart, no probe wired, a probe that would not
   * answer — and unknown is a refusal here, not a permission.
   *
   * The asymmetry with liveness is the point. There an unknown keeps the dwarf,
   * because a wrong "dead" only hides one. Here an unknown kills nothing,
   * because a wrong kill cannot be taken back.
   */
  it('ends nothing for a dwarf whose pid the provider could not verify', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port, { kind: 'terminal', pid: SESSION_PID }, false)

    const result = await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(result).toMatchObject({ delivered: false, via: 'terminal' })
    expect(result.error).toMatch(/could not be verified/i)
    expect(port.endConsoleSession).not.toHaveBeenCalled()
  })

  it('keeps that dwarf on the rock, since an unverified pid is not a dead session', async () => {
    const { runtime } = await runtimeWith(
      terminalPort(),
      { kind: 'terminal', pid: SESSION_PID },
      false
    )

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    await runtime.refresh()
    expect(runtime.getMines().flatMap((mine) => mine.dwarfs)[0]?.status).toBe('working')
  })

  it('still relays the cancel instruction behind an unverified pid, where the session has a name', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(
      port,
      { kind: 'terminal', pid: SESSION_PID, sessionName: 'sample-project-70' },
      false
    )

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.endConsoleSession).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'sample-project-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
  })

  /*
   * A worker's kick resolves through its foreman, so the dwarf that was pointed
   * at and the pid that would be signalled need not belong to one session. A
   * start time measured for another process is no proof of this one, so the
   * pids must agree before the reading is used at all.
   */
  it('refuses when the endpoint names a pid this dwarf did not report', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port, { kind: 'terminal', pid: SESSION_PID + 1 })

    const result = await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(result).toMatchObject({ delivered: false, via: 'terminal' })
    expect(port.endConsoleSession).not.toHaveBeenCalled()
  })

  /*
   * A second kick lands on a dwarf that is already walking out, which is the
   * dismissal #293 made it — never a second tree kill, and never an escalation.
   */
  it('dismisses a second kick on the dwarf now walking out, rather than ending twice', async () => {
    const port = terminalPort()
    const { runtime } = await runtimeWith(port)

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    await runtime.refresh()
    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'dismiss'
    })
    expect(port.endConsoleSession).toHaveBeenCalledTimes(1)
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

  /**
   * `dwarfStatus` was added for #293 and defaults to the mid-turn thread every
   * caller before it wanted: the dismissal rule turns on whether a turn is
   * open, so its own cases need a thread sitting at its prompt.
   */
  async function runtimeWithQueue(port: TextDeliveryPort, dwarfStatus: DwarfStatus = 'working') {
    const source: Provider = {
      kind: 'codex',
      scan: vi.fn<Provider['scan']>().mockResolvedValue([
        {
          provider: 'codex',
          sessionId: THREAD_ID,
          cwd: 'C:\\work\\project',
          status: dwarfStatus === 'working' ? 'busy' : 'idle',
          updatedAt: 1,
          dwarfs: [
            {
              id: DWARF_ID,
              provider: 'codex',
              role: 'worker',
              name: 'codex-01a04d79',
              status: dwarfStatus,
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

  /*
   * AMENDED for #293 (was: 'refuses a kick outright rather than queueing one
   * that could never interrupt'). Never queueing the kick is the rule #97
   * established and it still holds — a queued interrupt drains after the turn
   * it was meant to stop. What the person gets instead is no longer nothing:
   * the thread they are done with leaves the board.
   */
  it('dismisses the dwarf rather than queueing a kick that could never interrupt', async () => {
    const port = queuePort()
    const runtime = await runtimeWithQueue(port)

    const result = await runtime.kickDwarf({ dwarfId: DWARF_ID })
    expect(result).toEqual({ delivered: true, via: 'dismiss' })
    expect(port.queueToCodexThread).not.toHaveBeenCalled()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  /*
   * The board half of the same act, end to end (#293): the provider goes on
   * reporting an idle Codex thread for its whole retention window, and the
   * dismissal has to outlast that belief or the dwarf flickers back on the
   * very next poll.
   */
  it('keeps a dismissed thread at its prompt off the board while the provider reports it', async () => {
    const runtime = await runtimeWithQueue(queuePort(), 'waiting')

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    // It walks out first, exactly as a retirement does.
    await runtime.refresh()
    expect(runtime.getMines().flatMap((mine) => mine.dwarfs)).toMatchObject([
      { id: DWARF_ID, status: 'leaving' }
    ])

    // And never comes back on, however long the provider goes on listing the
    // thread — the flicker-back this record exists to stop. It is still
    // walking rather than gone only because the leave grace is wall-clock and
    // this fixture takes no injected clock; lifecycle.test.ts owns the expiry.
    for (let i = 0; i < 4; i++) await runtime.refresh()
    expect(runtime.getMines().flatMap((mine) => mine.dwarfs)).toMatchObject([
      { id: DWARF_ID, status: 'leaving' }
    ])
  })

  /*
   * The limit of the dismissal, and it is #46's own rule rather than a hole in
   * this one: a thread whose turn is open is RUNNING, and an agent hidden while
   * it runs is the very lie the board must never tell. So a dismissal of a
   * mid-turn thread is undone by the next poll that still sees the turn.
   */
  it('brings a dismissed thread straight back while its turn is still open', async () => {
    const runtime = await runtimeWithQueue(queuePort())

    await runtime.kickDwarf({ dwarfId: DWARF_ID })
    await runtime.refresh()
    expect(runtime.getMines().flatMap((mine) => mine.dwarfs)).toMatchObject([
      { id: DWARF_ID, status: 'working' }
    ])
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

/*
 * The dead end #217 reported: a Codex session started from the panel could not
 * be messaged, interrupted or killed, so the app offered no exit from a process
 * the person had started in it.
 *
 * `codex exec` tags its thread source='exec' rather than 'cli', so the queue
 * gate refuses it (correctly — it exits with its turn, and a queue nothing
 * drains is the exit-0-shaped lie), and the provider therefore reports NO
 * channel at all. What is added is the one channel that does not need the
 * session to cooperate: the panel started that process and still holds it.
 */
describe('AgentRuntime ending a session it launched (#217)', () => {
  const MINE_PATH = 'C:\\work\\project'
  const THREAD_ID = 'thread-launched'
  const DWARF_ID = `codex:${THREAD_ID}`

  /** A Codex session with no channel of its own: an exec thread is not queue-reachable. */
  function execProvider(sessionId = THREAD_ID): Provider {
    return {
      kind: 'codex',
      scan: vi.fn<Provider['scan']>().mockResolvedValue([
        {
          provider: 'codex',
          sessionId,
          cwd: MINE_PATH,
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: `codex:${sessionId}`,
              provider: 'codex',
              role: 'worker',
              name: 'codex-01a04d79',
              status: 'working',
              sessionId
            }
          ]
        }
      ]),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: () => null
    }
  }

  function retained(pid = 4242): { process: LaunchedProcess; exit: () => void } {
    const listeners: Array<() => void> = []
    return {
      process: {
        pid,
        onExit(listener) {
          listeners.push(listener)
        }
      },
      exit: () => {
        for (const listener of listeners) listener()
      }
    }
  }

  async function runtimeWithLaunch(
    options: {
      endProcessTree?: (pid: number) => Promise<boolean>
      process?: LaunchedProcess
      knownSessionIds?: string[]
      provider?: Provider
    } = {}
  ) {
    const endProcessTree = options.endProcessTree ?? vi.fn().mockResolvedValue(true)
    const launched = new LaunchedSessionRegistry({ endProcessTree })
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [options.provider ?? execProvider()],
      launchedSessions: launched,
      onMinesUpdated: vi.fn()
    })
    launched.retain({
      provider: 'codex',
      minePath: MINE_PATH,
      process: options.process ?? retained().process,
      knownSessionIds: options.knownSessionIds ?? []
    })
    await runtime.refresh()
    return { runtime, launched, endProcessTree }
  }

  it('ends the process tree of the session it launched, instead of refusing for want of a channel', async () => {
    const { runtime, endProcessTree } = await runtimeWithLaunch()

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'launched-process'
    })
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * The composer stays disabled, and that is the right behaviour with the
   * right reason at last: the queue is NOT widened to admit an exec thread,
   * because `codex exec` has exited by the time anything could drain one.
   */
  it('offers a cancel and no send channel on the dwarf it launched', async () => {
    const { runtime } = await runtimeWithLaunch()
    const dwarf = runtime.getMines()[0]?.dwarfs[0]

    expect(dwarf?.textDelivery).toBeUndefined()
    expect(dwarf?.capabilities).toEqual({
      sendText: null,
      cancel: 'launched-process',
      adjustEffort: null
    })
  })

  it('refuses a message for it with the launch shape as the reason, not the generic one', async () => {
    const { runtime } = await runtimeWithLaunch()

    const result = await runtime.sendDwarfText({
      dwarfId: DWARF_ID,
      text: 'run the tests',
      pressEnter: true
    })
    expect(result.delivered).toBe(false)
    expect(result.via).toBe('none')
    expect(result.error).toBe(
      'That session takes no messages: it was launched with a single prompt and exits with its turn.'
    )
  })

  /*
   * The pid-reuse guard, end to end: once that process has gone its number can
   * belong to anything on this machine, so nothing is signalled and the panel
   * is told the session had already ended.
   */
  it('signals nothing and says so when the process has already gone', async () => {
    const handle = retained()
    const { runtime, endProcessTree } = await runtimeWithLaunch({ process: handle.process })
    handle.exit()

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: false,
      via: 'launched-process',
      error: 'That session has already ended.'
    })
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('never reports a session ended that the platform refused to end', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(false)
    const { runtime } = await runtimeWithLaunch({ endProcessTree })

    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: false,
      via: 'launched-process',
      error: 'That session could not be ended.'
    })
  })

  /*
   * A session that was already on the board when the launch happened is
   * somebody else's, and ending somebody else's process is the one mistake
   * this whole binding exists to avoid. The dwarf keeps the dead end it had.
   */
  it('offers no exit for a session it did not start', async () => {
    const { runtime } = await runtimeWithLaunch({ knownSessionIds: [THREAD_ID] })

    // No matrix at all and every field null mean the same thing here — see
    // DwarfCapabilities — and what is being asserted is "no cancel channel".
    expect(runtime.getMines()[0]?.dwarfs[0]?.capabilities?.cancel ?? null).toBeNull()
    // AMENDED for #293 (was: delivered:false, via:'none'). No exit is still no
    // exit — nobody else's process is ended — and the kick now takes the dwarf
    // off the board instead of answering with nothing.
    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'dismiss'
    })
  })

  /*
   * What the panel is told is unchanged: a process started. The pid it started
   * is main's business, and the runtime is what keeps it — reported by the
   * launcher rather than kept behind it, because deciding whether to keep it
   * needs the board.
   */
  it('keeps what the launcher started, and keeps it off the wire', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const handle = retained(777)
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex', retained: handle.process })
    // One session in the mine to begin with — so there is a mine to launch
    // into — and the launched one appearing on the poll after, exactly as the
    // real thing arrives: through Codex's own storage, up to a poll later.
    function snapshot(sessionId: string) {
      return {
        provider: 'codex' as const,
        sessionId,
        cwd: MINE_PATH,
        status: 'idle' as const,
        updatedAt: 1,
        dwarfs: [
          {
            id: `codex:${sessionId}`,
            provider: 'codex' as const,
            role: 'worker' as const,
            name: sessionId,
            status: 'waiting' as const,
            sessionId
          }
        ]
      }
    }
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([snapshot('was-here-first')])
      .mockResolvedValue([snapshot('was-here-first'), snapshot(THREAD_ID)])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [
        { kind: 'codex', scan, feed: vi.fn().mockResolvedValue([]), textDelivery: () => null }
      ],
      launchSession,
      launchedSessions: new LaunchedSessionRegistry({ endProcessTree }),
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    const mineId = runtime.getMines()[0]!.id

    // Nothing about the PROCESS crosses the wire — no pid, and not this
    // register's own launch id either.
    //
    // AMENDED for #191: the verdict now carries a receipt, which is a
    // different id for a different job. It names the launch so the panel can
    // recognise the dwarf that comes back carrying it (`receipt:…`), and it is
    // deliberately not the kill register's handle (`launch:…`) — that one
    // exists only where a pid was retained, and it is the thing this test is
    // about keeping off the wire.
    await expect(
      runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })
    ).resolves.toEqual({
      launched: true,
      provider: 'codex',
      launchId: expect.stringMatching(/^receipt:/)
    })

    await runtime.refresh()
    const dwarfs = runtime.getMines()[0]!.dwarfs
    // The session that was there before the launch keeps its dead end...
    expect(
      dwarfs.find((dwarf) => dwarf.sessionId === 'was-here-first')?.capabilities?.cancel ?? null
    ).toBeNull()
    // ...and the one that arrived after it is the one this panel can end.
    expect(dwarfs.find((dwarf) => dwarf.sessionId === THREAD_ID)?.capabilities?.cancel).toBe(
      'launched-process'
    )
    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toMatchObject({
      delivered: true,
      via: 'launched-process'
    })
    expect(endProcessTree).toHaveBeenCalledWith(777)
  })

  it('logs the channel and the verdict, and never a message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { runtime } = await runtimeWithLaunch()
      await runtime.kickDwarf({ dwarfId: DWARF_ID })
      const lines = log.mock.calls.map((call) => String(call[0])).join('\n')
      expect(lines).toContain('launched-process')
      expect(lines).toContain('delivered')
    } finally {
      log.mockRestore()
    }
  })
})

/*
 * #231: the register #217 added lives in memory, so a session launched before
 * the panel restarted had no exit — its dwarf was drawn, nothing was offered,
 * and the generic no-channel reason read like a bug.
 *
 * Two runtimes over ONE in-memory database stand in for the two runs, which is
 * the whole subject: the second one has never seen the launch and has only the
 * row to go on, so what it does with that row is the fix.
 */
describe('AgentRuntime giving a previous run’s launch its exit back (#231)', () => {
  const MINE_PATH = 'C:\\work\\project'
  const THREAD_ID = 'thread-launched'
  const DWARF_ID = `codex:${THREAD_ID}`
  const LAUNCHED_PID = 777
  const PROC_START = 1_788_001_972_136

  function launchAdapters(processStartTimeMs: number | null): {
    adapters: PlatformAdapters
    endProcessTree: ReturnType<typeof vi.fn>
  } {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    return {
      endProcessTree,
      adapters: {
        platform: 'win32',
        focusPid: vi.fn().mockResolvedValue(false),
        launchTranscriptViewer: vi.fn().mockResolvedValue(false),
        viewerScriptPath: 'C:\\viewer.mjs',
        textDelivery: {
          sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
          relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
          sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
        },
        processProbe: {
          isCodexProcessRunning: vi.fn().mockResolvedValue(false),
          processStartTimeMs: vi.fn().mockResolvedValue(processStartTimeMs)
        },
        processEnd: { endProcessTree },
        cliDetector: {
          detect: vi.fn().mockResolvedValue({ cli: 'codex', installed: false }),
          peek: vi.fn().mockReturnValue('unprobed')
        }
      }
    }
  }

  const APP_DB = 'C:\\userData\\projects-v1.db'

  /** One Codex session with no channel of its own, exactly as an exec thread is. */
  function snapshot(sessionId: string) {
    return {
      provider: 'codex' as const,
      sessionId,
      cwd: MINE_PATH,
      status: 'busy' as const,
      updatedAt: 1,
      dwarfs: [
        {
          id: `codex:${sessionId}`,
          provider: 'codex' as const,
          role: 'worker' as const,
          name: sessionId,
          status: 'working' as const,
          sessionId
        }
      ]
    }
  }

  function execProvider(scan: Provider['scan']): Provider {
    return { kind: 'codex', scan, feed: vi.fn().mockResolvedValue([]), textDelivery: () => null }
  }

  function launchStore(sqlite: MemoryWritableSqlite) {
    return createSqliteLaunchedSessionStore({
      database: createAppDatabase({ filePath: APP_DB, sqlite })
    })
  }

  /** The run that starts the session and writes the register down. */
  async function firstRun(sqlite: MemoryWritableSqlite): Promise<void> {
    const { adapters } = launchAdapters(PROC_START)
    // One session in the mine first, so there is a mine to launch into, then
    // the launched one arriving on the poll after — the real arrival shape.
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([snapshot('was-here-first')])
      .mockResolvedValue([snapshot('was-here-first'), snapshot(THREAD_ID)])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [execProvider(scan)],
      platformAdapters: adapters,
      launchedSessionStore: launchStore(sqlite),
      launchSession: vi.fn().mockResolvedValue({
        launched: true,
        provider: 'codex',
        retained: { pid: LAUNCHED_PID, onExit: () => {} } satisfies LaunchedProcess
      }),
      projects: null,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    const mineId = runtime.getMines()[0]!.id
    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })
    await runtime.refresh()
    await runtime.settleLaunchedSessions()
  }

  /** The run after the restart: it has only the row. */
  async function secondRun(sqlite: MemoryWritableSqlite, probed: number | null) {
    const { adapters, endProcessTree } = launchAdapters(probed)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [
        execProvider(
          vi
            .fn<Provider['scan']>()
            .mockResolvedValue([snapshot('was-here-first'), snapshot(THREAD_ID)])
        )
      ],
      platformAdapters: adapters,
      launchedSessionStore: launchStore(sqlite),
      projects: null,
      onMinesUpdated: vi.fn()
    })
    await runtime.restoreLaunchedSessions()
    await runtime.refresh()
    return { runtime, endProcessTree }
  }

  function dwarfOf(runtime: AgentRuntime, sessionId: string): Dwarf | undefined {
    return runtime
      .getMines()
      .flatMap((mine) => mine.dwarfs)
      .find((dwarf) => dwarf.sessionId === sessionId)
  }

  it('offers the exit again when the machine still shows the process it started', async () => {
    const sqlite = new MemoryWritableSqlite()
    await firstRun(sqlite)

    const { runtime, endProcessTree } = await secondRun(sqlite, PROC_START)

    expect(dwarfOf(runtime, THREAD_ID)?.capabilities?.cancel).toBe('launched-process')
    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toMatchObject({
      delivered: true,
      via: 'launched-process'
    })
    expect(endProcessTree).toHaveBeenCalledWith(LAUNCHED_PID)
  })

  /*
   * The mistake the whole design exists to avoid: that pid is live and belongs
   * to something else, so no exit is offered and nothing is signalled.
   */
  it('offers no exit, and signals nothing, when that pid is now a different process', async () => {
    const sqlite = new MemoryWritableSqlite()
    await firstRun(sqlite)

    const { runtime, endProcessTree } = await secondRun(sqlite, PROC_START + 3_600_000)

    expect(dwarfOf(runtime, THREAD_ID)?.capabilities?.cancel ?? null).toBeNull()
    // AMENDED for #293 (was: delivered:false, via:'none'). The assertion that
    // carries the whole design is the last one, and it is untouched: nothing is
    // signalled. A dismissal is a decision about the board, so it cannot reach
    // a process at all, whoever owns that pid now.
    await expect(runtime.kickDwarf({ dwarfId: DWARF_ID })).resolves.toEqual({
      delivered: true,
      via: 'dismiss'
    })
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('offers no exit when nothing on the machine can be asked about that pid', async () => {
    const sqlite = new MemoryWritableSqlite()
    await firstRun(sqlite)

    const { runtime, endProcessTree } = await secondRun(sqlite, null)

    expect(dwarfOf(runtime, THREAD_ID)?.capabilities?.cancel ?? null).toBeNull()
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * A session this panel never started keeps the dead end it always had, and
   * that is what a restored register must not widen: re-adoption binds one
   * session id, never every dwarf in the folder.
   */
  it('gives the session it never started nothing, restored register or not', async () => {
    const sqlite = new MemoryWritableSqlite()
    await firstRun(sqlite)

    const { runtime } = await secondRun(sqlite, PROC_START)

    expect(dwarfOf(runtime, 'was-here-first')?.capabilities?.cancel ?? null).toBeNull()
  })

  it('keeps nothing at all when this build was given no register to keep it in', async () => {
    // index.ts hands null when the database will not open, exactly as it does
    // for the projects store. The in-run exit is unaffected; only the restart
    // half goes, which is #217's behaviour and not a failure.
    const sqlite = new MemoryWritableSqlite()
    const { adapters } = launchAdapters(PROC_START)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [execProvider(vi.fn<Provider['scan']>().mockResolvedValue([snapshot(THREAD_ID)]))],
      platformAdapters: adapters,
      launchedSessionStore: null,
      launchSession: vi.fn().mockResolvedValue({
        launched: true,
        provider: 'codex',
        retained: { pid: LAUNCHED_PID, onExit: () => {} } satisfies LaunchedProcess
      }),
      projects: null,
      onMinesUpdated: vi.fn()
    })
    await runtime.restoreLaunchedSessions()
    await runtime.refresh()
    await runtime.settleLaunchedSessions()

    await expect(launchStore(sqlite).list()).resolves.toEqual([])
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
      // #348: as above — no real disk inside a tick driven by fake timers.
      fs: new FakeFs(),
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
      // #348: as above — no real disk inside a tick driven by fake timers.
      fs: new FakeFs(),
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
  /** AMENDED for the #329 review: a kick may only end a pid the provider verified. */
  const VERIFIED_START_MS = 1_788_001_972_136

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
            pid: 42,
            pidStartedAt: VERIFIED_START_MS
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

  // AMENDED for #319: the console tier a message measures is the PASTE now.
  it('logs the stages the console tier measured, alongside the verdict', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockImplementation(async () => {
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

  /*
   * AMENDED for #329: a kick's terminal tier is an END now, and it has no focus
   * stage to fold in — there is no window in the act at all. The stage it does
   * report is its own `spawn`, and the absorbed-stages rule this pins is
   * unchanged.
   */
  it('instruments a kick exactly like a message', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn(),
      endConsoleSession: vi.fn().mockImplementation(async () => {
        clock.value += 20
        return { delivered: true, stages: { spawnMs: 12 } }
      })
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime({ kind: 'terminal', pid: 42 }, port, clock)
    const logged = captureLog()

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    const line = logged.lines().find((entry) => entry.includes('Kick for')) ?? ''
    expect(line).toContain('spawn=12ms')
    expect(line).toContain('total=20ms')
    logged.restore()
  })

  // AMENDED for #319: a failed message attempt is a failed PASTE now.
  it('times a failed attempt too — the slow ones are the ones worth measuring', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockImplementation(async () => {
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

  /*
   * AMENDED for #308 (was: the same assertions driven by
   * `sendDwarfText` on a named console target — a MESSAGE has no relay
   * fallback any more, because the relay is now its FIRST tier). The relay
   * fallback itself is unchanged and still belongs to the kick, which keeps
   * #24's order, so the attempt this measures is driven by `kickDwarf` now.
   */
  it('instruments the relay fallback as its own attempt', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn().mockImplementation(async () => {
        clock.value += 3_000
        return { delivered: true }
      }),
      sendInterrupt: vi.fn().mockImplementation(async () => {
        clock.value += 40
        return { delivered: false, error: 'nope', stages: { focusMs: 40 } }
      })
    } satisfies TextDeliveryPort
    const runtime = await instrumentedRuntime(
      { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' },
      port,
      clock
    )
    const logged = captureLog()

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    const fallbackLine = logged.lines().find((entry) => entry.includes('Relay fallback')) ?? ''
    expect(fallbackLine).toContain('relay=3000ms')
    expect(fallbackLine).toContain('total=3000ms')
    logged.restore()
  })

  /*
   * AMENDED for #319 (was, under #308: 'instruments the console fallback of a
   * message as its own attempt too', which drove a console fallback behind a
   * relay that never started). The tiers reversed: a message's fallback is the
   * RELAY behind a console paste that could not focus (`neverStarted`), and it
   * is timed as its own attempt just as the kick's relay fallback is.
   */
  it('instruments the relay fallback of a message as its own attempt too', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockImplementation(async () => {
        clock.value += 40
        return { delivered: false, error: 'nope', neverStarted: true, stages: { focusMs: 40 } }
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
    expect(fallbackLine).toContain('delivered')
    logged.restore()
  })

  // AMENDED for #319: a message is measured on the PASTE tier now.
  it('never lets the message anywhere near the instrumentation line', async () => {
    const clock = { value: 0 }
    const port = {
      sendToConsole: vi.fn(),
      pasteToConsole: vi.fn().mockResolvedValue({
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
 *
 * AMENDED for #329, and narrowed rather than dropped. Three tiers now end the
 * session on the first press: a process this panel launched (#217), one it is
 * holding (#194), and one in somebody's own terminal — the last because the
 * polite act there was a keystroke aimed at a window, and the window turned out
 * to be another session's as often as not. What survives is the half that was
 * always the point: NOTHING escalates. A second kick repeats the same act with
 * the same argument, and no tier has a harder second gear behind it.
 */
describe('AgentRuntime kick escalation policy', () => {
  const FOREMAN_ID = 'claude:session-1'
  const HARSH = /kill|terminate|force|sigkill|taskkill|destroy/i
  /** AMENDED for the #329 review: a kick may only end a pid the provider verified. */
  const VERIFIED_START_MS = 1_788_001_972_136

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
            pid: 42,
            pidStartedAt: VERIFIED_START_MS
          }
        ]
      }
    ])
  }

  async function kickRuntime(target: TextDeliveryTarget) {
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true }),
      // AMENDED for #329: the terminal tier ENDS the session now, so a fake
      // port needs the tier the kick actually takes. sendInterrupt stays on it
      // — the permission deny of #203 still presses Esc — and every 'nothing
      // was sent' assertion still reads it.
      endConsoleSession: vi.fn().mockResolvedValue({ delivered: true })
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

  /*
   * AMENDED for #329 and again for its review: the request the terminal tier
   * carries is the end's, and it names the session's own pid plus the creation
   * time that pid must still have. Two fields, both about identifying ONE
   * process — still nothing that could turn an act into a harder one.
   */
  it('carries nothing but the pid and its proof — there is no escalation dial to turn', async () => {
    const { runtime, port } = await kickRuntime({ kind: 'terminal', pid: 42 })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    expect(port.endConsoleSession).toHaveBeenCalledWith({
      pid: 42,
      expectedStartMs: VERIFIED_START_MS
    })
    expect(Object.keys(port.endConsoleSession.mock.calls[0]?.[0] ?? {})).toEqual([
      'pid',
      'expectedStartMs'
    ])
  })

  /*
   * AMENDED for #329 (was: 'repeats the identical polite interrupt on a second
   * kick'). A terminal kick is no longer polite: it ends the session on the
   * FIRST press, because a keystroke aimed at that session could not be
   * delivered to it at all. What the invariant this describe exists for still
   * forbids is unchanged and is what this asserts — a repeat is the same act
   * with the same argument, never a harder one.
   */
  it('repeats the identical act on a second kick, never a harder one', async () => {
    const { runtime, port } = await kickRuntime({ kind: 'terminal', pid: 42 })

    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    await runtime.kickDwarf({ dwarfId: FOREMAN_ID })

    const call = { pid: 42, expectedStartMs: VERIFIED_START_MS }
    expect(port.endConsoleSession.mock.calls).toEqual([[call], [call], [call]])
    expect(port.sendInterrupt).not.toHaveBeenCalled()
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
  const VAULT_PROJECT = 'C:\work\project'

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
      // Added by #217. A fake that never ends anything: no test here may end a
      // real process tree.
      processEnd: { endProcessTree: vi.fn().mockResolvedValue(false) },
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
      provider: 'claude',
      // AMENDED for #191. The verdict still claims no dwarf — the id below is
      // the LAUNCH's, opened so the panel can recognise the dwarf that comes
      // back carrying it — so the claim this test makes is unchanged.
      launchId: expect.any(String)
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

  /*
   * #239. The request may now name a model and an effort, and both have to
   * reach the launcher: this is the one hop between the IPC boundary (which
   * checked them) and the engine (which spends them). Absent means absent,
   * exactly as an untuned launch always read.
   */
  it('forwards a model and an effort the request named, down to the launcher', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({
      mineId,
      provider: 'claude',
      prompt: 'go',
      model: 'sonnet',
      effort: 'xhigh'
    })

    expect(launchSession).toHaveBeenCalledWith({
      provider: 'claude',
      minePath: 'C:\\work\\project',
      prompt: 'go',
      model: 'sonnet',
      effort: 'xhigh'
    })
  })

  it('leaves model and effort off the launcher call when the request named neither', async () => {
    const launchSession = vi.fn().mockResolvedValue({ launched: true, provider: 'claude' })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({ mineId, provider: 'claude', prompt: 'go' })

    expect('model' in launchSession.mock.calls[0]![0]).toBe(false)
    expect('effort' in launchSession.mock.calls[0]![0]).toBe(false)
  })
})

/*
 * The failure channel half of #263. `agent:launch` answers `launched: true`
 * the moment `spawn` succeeds, honestly — but a `codex exec` that then dies
 * at once (a concurrent instance already holding its lock, a flag it does
 * not recognise) used to leave the panel with nothing: stderr discarded, the
 * exit code never read. `LaunchedProcess.onEarlyFailure` is where the runner
 * reports that now; this is the runtime wiring it into a push and a log line.
 */
describe('AgentRuntime reporting a launch that failed after it started (#263)', () => {
  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: 'codex:session-1',
            provider: 'codex',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1'
          }
        ]
      }
    ])
  }

  /** A retained handle whose `onEarlyFailure` this test can trigger by hand. */
  function earlyFailureHandle(pid = 4242): {
    process: LaunchedProcess
    fail: (failure: LaunchFailure) => void
  } {
    let listener: ((failure: LaunchFailure) => void) | undefined
    return {
      process: {
        pid,
        onExit: () => {},
        onEarlyFailure: (l) => {
          listener = l
        }
      },
      fail: (failure) => listener?.(failure)
    }
  }

  async function runtimeWith(
    launchSession: SessionLauncher,
    onLaunchFailed?: (push: LaunchFailedPush) => void
  ) {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [{ kind: 'codex', scan: crewScan(), feed: vi.fn().mockResolvedValue([]) }],
      launchSession,
      onMinesUpdated: vi.fn(),
      ...(onLaunchFailed === undefined ? {} : { onLaunchFailed })
    })
    await runtime.refresh()
    return { runtime, mineId: runtime.getMines()[0]!.id }
  }

  it('pushes the failure once, correlated by the receipt the verdict already carried', async () => {
    const handle = earlyFailureHandle()
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex', retained: handle.process })
    const onLaunchFailed = vi.fn()
    const { runtime, mineId } = await runtimeWith(launchSession, onLaunchFailed)

    const { launchId } = await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })
    expect(onLaunchFailed).not.toHaveBeenCalled()

    handle.fail({
      exitCode: 1,
      signal: null,
      stderrTail: 'codex: another instance is already running'
    })

    expect(onLaunchFailed).toHaveBeenCalledTimes(1)
    expect(onLaunchFailed).toHaveBeenCalledWith({
      launchId,
      provider: 'codex',
      mineId,
      exitCode: 1,
      stderrTail: 'codex: another instance is already running'
    })
  })

  it('logs the failure with its exit code, off its own line from the started log', async () => {
    const handle = earlyFailureHandle()
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex', retained: handle.process })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { runtime, mineId } = await runtimeWith(launchSession)
      await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })

      handle.fail({ exitCode: 1, signal: null, stderrTail: '' })

      const lines = log.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(lines).toContain('failed (exit 1)')
    } finally {
      log.mockRestore()
    }
  })

  it('redacts and caps the stderr tail before it crosses the wire', async () => {
    const handle = earlyFailureHandle()
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex', retained: handle.process })
    const onLaunchFailed = vi.fn()
    const { runtime, mineId } = await runtimeWith(launchSession, onLaunchFailed)
    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })

    const secret = `sk-${'a'.repeat(30)}`
    handle.fail({ exitCode: 1, signal: null, stderrTail: `auth failed: ${secret}` })

    const push = onLaunchFailed.mock.calls[0]![0] as LaunchFailedPush
    expect(push.stderrTail).not.toContain(secret)
    expect(push.stderrTail).toContain('[redacted]')
  })

  it('never pushes when this build has nothing wired to receive it', async () => {
    const handle = earlyFailureHandle()
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex', retained: handle.process })
    const { runtime, mineId } = await runtimeWith(launchSession)

    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })
    // Nothing to assert against a push — the assertion is that failing here
    // does not throw with no onLaunchFailed configured.
    expect(() => handle.fail({ exitCode: 1, signal: null, stderrTail: '' })).not.toThrow()
  })

  it('never subscribes at all when the launcher retained no process', async () => {
    const launchSession: SessionLauncher = vi
      .fn()
      .mockResolvedValue({ launched: true, provider: 'codex' })
    const onLaunchFailed = vi.fn()
    const { runtime, mineId } = await runtimeWith(launchSession, onLaunchFailed)

    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })

    expect(onLaunchFailed).not.toHaveBeenCalled()
  })
})

/*
 * The second half of #191. A detached launch leaves no held conversation, so
 * the panel had nothing to recognise and never handed over — the dwarf
 * appeared, replied and left while the Add Panel still read "the session
 * started". The receipt is the session's own opening prompt, matched HERE
 * against the prompt this runtime sent, and published as a verdict.
 */
describe('AgentRuntime proving which dwarf a detached launch became (#191)', () => {
  const LAUNCH_PATH = 'C:\\work\\project'

  function codexBoard(sessionIds: string[]) {
    return sessionIds.map((sessionId) => ({
      provider: 'codex' as const,
      sessionId,
      cwd: LAUNCH_PATH,
      status: 'busy' as const,
      updatedAt: 1,
      dwarfs: [
        {
          id: `codex:${sessionId}`,
          provider: 'codex' as const,
          role: 'foreman' as const,
          name: sessionId,
          status: 'working' as const,
          sessionId
        }
      ]
    }))
  }

  async function runtimeWith(sessions: string[], firstPrompts: Record<string, string> = {}) {
    const firstPrompt = vi.fn(async (dwarfId: string) => firstPrompts[dwarfId])
    /*
     * AMENDED for #263 (was a board snapshotted once by mockResolvedValue).
     * Read on every scan, so a test can have a session ARRIVE after the
     * launch — which is the only way a launch's own session ever reaches the
     * board, and now the only way it can be claimed: a session already there
     * when the prompt was sent predates it.
     */
    const onBoard = [...sessions]
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [
        {
          kind: 'codex',
          scan: vi.fn<Provider['scan']>(async () => codexBoard(onBoard)),
          feed: vi.fn().mockResolvedValue([]),
          firstPrompt
        }
      ],
      launchSession: vi.fn().mockResolvedValue({ launched: true, provider: 'codex' }),
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, firstPrompt, onBoard, mineId: runtime.getMines()[0]!.id }
  }

  /** One poll, plus the head read the poll deliberately does not wait for. */
  async function sweep(runtime: AgentRuntime): Promise<void> {
    await runtime.refresh()
    await runtime.settleLaunchReceipts()
  }

  function launchIdOf(runtime: AgentRuntime, dwarfId: string): string | undefined {
    return runtime
      .getMines()
      .flatMap((mine) => mine.dwarfs)
      .find((dwarf) => dwarf.id === dwarfId)?.launchId
  }

  /*
   * A receipt, never a dwarf. The verdict still claims nothing about the board
   * — #86's rule — it hands over the id the panel then waits to SEE.
   */
  it('answers a detached launch with a receipt the panel can wait on', async () => {
    const { runtime, mineId } = await runtimeWith(['theirs'])

    const result = await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig' })

    expect(result.launched).toBe(true)
    expect(result.launchId).toEqual(expect.any(String))
  })

  it('stamps that receipt on the dwarf whose session opened with the prompt it sent', async () => {
    // AMENDED for #263: 'mine' now ARRIVES after the launch instead of already
    // sitting on the board with it. Both assertions are untouched; only the
    // fixture's timeline is, and in the direction of what actually happens —
    // the session a launch starts cannot be on the board before the launch.
    const { runtime, mineId, onBoard } = await runtimeWith(['theirs'], {
      'codex:mine': 'dig the east gallery',
      'codex:theirs': 'shore the north wall'
    })

    const { launchId } = await runtime.launchAgent({
      mineId,
      provider: 'codex',
      prompt: 'dig the east gallery'
    })
    onBoard.push('mine')
    await sweep(runtime)
    await runtime.refresh()

    expect(launchIdOf(runtime, 'codex:mine')).toBe(launchId)
    expect(launchIdOf(runtime, 'codex:theirs')).toBeUndefined()
  })

  /*
   * Issue #263, and the wiring rather than the rule: LaunchReceiptRegistry can
   * only refuse a session it was TOLD about, so the board the runtime reads at
   * launch time is the whole of the guard. Launching Codex where a Codex
   * session was already running claimed that older session — a relaunch is
   * usually the same prompt, and candidates are ordered by a chronological
   * uuid-v7 — so the panel opened on the wrong dwarf and the session that had
   * just started read as one that never started.
   */
  it('never stamps a session that was already on the board when the launch was made', async () => {
    const { runtime, mineId, onBoard } = await runtimeWith(['thread-1'], {
      'codex:thread-1': 'dig the east gallery',
      'codex:thread-2': 'dig the east gallery'
    })

    const { launchId } = await runtime.launchAgent({
      mineId,
      provider: 'codex',
      prompt: 'dig the east gallery'
    })
    onBoard.push('thread-2')
    await sweep(runtime)
    await runtime.refresh()

    expect(launchIdOf(runtime, 'codex:thread-1')).toBeUndefined()
    expect(launchIdOf(runtime, 'codex:thread-2')).toBe(launchId)
  })

  it('stamps nobody when no session on the board opened with those words', async () => {
    const { runtime, mineId } = await runtimeWith(['theirs'], {
      'codex:theirs': 'shore the north wall'
    })

    await runtime.launchAgent({ mineId, provider: 'codex', prompt: 'dig the east gallery' })
    await sweep(runtime)
    await runtime.refresh()

    expect(launchIdOf(runtime, 'codex:theirs')).toBeUndefined()
  })

  /*
   * The cost rule. This read walks a transcript's HEAD, which is the one place
   * the poll's own tail window never goes, so it must never ride the two-second
   * loop: a machine with no launch waiting pays nothing at all.
   */
  it('reads no transcript head on a poll with no launch waiting for its dwarf', async () => {
    const { runtime, firstPrompt } = await runtimeWith(['theirs'], {
      'codex:theirs': 'shore the north wall'
    })

    await sweep(runtime)

    expect(firstPrompt).not.toHaveBeenCalled()
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

  /*
    AMENDED for #169 (was: 'reverts a worked mine to an ordinary discovered one
    instead of hiding it', asserting `{ outcome: 'reverted' }` and a board that
    still held the mine and its dwarf). Undeclaring IS the soft delete now, and
    a live session no longer saves a mine from it: the maintainer's 2026-09-07
    case is a folder Codex made and is working in RIGHT NOW that could never be
    removed, so "an agent is in there" had to stop being a veto. Same subject —
    what undeclaring a mine somebody is working does — and the answer reversed.
  */
  it('takes a worked mine off the board too, agent and all', async () => {
    const { provider, setWorking } = toggleProvider(ADOPTED)
    const runtime = declaredRuntime({
      providers: [provider],
      chooseDirectory: async () => ADOPTED
    })

    setWorking(true)
    const declared = await runtime.declareMine()
    await runtime.refresh()
    await runtime.settleProjects()
    const result = await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(result).toEqual({ outcome: 'removed' })
    expect(mines).toEqual([])
  })

  it('keeps a forgotten mine off the board however many polls later (#169)', async () => {
    // The Codex case in one test: an agent goes on working in the folder, and
    // the mine does not come back on its own. Discovery still SEES the session
    // — that is unavoidable, it is a real session — so what matters is that
    // every poll after the deletion drops it again.
    const { provider, setWorking } = toggleProvider(ADOPTED)
    const runtime = declaredRuntime({
      providers: [provider],
      chooseDirectory: async () => ADOPTED
    })

    setWorking(true)
    const declared = await runtime.declareMine()
    await runtime.refresh()
    await runtime.settleProjects()
    await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    await runtime.refresh()
    await runtime.settleProjects()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toEqual([])
  })

  it('puts the mine back when the user adds the same folder again (#169)', async () => {
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    const declared = await runtime.declareMine()
    await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    expect(runtime.getMines()).toEqual([])

    const readded = await runtime.declareMine()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    // The SAME mine, because identity is the path: whatever the vault accrued
    // under this id is attached to it again.
    expect(readded.mineId).toBe(declared.mineId)
    expect(mines.map((mine) => mine.id)).toEqual([declared.mineId])
  })

  it('leaves the ore a forgotten mine produced in the vault (#169)', async () => {
    // Deleting is logical: the ledger's history survives untouched, which is
    // what makes a re-add find its materials still there.
    const ledger = new MaterialLedger({ store: nullLedgerStore() })
    await ledger.load()
    ledger.creditCoal(mineIdForPath(ADOPTED), 40_000)
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED, ledger })

    const declared = await runtime.declareMine()
    await runtime.undeclareMine(declared.mineId!)
    await runtime.refresh()
    const readded = await runtime.declareMine()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(readded.outcome).toBe('added')
    expect(mines[0]!.materials?.coal).toBe(40_000)
  })

  it('reads which mines are forgotten before the first poll publishes (#169)', async () => {
    // The flag has to reach the board from the store on load, not only from a
    // deletion made in this session: otherwise every restart shows the mines
    // the user deleted until they delete them again.
    const projects = projectsStoreFor()
    const declared = await projects.declare({ path: ADOPTED, at: 1 })
    await projects.forget({ id: mineIdForPath(ADOPTED), at: 2 })
    expect(declared.ok).toBe(true)
    const runtime = declaredRuntime({ projects })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toEqual([])
  })

  it('never lists a forgotten mine in a browse (#169)', async () => {
    const runtime = declaredRuntime({ chooseDirectory: async () => ADOPTED })

    const declared = await runtime.declareMine()
    await runtime.undeclareMine(declared.mineId!)
    const answer = await runtime.queryProjects({ sortBy: 'addedAt', direction: 'desc' })
    runtime.stop()

    expect(answer.answered).toBe(true)
    expect(answer.projects).toEqual([])
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

  /**
   * The Agent SDK seam. No runtime test starts a real agent.
   *
   * AMENDED for #96's mutating slice: the shape was an inline return type,
   * and is a named one now purely so the object below can be held in a
   * `const` — `contextUsageModel` is read from inside the handle it is
   * declared beside, which an anonymous return-position literal cannot do.
   * No existing member changed.
   */
  interface HeldPortFake {
    port: HeldSessionPort
    started: HeldSessionStartRequest[]
    closes: () => number
    /** AMENDED for #96: which sessions were asked for a context reading, in order. */
    contextUsageAsks: number[]
    /*
     * AMENDED for #96's mutating slice: the tuning half of the same surface.
     * `modelsSet` records what the session was asked to switch to, and
     * `contextUsageModel` is what its next reading will then NAME — which is
     * the thing that verifies a model change without spending a paid turn, so
     * a test has to be able to set the two independently. No existing
     * assertion changed.
     */
    modelsSet: string[]
    contextUsageModel: string
    reportSessionId: (index: number, sessionId: string) => void
    ask: (index: number, toolUseId: string) => Promise<HeldAnswer>
    permission: (index: number, toolUseId: string) => Promise<HeldPermissionAnswer>
    reportTelemetry: (index: number, update: HeldSessionTelemetryUpdate) => void
    reportSubagent: (index: number, signal: HeldSessionSubagentSignal) => void
    reportMessage: (index: number, role: 'user' | 'assistant', text: string) => void
  }

  function heldPort(): HeldPortFake {
    const started: HeldSessionStartRequest[] = []
    const contextUsageAsks: number[] = []
    const modelsSet: string[] = []
    let closed = 0
    const fake: HeldPortFake = {
      started,
      closes: () => closed,
      contextUsageAsks,
      modelsSet,
      contextUsageModel: 'claude-haiku-4-5',
      port: async (request) => {
        const index = started.length
        started.push(request)
        return {
          close: () => {
            closed += 1
          },
          send: () => true,
          // #210 added interrupt() beside close/send. These tests are about
          // holding a session, not delivering to one, so the fake only has to
          // satisfy the port; the delivery route is pinned in its own describe.
          interrupt: async () => true,
          /*
           * AMENDED for #96 (was: a handle carrying only close/send/interrupt).
           * Context usage is the one reading no stream message carries, so the
           * port grew a pull. No existing assertion changed.
           */
          contextUsage: async () => {
            contextUsageAsks.push(index)
            return {
              usedTokens: 41_237,
              maxTokens: 200_000,
              // The model the CLI says is in force at this reading (#96) —
              // what the strip's own verification rule reads.
              model: fake.contextUsageModel
            }
          },
          // The two OPTIONAL tuning capabilities (#96). Present here because
          // the engine behind a held Claude session has both; a fake that
          // leaves one off is what an engine without it looks like, and that
          // case is pinned in heldSessionRegistry.test.ts.
          setModel: async (model: string) => {
            modelsSet.push(model)
            return true
          },
          setEffort: async () => true
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
      // #203: any other tool the CLI decided to prompt about.
      permission: (index, toolUseId) =>
        started[index]!.onPermission({
          toolUseId,
          toolName: 'Bash',
          input: { command: 'pnpm test' }
        }),
      reportTelemetry: (index, update) => started[index]!.onTelemetry(update),
      // #157: what the SDK loop forwards when the session's own stream says
      // something about its crew.
      reportSubagent: (index, signal) => started[index]!.onSubagent(signal),
      reportMessage: (index, role, text) => started[index]!.onMessage(role, text)
    }
    return fake
  }

  function heldRegistry(port: HeldSessionPort): HeldSessionRegistry {
    const fs = new FakeFs()
    fs.addFile(CLAUDE, '#!/bin/sh\n')
    return new HeldSessionRegistry({
      detector: createCliDetector({ home: '/home/j', platform: 'linux', fs, env: {} }),
      // AMENDED for #237, step 5 (was: `start: port`). One engine per provider
      // now that a second held protocol exists; this fake is still the only
      // Claude engine and nothing else in this helper changed.
      start: { claude: port },
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

  /*
   * Issue #96's read-only surface, the half no stream message can serve. The
   * panel asks for a context reading when a mine opens, main resolves the
   * dwarf to the session it HOLDS, and the reading arrives on the next
   * snapshot like every other change — the same one-way shape
   * `setWatchedDwarf` already has.
   */
  it('pulls a context reading for the dwarf the panel opened, and publishes it (#96)', async () => {
    const port = heldPort()
    const registry = heldRegistry(port.port)
    const runtime = heldRuntime({ heldSessions: registry, providers: [foremanProvider()] })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs[0]!.contextUsage).toBeUndefined()

    runtime.refreshDwarfTelemetry('claude:sess-1')
    // The pull is a control request on a stream main owns; the value lands on
    // the record, and the board carries it on its next pass.
    await registry.refreshContextUsage('sess-1')
    await runtime.refresh()

    expect(port.contextUsageAsks).toEqual([0])
    expect(runtime.getMines()[0]!.dwarfs[0]!.contextUsage).toEqual({
      usedTokens: 41_237,
      maxTokens: 200_000
    })
    runtime.stop()
  })

  it('asks nothing for a dwarf whose session this panel only observes (#96)', async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    runtime.refreshDwarfTelemetry('claude:sess-1')
    runtime.refreshDwarfTelemetry('nobody')

    expect(port.contextUsageAsks).toEqual([])
    runtime.stop()
  })

  /*
   * Issue #96's MUTATING half. The channel is one act per request over a
   * discriminated payload, and this level owns exactly two things: resolving
   * a DWARF to the session this process holds, and refusing everything that
   * is not one. What a change means, what confirms it and what a refusal says
   * all belong to the registry.
   */
  it('changes the model of the held session behind a dwarf, and publishes the controls (#96)', async () => {
    const port = heldPort()
    const registry = heldRegistry(port.port)
    const runtime = heldRuntime({ heldSessions: registry, providers: [foremanProvider()] })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })
    await runtime.refresh()

    // What the strip needs before it may draw a control at all: the engine's
    // own answer about what it can change, stamped on the foreman.
    expect(runtime.getMines()[0]!.dwarfs[0]!.sessionTuning).toEqual({
      canSetModel: true,
      canSetEffort: true
    })

    port.contextUsageModel = 'claude-sonnet-5'
    const verdict = await runtime.setDwarfTuning({
      dwarfId: 'claude:sess-1',
      change: { kind: 'model', model: 'claude-sonnet-5' }
    })
    await runtime.refresh()

    expect(verdict).toEqual({ applied: true })
    expect(port.modelsSet).toEqual(['claude-sonnet-5'])
    // Confirmed by the reading, so the board carries the new model and
    // nothing is left pending for the strip to hedge about.
    expect(runtime.getMines()[0]!.dwarfs[0]!.model).toBe('claude-sonnet-5')
    expect(runtime.getMines()[0]!.dwarfs[0]!.sessionTuning).toEqual({
      canSetModel: true,
      canSetEffort: true
    })
    runtime.stop()
  })

  it('publishes a model this panel asked for as pending until a reading names it (#96)', async () => {
    const port = heldPort()
    const registry = heldRegistry(port.port)
    const runtime = heldRuntime({ heldSessions: registry, providers: [foremanProvider()] })
    await runtime.refresh()
    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    port.reportSessionId(0, 'sess-1')
    port.reportTelemetry(0, { model: 'claude-haiku-4-5' })

    // The session has not switched yet, and says so.
    await runtime.setDwarfTuning({
      dwarfId: 'claude:sess-1',
      change: { kind: 'model', model: 'claude-sonnet-5' }
    })
    await runtime.refresh()

    const dwarf = runtime.getMines()[0]!.dwarfs[0]!
    expect(dwarf.model).toBe('claude-haiku-4-5')
    expect(dwarf.sessionTuning).toEqual({
      canSetModel: true,
      canSetEffort: true,
      pendingModel: 'claude-sonnet-5'
    })
    runtime.stop()
  })

  it('refuses a tuning change for a dwarf whose session this panel does not hold (#96)', async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    const observed = await runtime.setDwarfTuning({
      dwarfId: 'claude:sess-1',
      change: { kind: 'model', model: 'claude-sonnet-5' }
    })
    const absent = await runtime.setDwarfTuning({
      dwarfId: 'nobody',
      change: { kind: 'effort', effort: 'high' }
    })

    expect(observed.applied).toBe(false)
    expect(absent.applied).toBe(false)
    expect(port.modelsSet).toEqual([])
    // And no control is offered on a session that cannot serve one.
    expect(runtime.getMines()[0]!.dwarfs[0]!.sessionTuning).toBeUndefined()
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

  /*
   * Issue #245, end to end through the poll. A held session's registry entry
   * never carries a `status` (no REPL writes one), so before this a held
   * dwarf read `waiting` from launch to close whatever it was actually doing.
   */
  it('reads working right after launch and waiting on user-input once an ask is parked (#245)', async () => {
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
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs[0]!.status).toBe('working')
    expect(runtime.getMines()[0]!.dwarfs[0]!.waitingReason).toBeUndefined()

    void port.ask(0, 'toolu_live')
    await Promise.resolve()
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs[0]!.status).toBe('waiting')
    expect(runtime.getMines()[0]!.dwarfs[0]!.waitingReason).toBe('user-input')
    runtime.stop()
  })

  /*
   * Issue #191, end to end through main: the Add Panel recognises the dwarf of
   * the session it just launched by the first message of its conversation, so
   * the launch's dwarf has to reach the board AT ALL. It did not. An SDK-hosted
   * session registers with `entrypoint: sdk-ts` and never a `status` — the REPL
   * writes that, and there is no REPL — which the provider read as an idle
   * session and drew as nobody. The fixture below is that entry as observed
   * live, through the REAL Claude provider off the real registry, so the
   * wiring from the held registry into the provider is what this holds.
   */
  it("draws the held session's dwarf carrying its first prompt although the SDK entry never says busy (#191)", async () => {
    const home = 'C:\\Users\\j'
    const fake = new FakeFs()
    // Alive by definition, and no procStart, so the pid-reuse guard has nothing
    // to compare and stays out of the way.
    fake.addFile(
      `${home}\\.claude\\sessions\\${process.pid}.json`,
      JSON.stringify({
        pid: process.pid,
        sessionId: 'sess-1',
        cwd: MINE_PATH,
        startedAt: 8_000,
        kind: 'interactive',
        entrypoint: 'sdk-ts',
        name: 'anvil-7'
      }),
      8_000
    )
    const port = heldPort()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home,
      fs: fake,
      heldSessions: heldRegistry(port.port),
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
    const mineId = mineIdForPath(MINE_PATH)
    const dwarfsOf = (): readonly Dwarf[] =>
      runtime.getMines().find((mine) => mine.id === mineId)?.dwarfs ?? []

    // Before the launch the same entry is a session nobody holds: no dwarf, as
    // an idle one has none. The mine is still there to launch from.
    await runtime.refresh()
    expect(runtime.getMines().map((mine) => mine.id)).toContain(mineId)
    expect(dwarfsOf()).toEqual([])

    const result = await runtime.launchHeldSession({
      provider: 'claude',
      mineId,
      prompt: 'dig the east gallery'
    })
    expect(result).toEqual({ launched: true })
    port.reportSessionId(0, 'sess-1')
    await runtime.refresh()

    // Exactly the receipt the renderer's `launchedDwarfIn` reads: one dwarf,
    // its conversation opening with the user's own prompt, in the mine the
    // launch was made from.
    expect(dwarfsOf()).toHaveLength(1)
    expect(dwarfsOf()[0]).toMatchObject({ id: 'claude:sess-1', sessionId: 'sess-1' })
    expect(dwarfsOf()[0]!.conversation?.[0]).toEqual({
      role: 'user',
      text: 'dig the east gallery',
      timestamp: new Date(1_700_000_000_000).toISOString()
    })

    // And it stays for as long as the panel holds the session — a turn ending
    // is not the dwarf leaving.
    await runtime.refresh()
    expect(dwarfsOf()).toHaveLength(1)
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

  /*
   * Issue #265. A question the panel only OBSERVES is shown and not answerable:
   * the answer channel is a held session's own stream, and an observed session
   * has none. Codex offers a message queue and no keyboard, and a queued
   * message is not an answer to a blocked tool call — so the refusal names
   * where the ask CAN be answered rather than inventing a second channel.
   *
   * Distinct from the case above, which is a dwarf that has left the mine. This
   * dwarf is on the board, carrying the ask, and still cannot be answered here.
   */
  it('refuses an observed dwarf’s ask and says where it can be answered', async () => {
    const port = heldPort()
    const ask: DwarfQuestion = {
      toolUseId: 'call_observed',
      question: 'Which colour?',
      multiSelect: false,
      options: [{ label: 'Green' }]
    }
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider(ask)]
    })
    await runtime.refresh()

    const result = runtime.answerDwarfQuestion({
      dwarfId: 'claude:sess-1',
      toolUseId: 'call_observed',
      answers: { 'Which colour?': 'Green' }
    })
    runtime.stop()

    expect(result.answered).toBe(false)
    expect(result.error).toContain('only where the session runs')
    expect(result.error).toContain('terminal')
    // Never the registry's own wording, which describes this app rather than
    // the session the person is looking at.
    expect(result.error).not.toContain('not one this panel is holding')
  })

  /*
   * Issue #203. A permission prompt takes the same route an ask does: stamped
   * on the foreman off the registry, decided by dwarf id, and released in
   * main where the blocked call is.
   */
  it("stamps a held session's live permission prompt on its foreman, and clears it once decided", async () => {
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
    const asked = port.permission(0, 'toolu_perm')
    await Promise.resolve()
    await runtime.refresh()

    expect(runtime.getMines()[0]!.dwarfs[0]!.pendingPermission).toMatchObject({
      toolUseId: 'toolu_perm',
      toolName: 'Bash',
      input: 'pnpm test'
    })

    // Awaited since #203 gave the observed channel a keystroke to type; a held
    // decision is still the same local handover it always was.
    await expect(
      runtime.answerDwarfPermission({
        dwarfId: 'claude:sess-1',
        toolUseId: 'toolu_perm',
        decision: 'allow'
      })
    ).resolves.toEqual({ answered: true })
    await expect(asked).resolves.toEqual({ decision: 'allow' })
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs[0]!.pendingPermission).toBeUndefined()
    runtime.stop()
  })

  it('refuses a permission decision for a dwarf that is not on the board', async () => {
    const port = heldPort()
    const runtime = heldRuntime({ heldSessions: heldRegistry(port.port) })

    const result = await runtime.answerDwarfPermission({
      dwarfId: 'claude:nobody',
      toolUseId: 'toolu_perm',
      decision: 'deny'
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

  /*
   * #239. Same hop as the detached launcher's: the request may name a model
   * and an effort, and both have to reach the held session's own start,
   * unchanged, so PROVIDER_EFFORT_LEVELS.claude's five reach the SDK exactly
   * as the boundary checked them.
   */
  it('forwards a model and an effort the request named, down to the held session', async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig',
      model: 'sonnet',
      effort: 'xhigh'
    })
    runtime.stop()

    expect(port.started[0]!.model).toBe('sonnet')
    expect(port.started[0]!.effort).toBe('xhigh')
  })

  it('leaves model and effort off the held session start when the request named neither', async () => {
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
    runtime.stop()

    expect('model' in port.started[0]!).toBe(false)
    expect('effort' in port.started[0]!).toBe(false)
  })

  it('forwards a permission mode the request named, down to the held session', async () => {
    const port = heldPort()
    const runtime = heldRuntime({
      heldSessions: heldRegistry(port.port),
      providers: [foremanProvider()]
    })
    await runtime.refresh()

    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig',
      permissionMode: 'plan'
    })
    runtime.stop()

    expect(port.started[0]!.permissionMode).toBe('plan')
  })

  it('leaves the permission mode off the held session start when the request named none', async () => {
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
    runtime.stop()

    expect('permissionMode' in port.started[0]!).toBe(false)
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
      // Added by #217; never ends a real tree, like every other port here.
      processEnd: { endProcessTree: async () => false },
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
 * #239. What each provider can start ON, live — beside listAgentProviders for
 * the same reason. `claudeModelCatalog` and `codexModelHistory` are injected
 * ports, exactly as `heldSessions`'s `start` is: no unit test may spawn a real
 * agent or open a real database, so both are hand-rolled fakes here.
 */
describe('AgentRuntime.listAgentModels (#239)', () => {
  const HOME = '/home/j'
  const CLAUDE_BIN = '/home/j/.local/bin/claude'
  // AMENDED for #282 (added): the stem cliExecutableStem gives Antigravity —
  // its convention path is '.local/bin/agy', never the provider name itself.
  const ANTIGRAVITY_BIN = '/home/j/.local/bin/agy'

  function runtimeWith(options: {
    claudeInstalled: boolean
    claudeModelCatalog?: ClaudeModelCatalogPort
    codexModelHistory?: () => Promise<CodexThreadModel[]>
    // AMENDED for #282 (added): Antigravity now asks its own CLI live,
    // exactly as Claude asks the SDK — see the fakes below.
    antigravityInstalled?: boolean
    antigravityModelCatalog?: AntigravityModelCatalogPort
  }) {
    const fs = new FakeFs()
    if (options.claudeInstalled) fs.addFile(CLAUDE_BIN, '#!/bin/sh\n')
    if (options.antigravityInstalled) fs.addFile(ANTIGRAVITY_BIN, '#!/bin/sh\n')
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
      processEnd: { endProcessTree: async () => false },
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
      onMinesUpdated: vi.fn(),
      claudeModelCatalog: options.claudeModelCatalog ?? (async () => []),
      codexModelHistory: options.codexModelHistory ?? (async () => []),
      antigravityModelCatalog: options.antigravityModelCatalog ?? (async () => [])
    })
  }

  it('answers one entry per provider, in DWARF_PROVIDERS order', async () => {
    const list = await runtimeWith({ claudeInstalled: false }).listAgentModels()
    expect(list.catalogs.map((entry) => entry.provider)).toEqual(['claude', 'codex', 'antigravity'])
  })

  it("asks the SDK for Claude's own live models when the CLI is installed", async () => {
    // AMENDED for #96 (was: the SDK answer carried no `effortLevels` and the
    // expected option was `{ value, label }` alone). A per-model effort list
    // now rides each option — see ModelOption.effortLevels — and this case
    // carries one through end to end. Nothing about the port call, the
    // provider-wide `efforts` or the source changed.
    const claudeModelCatalog = vi.fn<ClaudeModelCatalogPort>().mockResolvedValue([
      {
        value: 'claude-sonnet-5',
        displayName: 'Sonnet',
        supportsEffort: true,
        effortLevels: ['low', 'high']
      }
    ])
    const list = await runtimeWith({ claudeInstalled: true, claudeModelCatalog }).listAgentModels()

    expect(claudeModelCatalog).toHaveBeenCalledWith({ executablePath: CLAUDE_BIN })
    expect(list.catalogs.find((entry) => entry.provider === 'claude')).toEqual({
      provider: 'claude',
      models: [{ value: 'claude-sonnet-5', label: 'Sonnet', effortLevels: ['low', 'high'] }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  it('never asks the SDK anything when Claude is not installed', async () => {
    const claudeModelCatalog = vi.fn<ClaudeModelCatalogPort>().mockResolvedValue([])
    const list = await runtimeWith({ claudeInstalled: false, claudeModelCatalog }).listAgentModels()

    expect(claudeModelCatalog).not.toHaveBeenCalled()
    expect(list.catalogs.find((entry) => entry.provider === 'claude')).toEqual({
      provider: 'claude',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'none'
    })
  })

  it('answers Claude as source: none, never a rejection, when the live ask itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const claudeModelCatalog = vi
      .fn<ClaudeModelCatalogPort>()
      .mockRejectedValue(new Error('the CLI would not start'))

    const list = await runtimeWith({ claudeInstalled: true, claudeModelCatalog }).listAgentModels()

    expect(list.catalogs.find((entry) => entry.provider === 'claude')).toEqual({
      provider: 'claude',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'none'
    })
    // Codex and Antigravity still answer: one provider's failure never
    // silences the other two.
    expect(list.catalogs).toHaveLength(3)
    warn.mockRestore()
  })

  /*
   * A CLI that spawns but never finishes its own init handshake — a broken
   * install, a login prompt nothing here can answer — must not leave
   * listAgentModels, and the Add Panel behind it, waiting forever. The port
   * itself is what is bounded (MODEL_CATALOG_TIMEOUT_MS, named beside it in
   * sdkHeldSession.ts), so an injected fake that never resolves is held to
   * the same bound a real one is.
   */
  it('answers Claude as source: none once the catalogue ask outruns its bound, rather than hanging', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Never resolves and never rejects — exactly a stuck CLI's own promise.
      const claudeModelCatalog = vi
        .fn<ClaudeModelCatalogPort>()
        .mockReturnValue(new Promise(() => {}))

      const pending = runtimeWith({ claudeInstalled: true, claudeModelCatalog }).listAgentModels()
      await vi.advanceTimersByTimeAsync(MODEL_CATALOG_TIMEOUT_MS)
      const list = await pending

      expect(list.catalogs.find((entry) => entry.provider === 'claude')).toEqual({
        provider: 'claude',
        models: [],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'none'
      })
      expect(list.catalogs).toHaveLength(3)
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries Codex's own registry history, deduped, as source: history", async () => {
    const list = await runtimeWith({
      claudeInstalled: false,
      codexModelHistory: async () => [{ model: 'gpt-5.6-sol' }, { model: 'gpt-5.6-sol' }]
    }).listAgentModels()

    expect(list.catalogs.find((entry) => entry.provider === 'codex')).toEqual({
      provider: 'codex',
      models: [{ value: 'gpt-5.6-sol' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
  })

  it('answers Codex with an empty history, never a rejection, when the registry read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const list = await runtimeWith({
      claudeInstalled: false,
      codexModelHistory: async () => {
        throw new Error('the database would not open')
      }
    }).listAgentModels()

    expect(list.catalogs.find((entry) => entry.provider === 'codex')).toEqual({
      provider: 'codex',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
    expect(list.catalogs).toHaveLength(3)
    warn.mockRestore()
  })

  /*
   * AMENDED for #282 (was: 'always answers Antigravity as none, until #237
   * gives it a launch path' — one test with no installed/not-installed
   * branch at all, since PROVIDER_EFFORT_LEVELS.antigravity was `[]` and
   * nothing could ask it live). #282 asks `agy models` live, on the same
   * terms Claude's SDK ask already is; this test now covers "not installed"
   * only, and the four below cover what #239's Claude block already does.
   */
  it('answers Antigravity as none when the CLI is not installed', async () => {
    const list = await runtimeWith({
      claudeInstalled: false,
      antigravityInstalled: false
    }).listAgentModels()

    expect(list.catalogs.find((entry) => entry.provider === 'antigravity')).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: ['low', 'medium', 'high'],
      source: 'none'
    })
  })

  it("asks the CLI for Antigravity's own live models when installed", async () => {
    const antigravityModelCatalog = vi
      .fn<AntigravityModelCatalogPort>()
      .mockResolvedValue([
        { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' }
      ])
    const list = await runtimeWith({
      claudeInstalled: false,
      antigravityInstalled: true,
      antigravityModelCatalog
    }).listAgentModels()

    expect(antigravityModelCatalog).toHaveBeenCalledWith({ executablePath: ANTIGRAVITY_BIN })
    expect(list.catalogs.find((entry) => entry.provider === 'antigravity')).toEqual({
      provider: 'antigravity',
      models: [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }],
      efforts: ['low', 'medium', 'high'],
      source: 'provider'
    })
  })

  it('never spawns anything when Antigravity is not installed', async () => {
    const antigravityModelCatalog = vi.fn<AntigravityModelCatalogPort>().mockResolvedValue([])
    const list = await runtimeWith({
      claudeInstalled: false,
      antigravityInstalled: false,
      antigravityModelCatalog
    }).listAgentModels()

    expect(antigravityModelCatalog).not.toHaveBeenCalled()
    expect(list.catalogs.find((entry) => entry.provider === 'antigravity')).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: ['low', 'medium', 'high'],
      source: 'none'
    })
  })

  it('answers Antigravity as source: none, never a rejection, when the spawn or the parse itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const antigravityModelCatalog = vi
      .fn<AntigravityModelCatalogPort>()
      .mockRejectedValue(new Error('agy models produced no readable model list'))

    const list = await runtimeWith({
      claudeInstalled: false,
      antigravityInstalled: true,
      antigravityModelCatalog
    }).listAgentModels()

    expect(list.catalogs.find((entry) => entry.provider === 'antigravity')).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: ['low', 'medium', 'high'],
      source: 'none'
    })
    // Claude and Codex still answer: one provider's failure never silences
    // the other two.
    expect(list.catalogs).toHaveLength(3)
    warn.mockRestore()
  })

  it('answers Antigravity as source: none once the catalogue ask outruns its bound, rather than hanging', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Never resolves and never rejects — exactly a stuck CLI's own promise.
      const antigravityModelCatalog = vi
        .fn<AntigravityModelCatalogPort>()
        .mockReturnValue(new Promise(() => {}))

      const pending = runtimeWith({
        claudeInstalled: false,
        antigravityInstalled: true,
        antigravityModelCatalog
      }).listAgentModels()
      await vi.advanceTimersByTimeAsync(MODEL_CATALOG_TIMEOUT_MS)
      const list = await pending

      expect(list.catalogs.find((entry) => entry.provider === 'antigravity')).toEqual({
        provider: 'antigravity',
        models: [],
        efforts: ['low', 'medium', 'high'],
        source: 'none'
      })
      expect(list.catalogs).toHaveLength(3)
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
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

/**
 * The Mine History panel's read (#192): what a mine's transcripts on disk say,
 * for dwarfs that may be gone. The runtime's whole part is resolving the mine
 * id to the folder the board already knows for it — a channel that accepted a
 * path would be a channel that accepts any path — and answering `readable:
 * false` when it cannot, which is a different fact from a mine nobody has
 * spoken in.
 */
describe('AgentRuntime.mineHistory', () => {
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
          role: 'foreman',
          name: 'session-',
          status: 'working',
          sessionId: 'session-1'
        }
      ]
    }
  ])
  const source: Provider = { kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }
  const SPEAKER = {
    id: 'claude:older-session',
    provider: 'claude' as const,
    role: 'foreman' as const,
    name: 'older-se',
    lastMessageAt: 1_000,
    messages: [{ role: 'assistant' as const, text: 'Done long ago.', timestamp: '1970-01-01' }]
  }

  it("resolves the mine to its folder and answers with the folder's speakers", async () => {
    const readAcross = vi.fn().mockResolvedValue([SPEAKER])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      history: { read: vi.fn(), readAcross },
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.mineHistory(mineIdForPath('C:\\work\\project'))).resolves.toEqual({
      readable: true,
      speakers: [SPEAKER]
    })
    // #348: every folder this mine's work happens in — for a mine nothing
    // folded into, exactly the one folder it always was.
    expect(readAcross).toHaveBeenCalledWith(['C:\\work\\project'])
  })

  it('reads nothing for a mine that is not on the board, and says it could not', async () => {
    const readAcross = vi.fn().mockResolvedValue([SPEAKER])
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      history: { read: vi.fn(), readAcross },
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.mineHistory('mine:nowhere')).resolves.toEqual({
      readable: false,
      speakers: []
    })
    expect(readAcross).not.toHaveBeenCalled()
  })

  it('answers unreadable rather than throwing when the read itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      history: { read: vi.fn(), readAcross: vi.fn().mockRejectedValue(new Error('disk')) },
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.mineHistory(mineIdForPath('C:\\work\\project'))).resolves.toEqual({
      readable: false,
      speakers: []
    })
    warn.mockRestore()
  })
})

/**
 * The one lookup `index.ts` needs to trust a folder for a click on an
 * activity line's own path (#279) — resolved against the board exactly as
 * `mineHistory`'s own mine lookup is, and for the same reason: a channel that
 * accepted a folder from the renderer would accept any folder.
 */
describe('AgentRuntime.mineFolderOf', () => {
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
          role: 'foreman',
          name: 'session-',
          status: 'working',
          sessionId: 'session-1'
        }
      ]
    }
  ])
  const source: Provider = { kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }

  it('resolves a mine on the board to its own folder', async () => {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    expect(runtime.mineFolderOf(mineIdForPath('C:\\work\\project'))).toBe('C:\\work\\project')
  })

  it('answers undefined for a mine that is not on the board', async () => {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    expect(runtime.mineFolderOf('mine:nowhere')).toBeUndefined()
  })
})

/**
 * Delivery to a session THIS PANEL HOLDS (#210).
 *
 * The bug these pin, measured live: a held session's registry entry reports
 * `kind: "interactive"`, so `claudeSessionDeliveryTarget` answers with the SDK
 * child's pid — a process that owns no window. Focus failed (1121ms), the relay
 * fallback ran, and `delivered: true` came back for a session whose inbox
 * nothing drains: an SDK-hosted session has no REPL to read cross-session
 * messaging. So ownership is resolved BEFORE endpoint kind, and the terminal
 * tier below is wired to report exactly that lie — a failing focus and a relay
 * that "succeeds" — so a regression cannot pass by returning delivered: true.
 */
describe('AgentRuntime delivery to a session the panel holds (#210)', () => {
  const MINE_PATH = 'C:\\X\\anvil'
  const CLAUDE = '/home/j/.local/bin/claude'
  const HELD_FOREMAN_ID = 'claude:sess-1'

  interface HeldFake {
    port: HeldSessionPort
    sends: () => string[]
    interrupts: () => number
    reportSessionId: (sessionId: string) => void
    reportSubagent: (signal: HeldSessionSubagentSignal) => void
  }

  /** The Agent SDK seam, as always: no test here starts a real agent. */
  function heldFake(options: { streamTakes?: boolean; canInterrupt?: boolean } = {}): HeldFake {
    const sends: string[] = []
    let interrupts = 0
    let started: HeldSessionStartRequest | undefined
    return {
      sends: () => sends,
      interrupts: () => interrupts,
      port: async (request) => {
        started = request
        return {
          close: () => {},
          send: (text: string) => {
            sends.push(text)
            return options.streamTakes ?? true
          },
          interrupt: async () => {
            interrupts += 1
            return options.canInterrupt ?? true
          },
          // #96 added this beside close/send/interrupt; this describe is about
          // delivery, not telemetry, so the fake only has to satisfy the port.
          contextUsage: async () => null
        }
      },
      reportSessionId: (sessionId) => started!.onSessionId(sessionId),
      reportSubagent: (signal) => started!.onSubagent(signal)
    }
  }

  /** The tiers that must never be reached, each reporting what it reported live. */
  function terminalPort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'focus failed' }),
      // The exit-0-shaped lie itself: the relay says delivered for a queue
      // nothing reads. If ownership stops deciding the route, this is what the
      // verdict assertions below catch.
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: false, error: 'focus failed' })
    } satisfies TextDeliveryPort
  }

  /**
   * What the Claude provider really answers for a held session: its registry
   * entry records `kind: "interactive"` and a name, so the target carries the
   * SDK child's pid and the relay address beside it.
   */
  function heldProvider(): Provider {
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
              id: HELD_FOREMAN_ID,
              provider: 'claude' as const,
              role: 'foreman' as const,
              name: 'foreman',
              status: 'working' as const,
              sessionId: 'sess-1',
              pid: 4242
            }
          ]
        }
      ],
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) =>
        dwarfId === HELD_FOREMAN_ID
          ? { kind: 'terminal' as const, pid: 4242, sessionName: 'anvil-70' }
          : null
    }
  }

  async function runtimeHolding(held: HeldFake, port: TextDeliveryPort): Promise<AgentRuntime> {
    const fs = new FakeFs()
    fs.addFile(CLAUDE, '#!/bin/sh\n')
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [heldProvider()],
      textDelivery: port,
      heldSessions: new HeldSessionRegistry({
        detector: createCliDetector({ home: '/home/j', platform: 'linux', fs, env: {} }),
        // AMENDED for #237, step 5 (was: `start: held.port`). One engine per
        // provider now that a second held protocol exists; this fake is still
        // the only Claude engine and nothing else here changed.
        start: { claude: held.port },
        now: () => 1_700_000_000_000,
        log: () => {}
      }),
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
    await runtime.refresh()
    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(MINE_PATH),
      prompt: 'dig'
    })
    // The CLI names its own session, and that name is the only link between
    // this stream and the dwarf the poll draws.
    held.reportSessionId('sess-1')
    await runtime.refresh()
    return runtime
  }

  it('kicks a held session through its own session instead of focusing a terminal', async () => {
    const held = heldFake()
    const port = terminalPort()
    const runtime = await runtimeHolding(held, port)

    const result = await runtime.kickDwarf({ dwarfId: HELD_FOREMAN_ID })
    runtime.stop()

    expect(result).toEqual({ delivered: true, via: 'held-session' })
    expect(held.interrupts()).toBe(1)
    // Neither of the two channels the live run went through: the pid owns no
    // window, and the relay's inbox has no REPL to drain it.
    expect(port.sendInterrupt).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('sends a message to a held session through its own session', async () => {
    const held = heldFake()
    const port = terminalPort()
    const runtime = await runtimeHolding(held, port)

    const result = await runtime.sendDwarfText({
      dwarfId: HELD_FOREMAN_ID,
      text: 'dig east',
      pressEnter: true
    })
    runtime.stop()

    expect(result).toEqual({ delivered: true, via: 'held-session' })
    expect(held.sends()).toEqual(['dig east'])
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('says the kick failed rather than claiming a relay hand-over nothing can read', async () => {
    const held = heldFake({ canInterrupt: false })
    const port = terminalPort()
    const runtime = await runtimeHolding(held, port)

    const result = await runtime.kickDwarf({ dwarfId: HELD_FOREMAN_ID })
    runtime.stop()

    expect(result.delivered).toBe(false)
    expect(result.via).toBe('held-session')
    expect(result.error).not.toBeUndefined()
    // The whole point of #210: the honest failure, never the second channel.
    // `delivered` means handed to a queue something reads, and a held session
    // has none (see reaction.ts).
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('says the message failed when the held stream will not take it', async () => {
    const held = heldFake({ streamTakes: false })
    const port = terminalPort()
    const runtime = await runtimeHolding(held, port)

    const result = await runtime.sendDwarfText({
      dwarfId: HELD_FOREMAN_ID,
      text: 'dig east',
      pressEnter: true
    })
    runtime.stop()

    expect(result.delivered).toBe(false)
    expect(result.via).toBe('held-session')
    expect(result.error).not.toBeUndefined()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('publishes held-session as the channel, so the panel offers the route that works', async () => {
    const held = heldFake()
    const runtime = await runtimeHolding(held, terminalPort())
    const dwarf = runtime.getMines()[0]!.dwarfs.find((item) => item.id === HELD_FOREMAN_ID)
    runtime.stop()

    expect(dwarf?.textDelivery).toBe('held-session')
    expect(dwarf?.capabilities).toMatchObject({
      sendText: 'held-session',
      cancel: 'held-session'
    })
  })

  it("cancels a held session's worker by instructing the session, not by aborting its turn", async () => {
    const held = heldFake()
    const port = terminalPort()
    const runtime = await runtimeHolding(held, port)
    held.reportSubagent({
      kind: 'task-started',
      taskId: 'a1',
      taskType: 'local_agent',
      spawnDepth: 1,
      description: 'Explorer'
    })
    await runtime.refresh()

    const result = await runtime.kickDwarf({ dwarfId: HELD_FOREMAN_ID + ':a1' })
    runtime.stop()

    expect(result).toEqual({ delivered: true, via: 'foreman-relay' })
    // A named worker's cancel is an instruction the session reads, so an
    // interrupt would abort the wrong turn — the foreman's own.
    expect(held.interrupts()).toBe(0)
    expect(held.sends()[0]).toContain('[cancel agent Explorer]')
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })
})

/*
 * Add > Other, end to end through the runtime (#194).
 *
 * The reversal this pins: `docs/custom-launch-command.md` refused a custom
 * command because it writes no session store, so no provider could read one and
 * no dwarf could ever be drawn. The maintainer reversed that on 2026-09-04 —
 * the panel observes terminals AND is a terminal itself, and a process the
 * panel HOLDS needs no session file to be observed, because the panel is its
 * stdio. Every test here is about a dwarf nothing on disk knows exists.
 *
 * No test in this block spawns a process: HostedProcessRegistry takes the spawn
 * seam as a port, and the fake below is what stands in for a real child.
 */
describe('AgentRuntime hosting a command of the person’s own (#194)', () => {
  const HOSTED_MINE = 'C:\\work\\hosted'
  const HOSTED_MINE_ID = mineIdForPath(HOSTED_MINE, 'win32')

  /** Stands in for a real child; nothing here reaches node:child_process. */
  class FakeHostedPort {
    readonly started: HostedProcessStartRequest[] = []
    readonly written: string[] = []
    failWith: Error | undefined = undefined
    stdinTakes = true

    readonly start: HostedProcessPort = async (request) => {
      if (this.failWith !== undefined) throw this.failWith
      this.started.push(request)
      return {
        pid: 5150,
        send: (text: string) => {
          if (!this.stdinTakes) return false
          this.written.push(text)
          return true
        }
      }
    }

    emit(text: string): void {
      this.started[0]!.onOutput(text)
    }

    exit(): void {
      this.started[0]!.onEnd('exit 0')
    }
  }

  /**
   * A provider that sees a Claude session in the same folder, so a hosted
   * process can be shown landing in a mine that already exists as well as in
   * one that does not.
   */
  function claudeInHostedMine(): Provider {
    return {
      kind: 'claude',
      scan: vi.fn<Provider['scan']>().mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'sess-1',
          cwd: HOSTED_MINE,
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: 'claude:sess-1',
              provider: 'claude',
              role: 'foreman',
              name: 'hosted-01',
              status: 'working',
              sessionId: 'sess-1'
            }
          ]
        }
      ]),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: () => null
    }
  }

  /** A provider that sees nothing at all: the empty-mine case Add is for. */
  function emptyProvider(): Provider {
    return {
      kind: 'claude',
      scan: vi.fn<Provider['scan']>().mockResolvedValue([]),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: () => null
    }
  }

  async function runtimeWithHost(
    options: { provider?: Provider; endProcessTree?: (pid: number) => Promise<boolean> } = {}
  ) {
    const port = new FakeHostedPort()
    const endProcessTree = options.endProcessTree ?? vi.fn().mockResolvedValue(true)
    const hosted = new HostedProcessRegistry({
      start: port.start,
      endProcessTree,
      env: {}
    })
    // A mutable clock, so the lifecycle's leaving grace can be waited out by
    // hand rather than by a real timer — the house idiom for a module that
    // takes a `now` (see skills/tdd).
    const clock = { now: 1_700_000_000_000 }
    const config = defaultConfig()
    const runtime = new AgentRuntime({
      config,
      providers: [options.provider ?? claudeInHostedMine()],
      hostedProcesses: hosted,
      now: () => clock.now,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return {
      runtime,
      port,
      hosted,
      endProcessTree,
      clock,
      graceMs: config.dwarfLeaveGraceS * 1_000
    }
  }

  function hostedDwarfOf(runtime: AgentRuntime): Dwarf | undefined {
    return runtime
      .getMines()
      .flatMap((mine) => mine.dwarfs)
      .find((dwarf) => dwarf.provider === PANEL_OBSERVER)
  }

  it('refuses a launch into a mine that is not on the board', async () => {
    const { runtime, port } = await runtimeWithHost()

    const result = await runtime.launchHostedProcess({
      mineId: 'mine:nowhere',
      command: 'my-agent',
      prompt: 'dig'
    })

    expect(result.launched).toBe(false)
    expect(port.started).toHaveLength(0)
  })

  /*
   * The prompt is the user's own words, so the argv/stdin split matters most
   * here of all three launch modes — see the privacy rule at the top of
   * launch.ts, and docs/privacy.md on this machine's process list.
   */
  it('starts the parsed program in the mine folder with the prompt on stdin', async () => {
    const { runtime, port } = await runtimeWithHost()

    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent --once',
      prompt: 'dig the east gallery'
    })

    expect(port.started[0]?.program).toBe('my-agent')
    expect(port.started[0]?.args).toEqual(['--once'])
    expect(port.started[0]?.cwd).toBe(HOSTED_MINE)
    expect(port.started[0]?.prompt).toBe('dig the east gallery')
    expect(JSON.stringify(port.started[0]?.args)).not.toContain('east gallery')
  })

  it('repeats the parse’s refusal for a command carrying shell syntax', async () => {
    const { runtime, port } = await runtimeWithHost()

    const result = await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent && rm -rf .',
      prompt: 'dig'
    })

    expect(result.launched).toBe(false)
    expect(result.error).toBe(SHELL_METACHARACTER_REFUSAL)
    expect(port.started).toHaveLength(0)
  })

  /*
   * The reversal, in one assertion: a dwarf for a process no store on this
   * machine has ever heard of, and it appears through the ordinary poll rather
   * than through a second observation path.
   */
  it('draws a dwarf for the held process on the ordinary poll', async () => {
    const { runtime } = await runtimeWithHost()

    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig the east gallery'
    })
    await runtime.refresh()

    const dwarf = hostedDwarfOf(runtime)
    expect(dwarf?.name).toBe('my-agent')
    expect(dwarf?.role).toBe('foreman')
    expect(dwarf?.status).toBe('working')
    expect(dwarf?.conversation?.[0]?.text).toBe('dig the east gallery')
  })

  /*
   * A mine the board does not have is refused rather than invented from an id.
   * The launch names a mine and main resolves the FOLDER from the board, which
   * is what keeps this channel — the one whose program is the caller's own —
   * from being talked into starting somewhere the panel is not showing.
   */
  it('refuses a launch for a folder no mine on the board names', async () => {
    const { runtime, port } = await runtimeWithHost({ provider: emptyProvider() })
    expect(runtime.getMines()).toHaveLength(0)

    const refused = await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })

    expect(refused.launched).toBe(false)
    expect(refused.error).toBe('That mine is no longer on the map.')
    expect(port.started).toHaveLength(0)
  })

  /*
   * The freeze #194 reported, in the shape that outlives the launch: the mine
   * was on the board when the command started, and the session that put it
   * there then finished. Every other launch mode gets its mine from a provider
   * snapshot's `cwd` — the trick docs/console-hosting.md calls "the whole
   * trick" — and a hosted process has no snapshot, so the stamp has to keep
   * the mine standing or the dwarf being held would have nowhere to be drawn.
   */
  it('keeps the mine on the board after the session that discovered it ends', async () => {
    const provider = claudeInHostedMine()
    const { runtime, clock, graceMs } = await runtimeWithHost({ provider })
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()

    // The observed Claude session is gone from disk; only the held process is
    // left, and nothing on this machine records that it exists.
    provider.scan = vi.fn<Provider['scan']>().mockResolvedValue([])
    // Past the leaving grace, which is the point: inside it the lifecycle
    // tracker rebuilds the mine for the departing Claude dwarf, so the mine
    // would still be there for a reason that has nothing to do with hosting.
    await runtime.refresh()
    clock.now += graceMs + 1_000
    await runtime.refresh()

    const mine = runtime.getMines().find((entry) => entry.path === HOSTED_MINE)
    expect(mine?.id).toBe(HOSTED_MINE_ID)
    expect(mine?.dwarfs.map((dwarf) => dwarf.provider)).toEqual([PANEL_OBSERVER])
    expect(hostedDwarfOf(runtime)?.name).toBe('my-agent')
  })

  it('reports the exchange it watched go by on the process’s own pipes', async () => {
    const { runtime, port } = await runtimeWithHost()
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })

    port.emit('starting up')
    await runtime.refresh()

    expect(hostedDwarfOf(runtime)?.conversation?.map((message) => message.text)).toEqual([
      'dig',
      'starting up'
    ])
  })

  it('leaves the dwarfs a provider observed in that mine exactly as they were', async () => {
    const { runtime } = await runtimeWithHost()

    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()

    const observed = runtime
      .getMines()
      .flatMap((mine) => mine.dwarfs)
      .filter((dwarf) => dwarf.provider === 'claude')
    expect(observed.map((dwarf) => dwarf.id)).toEqual(['claude:sess-1'])
  })

  /*
   * The thing a DETACHED launch structurally cannot do (#217's
   * launchedNoInboxReason): its stdin was closed after the prompt. A hosted
   * process still has its pipe in this process's hands.
   */
  it('delivers a typed message onto the stdin it is holding', async () => {
    const { runtime, port } = await runtimeWithHost()
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()
    const dwarfId = hostedDwarfOf(runtime)!.id

    const result = await runtime.sendDwarfText({
      dwarfId,
      text: 'also check the west wall',
      pressEnter: true
    })

    expect(result).toEqual({ delivered: true, via: 'hosted-stdin' })
    expect(port.written).toEqual(['also check the west wall'])
  })

  it('offers the composer and the kick together, which no other launch mode does', async () => {
    const { runtime } = await runtimeWithHost()
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()

    const dwarf = hostedDwarfOf(runtime)!
    expect(dwarf.textDelivery).toBe('hosted-stdin')
    expect(dwarf.capabilities?.sendText).toBe('hosted-stdin')
    expect(dwarf.capabilities?.cancel).toBe('hosted-stdin')
  })

  it('states the failure when the pipe would not take the message', async () => {
    const { runtime, port } = await runtimeWithHost()
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()
    const dwarfId = hostedDwarfOf(runtime)!.id
    port.stdinTakes = false

    const result = await runtime.sendDwarfText({ dwarfId, text: 'hello', pressEnter: true })

    expect(result.delivered).toBe(false)
    expect(result.via).toBe('hosted-stdin')
    expect(result.error).not.toBeUndefined()
  })

  /*
   * Kick ends the process, not a turn, and the panel has to say so (#217's
   * rule, and here for a stronger reason): this app knows nothing about what
   * somebody else's program treats as an interrupt.
   */
  it('ends the process tree on a kick, through the per-OS port', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const { runtime } = await runtimeWithHost({ endProcessTree })
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()
    const dwarfId = hostedDwarfOf(runtime)!.id

    const result = await runtime.kickDwarf({ dwarfId })

    expect(result).toEqual({ delivered: true, via: 'hosted-stdin' })
    expect(endProcessTree).toHaveBeenCalledWith(5150)
  })

  it('never claims to have ended a process the platform refused to kill', async () => {
    const { runtime } = await runtimeWithHost({
      endProcessTree: vi.fn().mockResolvedValue(false)
    })
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()
    const dwarfId = hostedDwarfOf(runtime)!.id

    const result = await runtime.kickDwarf({ dwarfId })

    expect(result.delivered).toBe(false)
    expect(result.error).not.toBeUndefined()
  })

  it('takes a process that exited off the board', async () => {
    const { runtime, port } = await runtimeWithHost()
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })
    await runtime.refresh()

    port.exit()
    await runtime.refresh()

    // Not gone from the board outright: the lifecycle tracker gives it the same
    // leaving grace every other departing dwarf gets, so it walks out instead
    // of blinking off.
    expect(hostedDwarfOf(runtime)?.status).toBe('leaving')
  })

  /*
   * The lifetime bargain, paid where it is made: this panel IS the process's
   * stdio, so one left running after a quit would have nobody reading its
   * output or writing its input. The opposite of the detached register, which
   * stop() deliberately does not touch (#217).
   */
  it('ends every hosted process when the runtime stops', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const { runtime } = await runtimeWithHost({ endProcessTree })
    await runtime.launchHostedProcess({
      mineId: HOSTED_MINE_ID,
      command: 'my-agent',
      prompt: 'dig'
    })

    runtime.stop()
    await Promise.resolve()

    expect(endProcessTree).toHaveBeenCalledWith(5150)
  })

  /*
   * A demo's mines are invented, so there is no folder for a real process to
   * start in — the same refusal a held launch already gives (#42).
   */
  it('starts nothing while the simulated valley is running', async () => {
    const port = new FakeHostedPort()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [claudeInHostedMine()],
      hostedProcesses: new HostedProcessRegistry({
        start: port.start,
        endProcessTree: vi.fn().mockResolvedValue(true),
        env: {}
      }),
      simulationEnv: { [SIMULATION_ENV_VAR]: '1' },
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    const result = await runtime.launchHostedProcess({
      mineId: runtime.getMines()[0]?.id ?? '',
      command: 'my-agent',
      prompt: 'dig'
    })

    expect(result.launched).toBe(false)
    expect(port.started).toHaveLength(0)
  })
})

describe('AgentRuntime observed permission prompts (#203)', () => {
  const PROMPT_MINE = 'C:\X\quarry'
  const CLAUDE_BIN = '/home/j/.local/bin/claude'

  /** A provider reporting one ordinary observed foreman — a session nobody here started. */
  function observedForeman(): Provider {
    return {
      kind: 'claude',
      scan: async () => [
        {
          provider: 'claude' as const,
          sessionId: 'sess-9',
          cwd: PROMPT_MINE,
          status: 'busy' as const,
          updatedAt: 7,
          dwarfs: [
            {
              id: 'claude:sess-9',
              provider: 'claude' as const,
              role: 'foreman' as const,
              name: 'quarry-1',
              status: 'working' as const,
              sessionId: 'sess-9'
            }
          ]
        }
      ],
      feed: async () => []
    }
  }

  function permissionPrompt(sessionId: string): HookEvent {
    return {
      provider: 'claude',
      event: 'Notification',
      sessionId,
      notificationType: 'permission_prompt'
    }
  }

  function reasonOf(runtime: AgentRuntime): Dwarf['waitingReason'] {
    return runtime.getMines()[0]?.dwarfs[0]?.waitingReason
  }

  it('marks the dwarf of the session Claude Code says has a dialog open', async () => {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [observedForeman()],
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    expect(reasonOf(runtime)).toBeUndefined()

    runtime.noteHookEvent(permissionPrompt('sess-9'))
    await runtime.refresh()
    runtime.stop()

    expect(reasonOf(runtime)).toBe('approval')
  })

  it('marks nothing for a hook that named a session the board does not have', async () => {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [observedForeman()],
      onMinesUpdated: vi.fn()
    })
    runtime.noteHookEvent(permissionPrompt('sess-nobody'))
    await runtime.refresh()
    runtime.stop()

    // A hook is never grounds for drawing a dwarf: the board is the providers'
    // to report, and this only ever refines what they already found.
    expect(runtime.getMines()[0]?.dwarfs).toHaveLength(1)
    expect(reasonOf(runtime)).toBeUndefined()
  })

  it('clears the mark when the session reports its turn ended', async () => {
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [observedForeman()],
      onMinesUpdated: vi.fn()
    })
    runtime.noteHookEvent(permissionPrompt('sess-9'))
    await runtime.refresh()
    expect(reasonOf(runtime)).toBe('approval')

    runtime.noteHookEvent({ provider: 'claude', event: 'Stop', sessionId: 'sess-9' })
    await runtime.refresh()
    runtime.stop()

    expect(reasonOf(runtime)).toBeUndefined()
  })

  it('leaves a session this panel holds to its own first-hand evidence', async () => {
    // A held session's prompt reaches this app through canUseTool and is
    // decided from the panel (#246). A hook about the same prompt would be a
    // second, weaker claim about a fact the panel already holds exactly.
    const fs = new FakeFs()
    fs.addFile(CLAUDE_BIN, '#!/bin/sh\n')
    const started: HeldSessionStartRequest[] = []
    const heldSessions = new HeldSessionRegistry({
      detector: createCliDetector({ home: '/home/j', platform: 'linux', fs, env: {} }),
      // AMENDED for #237, step 5: the port is a table keyed by provider.
      start: {
        claude: async (request) => {
          started.push(request)
          return {
            close: () => {},
            send: () => true,
            interrupt: async () => true,
            // #96's addition; this test is about permission prompts, not
            // telemetry, so the fake only has to satisfy the port.
            contextUsage: async () => null
          }
        }
      },
      now: () => 1_700_000_000_000,
      log: () => {}
    })
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [observedForeman()],
      heldSessions,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(PROMPT_MINE),
      prompt: 'dig here'
    })
    started[0]!.onSessionId('sess-9')

    runtime.noteHookEvent(permissionPrompt('sess-9'))
    await runtime.refresh()
    runtime.stop()

    expect(reasonOf(runtime)).toBeUndefined()
  })
})

/**
 * Issue #203. Deciding an OBSERVED session's permission prompt, which is the
 * one decision this app cannot hand over structurally: the dialog belongs to
 * a terminal somebody else is running, so the only answer is a keystroke into
 * that console.
 *
 * Measured on Claude Code 2.1.261 (Windows console): the prompt is a
 * SELECTOR, a digit picks that option and fires it with no Enter, and the
 * first option is always "Yes". So Allow is `1`, and Deny is nothing — "No"
 * is the LAST option and the dialog has two or three of them, so a positional
 * digit would sometimes mean "yes, and don't ask again". Both halves are
 * pinned here: the measured one end to end, the unmeasured one as the refusal
 * it currently is.
 */
describe('AgentRuntime.answerDwarfPermission at an observed terminal (#203)', () => {
  const FOREMAN_ID = 'claude:session-1'
  const TOOL_USE_ID = 'toolu_p1'
  const NOT_VERIFIED =
    'Answering this prompt from the panel is not yet verified for this Claude Code build. ' +
    'Answer it at the terminal.'
  const NO_TERMINAL = 'Could not reach that terminal. Answer the prompt there.'
  const PROMPT_CLOSED = 'That permission request is no longer open.'

  function promptFor(toolUseId: string): DwarfPermissionRequest {
    return {
      toolUseId,
      toolName: 'Bash',
      input: 'pnpm test',
      channel: 'terminal',
      askedAt: '2026-09-05T10:00:00.000Z'
    }
  }

  function fakePort(overrides: Partial<TextDeliveryPort> = {}) {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true }),
      ...overrides
    }
  }

  interface Wiring {
    target?: TextDeliveryTarget | null
    port?: ReturnType<typeof fakePort>
    /** Null draws a dwarf carrying no prompt at all. */
    permission?: DwarfPermissionRequest | null
    /**
     * What every scan AFTER the first one finds, for the re-read guard: the
     * dialog a person answered at their own terminal while the card was up.
     */
    thenPermission?: DwarfPermissionRequest | null
    /** Absent means the shipped measurement: the digit 1 for allow, Esc for deny. */
    keystroke?: (decision: DwarfPermissionDecision) => PermissionKeystroke | null
  }

  async function runtimeWith(wiring: Wiring = {}) {
    const target =
      wiring.target === undefined ? { kind: 'terminal' as const, pid: 42 } : wiring.target
    const port = wiring.port ?? fakePort()
    const first = wiring.permission === undefined ? promptFor(TOOL_USE_ID) : wiring.permission
    let scans = 0
    const source: Provider = {
      kind: 'claude',
      scan: async () => {
        scans += 1
        const permission =
          scans === 1 || wiring.thenPermission === undefined ? first : wiring.thenPermission
        return [
          {
            provider: 'claude' as const,
            sessionId: 'session-1',
            cwd: 'C:\\work\\project',
            status: 'busy' as const,
            updatedAt: 1,
            dwarfs: [
              {
                id: FOREMAN_ID,
                provider: 'claude' as const,
                role: 'foreman' as const,
                name: 'boss',
                status: 'waiting' as const,
                waitingReason: 'approval' as const,
                sessionId: 'session-1',
                pid: 42,
                ...(permission === null ? {} : { pendingPermission: permission })
              }
            ]
          }
        ]
      },
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) => (dwarfId === FOREMAN_ID ? target : null)
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      ...(wiring.keystroke === undefined ? {} : { permissionKeystroke: wiring.keystroke })
    })
    await runtime.refresh()
    return { runtime, port }
  }

  function decide(runtime: AgentRuntime, decision: 'allow' | 'deny', toolUseId = TOOL_USE_ID) {
    return runtime.answerDwarfPermission({ dwarfId: FOREMAN_ID, toolUseId, decision })
  }

  it('answers Allow with the digit that picks the first option, and no Enter', async () => {
    // The shipped path. A digit fires the selection on its own, so pressEnter
    // stays false — it is what a MESSAGE ends with, and on a session whose
    // dialog was answered a second ago it would submit the input box.
    const { runtime, port } = await runtimeWith()

    await expect(decide(runtime, 'allow')).resolves.toEqual({ answered: true })
    expect(port.sendToConsole).toHaveBeenCalledWith({ pid: 42, text: '1', pressEnter: false })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('answers Deny with Escape, through the port method that presses it', async () => {
    // "No" is the LAST option and the dialog has two, three or four of them
    // depending on the tool, so no digit means No — on a four-option dialog
    // `2` is "Yes, and always allow …", a standing permission granted by the
    // button that refuses. Esc cancels the prompt whatever it drew, and
    // sendInterrupt is already the raw-Esc path, built per platform for Kick.
    const { runtime, port } = await runtimeWith()

    await expect(decide(runtime, 'deny')).resolves.toEqual({ answered: true })
    expect(port.sendInterrupt).toHaveBeenCalledWith({ pid: 42 })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('asks the keystroke seam for the decision it was actually given', async () => {
    const seen: string[] = []
    const { runtime, port } = await runtimeWith({
      keystroke: (decision) => {
        seen.push(decision)
        return { kind: 'text', text: decision === 'allow' ? '1' : '9' }
      }
    })

    await decide(runtime, 'deny')
    expect(seen).toEqual(['deny'])
    expect(port.sendToConsole).toHaveBeenCalledWith({ pid: 42, text: '9', pressEnter: false })
  })

  it('refuses in words when a decision has no measured key on this build', async () => {
    // The branch that let Allow ship while Deny was still being established,
    // and the one a future build's regression would be recorded through. It
    // names the BUILD rather than the app, because that is the true shape of
    // it, and points where every refusal on this route points.
    const { runtime, port } = await runtimeWith({ keystroke: () => null })

    await expect(decide(runtime, 'deny')).resolves.toEqual({
      answered: false,
      error: NOT_VERIFIED
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('re-reads the board and refuses when the dialog moved on while the card was up', async () => {
    // THE guard. A digit fires whatever option is under it in whatever dialog
    // is up, so a `1` one dialog late does not miss — it approves the NEXT
    // tool call, unread. Somebody answering at their own terminal and the
    // session opening its next prompt is exactly that, and the panel's card
    // can be a poll behind it.
    const { runtime, port } = await runtimeWith({ thenPermission: promptFor('toolu_next') })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: PROMPT_CLOSED
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('re-reads the board and refuses when no dialog is open any more', async () => {
    const { runtime, port } = await runtimeWith({ thenPermission: null })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: PROMPT_CLOSED
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('never falls back to the relay when the console will not take the key', async () => {
    // A message that fails at the console can be relayed, and a decision
    // cannot: a relay hands text to the session's QUEUE, which is read
    // between tool calls, and this session is stopped INSIDE one. The queued
    // sentence would arrive after the dialog had been answered by somebody
    // else, and the ✓ would have claimed a decision nobody made.
    const port = fakePort({
      sendToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'no window' })
    })
    const { runtime } = await runtimeWith({
      target: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' },
      port
    })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: NO_TERMINAL
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  /**
   * #308's regression guard. A permission decision is a KEYSTROKE, so it takes
   * the route the kick takes and not the one a message takes: since #308 a
   * named session's MESSAGE leaves over the relay, and a decision read off
   * that route would have found a relay endpoint, refused for want of a
   * console, and left every observed dialog unanswerable from the panel.
   */
  it('still types at the console of a named session, whose messages now go by relay', async () => {
    const { runtime, port } = await runtimeWith({
      target: { kind: 'terminal', pid: 42, sessionName: 'sample-project-70' }
    })

    await expect(decide(runtime, 'allow')).resolves.toEqual({ answered: true })
    expect(port.sendToConsole).toHaveBeenCalledWith({ pid: 42, text: '1', pressEnter: false })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses without typing anything when the dwarf has no console at all', async () => {
    const { runtime, port } = await runtimeWith({
      target: { kind: 'claude-relay', sessionName: 'x' }
    })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: NO_TERMINAL
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses when no channel resolves for the dwarf at all', async () => {
    const { runtime, port } = await runtimeWith({ target: null })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: NO_TERMINAL
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('refuses a decision aimed at a prompt that was already not the open one', async () => {
    // The cheap half of the same rule, taken before the rescan: the card the
    // person pressed named a prompt the board had already replaced.
    const { runtime, port } = await runtimeWith()

    await expect(decide(runtime, 'allow', 'toolu_stale')).resolves.toEqual({
      answered: false,
      error: PROMPT_CLOSED
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('types nothing for a dwarf that has left the mine', async () => {
    const { runtime, port } = await runtimeWith()

    await expect(
      runtime.answerDwarfPermission({
        dwarfId: 'claude:ghost',
        toolUseId: TOOL_USE_ID,
        decision: 'allow'
      })
    ).resolves.toMatchObject({ answered: false })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('says the prompt closed for an observed dwarf carrying none, not that it is unheld', async () => {
    // The card was pressed after main stopped naming a prompt. The held
    // registry's own refusal — "that session is not one this panel is
    // holding" — is true and is not what happened.
    const { runtime, port } = await runtimeWith({ permission: null })

    await expect(decide(runtime, 'allow')).resolves.toEqual({
      answered: false,
      error: PROMPT_CLOSED
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })
})

/**
 * Every worktree of one repository is one mine — the main working tree's
 * (#348). The board is a map of projects, and a worktree is a place a project
 * is being worked on; five terminals in five worktrees are five dwarfs in ONE
 * mine, each still knowing which folder it is actually in.
 */
describe('AgentRuntime worktree folding (#348)', () => {
  const ROOT = 'C:\\Code\\Anvil'
  const FORGE = 'C:\\Code\\Anvil-worktrees\\forge'
  const BELL = 'C:\\Code\\Anvil-worktrees\\bell'

  /** One repository with two linked worktrees, laid out exactly as git does. */
  function repoFs(): FakeFs {
    const fs = new FakeFs()
    fs.addFile('C:/Code/Anvil/.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('C:/Code/Anvil/README.md', '#')
    for (const [name, branch] of [
      ['forge', 'feat/forge'],
      ['bell', 'feat/bell']
    ]) {
      fs.addFile(
        'C:/Code/Anvil-worktrees/' + name + '/.git',
        'gitdir: C:/Code/Anvil/.git/worktrees/' + name + '\n'
      )
      fs.addFile('C:/Code/Anvil/.git/worktrees/' + name + '/commondir', '../..\n')
      fs.addFile(
        'C:/Code/Anvil/.git/worktrees/' + name + '/HEAD',
        'ref: refs/heads/' + branch + '\n'
      )
    }
    return fs
  }

  function sessionIn(cwd: string, sessionId: string, tokens = 0): ProviderSnapshot {
    return {
      provider: 'claude',
      sessionId,
      cwd,
      status: 'busy',
      updatedAt: 7,
      dwarfs: [
        {
          id: 'claude:' + sessionId,
          provider: 'claude',
          role: 'foreman',
          name: sessionId,
          status: 'working',
          sessionId,
          tokensObserved: tokens
        }
      ]
    }
  }

  function runtimeOver(snapshots: ProviderSnapshot[], fs: FsLike, extra = {}): AgentRuntime {
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [
        { kind: 'claude', scan: vi.fn().mockResolvedValue(snapshots), feed: vi.fn() } as Provider
      ],
      fs,
      onMinesUpdated: vi.fn(),
      now: () => 9_000,
      ...extra
    })
  }

  it('shows ONE mine, named after the main folder, for sessions in two worktrees', async () => {
    const runtime = runtimeOver([sessionIn(FORGE, 's1'), sessionIn(BELL, 's2')], repoFs())

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines).toHaveLength(1)
    expect(mines[0]!.path).toBe(ROOT)
    expect(mines[0]!.name).toBe('Anvil')
    expect(mines[0]!.id).toBe(mineIdForPath(ROOT))
    expect(mines[0]!.dwarfs.map((dwarf) => dwarf.id).sort()).toEqual(['claude:s1', 'claude:s2'])
  })

  it('keeps each dwarf pointed at the worktree it is actually in, with its branch', async () => {
    const runtime = runtimeOver([sessionIn(FORGE, 's1'), sessionIn(BELL, 's2')], repoFs())

    await runtime.refresh()
    const crew = runtime.getMines()[0]!.dwarfs
    runtime.stop()

    expect(crew.find((dwarf) => dwarf.id === 'claude:s1')!.workplace).toEqual({
      path: FORGE,
      branch: 'feat/forge'
    })
    expect(crew.find((dwarf) => dwarf.id === 'claude:s2')!.workplace).toEqual({
      path: BELL,
      branch: 'feat/bell'
    })
  })

  it('leaves a session in the main working tree with no workplace at all', async () => {
    const runtime = runtimeOver([sessionIn(ROOT, 's1')], repoFs())

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines[0]!.path).toBe(ROOT)
    expect(mines[0]!.dwarfs[0]!.workplace).toBeUndefined()
  })

  it('gives a submodule its own mine, exactly as before', async () => {
    const fs = repoFs()
    fs.addFile('C:/Code/Anvil/vendor/lib/.git', 'gitdir: ../../.git/modules/lib\n')
    fs.addFile('C:/Code/Anvil/.git/modules/lib/HEAD', 'ref: refs/heads/main\n')
    const runtime = runtimeOver([sessionIn('C:\\Code\\Anvil\\vendor\\lib', 's1')], fs)

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines.map((mine) => mine.path)).toEqual(['C:\\Code\\Anvil\\vendor\\lib'])
  })

  it('sums the crew of every worktree into the one mine it folded them into', async () => {
    // Tokens are counted per dwarf and belong to the project the work was done
    // for. Which mine a count belongs to is the only thing folding changes;
    // nothing is converted and nothing crosses a material.
    const runtime = runtimeOver(
      [sessionIn(FORGE, 's1', 1_000), sessionIn(BELL, 's2', 2_500)],
      repoFs()
    )

    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines[0]!.tokensObserved).toBe(3_500)
  })

  it('resolves a clicked path against the DWARF s worktree, not the project folder', async () => {
    const runtime = runtimeOver([sessionIn(FORGE, 's1'), sessionIn(BELL, 's2')], repoFs())

    await runtime.refresh()
    const id = mineIdForPath(ROOT)
    const forge = runtime.mineFolderOf(id, 'claude:s1')
    const bell = runtime.mineFolderOf(id, 'claude:s2')
    const noDwarf = runtime.mineFolderOf(id)
    const strangerId = runtime.mineFolderOf(id, 'claude:not-here')
    runtime.stop()

    expect(forge).toBe(FORGE)
    expect(bell).toBe(BELL)
    // No dwarf named, and a dwarf this mine has not got, both fall back to the
    // project's own folder — never to another mine's crew.
    expect(noDwarf).toBe(ROOT)
    expect(strangerId).toBe(ROOT)
  })

  it('reads a folded mine s history from the project AND every worktree its crew is in', async () => {
    const readAcross = vi.fn().mockResolvedValue([])
    const runtime = runtimeOver([sessionIn(FORGE, 's1'), sessionIn(BELL, 's2')], repoFs(), {
      history: { read: vi.fn(), readAcross }
    })

    await runtime.refresh()
    await runtime.mineHistory(mineIdForPath(ROOT))
    runtime.stop()

    expect(readAcross).toHaveBeenCalledWith([ROOT, FORGE, BELL])
  })
})

/**
 * A worktree the user declared before #348 landed. The board folds it on read,
 * and the store learns the project on the next write.
 */
describe('AgentRuntime declared worktrees (#348, #169)', () => {
  const ROOT = 'C:\\Code\\Anvil'
  const FORGE = 'C:\\Code\\Anvil-worktrees\\forge'

  function repoFs(): FakeFs {
    const fs = new FakeFs()
    fs.addFile('C:/Code/Anvil/.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('C:/Code/Anvil-worktrees/forge/.git', 'gitdir: C:/Code/Anvil/.git/worktrees/forge\n')
    fs.addFile('C:/Code/Anvil/.git/worktrees/forge/commondir', '../..\n')
    fs.addFile('C:/Code/Anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
    return fs
  }

  function runtimeWithStore(projects: ProjectsStore, fs: FsLike): AgentRuntime {
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [],
      projects,
      fs,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  it('draws a declared worktree as its project, on the very first read', async () => {
    const projects = createProjectsStore({
      filePath: 'C:\\userData\\projects-v1.db',
      sqlite: new MemoryWritableSqlite()
    })
    await projects.declare({ path: FORGE, at: 1 })
    const runtime = runtimeWithStore(projects, repoFs())

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    runtime.stop()

    expect(mines.map((mine) => mine.path)).toEqual([ROOT])
    expect(mines[0]!.declared).toBe(true)
  })

  it('teaches the store the project, and stops the worktree row drawing a card', async () => {
    const projects = createProjectsStore({
      filePath: 'C:\\userData\\projects-v1.db',
      sqlite: new MemoryWritableSqlite()
    })
    await projects.declare({ path: FORGE, at: 1 })
    const runtime = runtimeWithStore(projects, repoFs())

    await runtime.loadDeclared()
    const rows = await projects.list()
    runtime.stop()

    const byId = new Map((rows.ok ? rows.value : []).map((row) => [row.id, row]))
    expect(byId.get(mineIdForPath(ROOT))?.origin).toBe('declared')
    expect(byId.get(mineIdForPath(ROOT))?.hiddenAt).toBeNull()
    // FLAGGED, never deleted: the row keeps the ore already credited to that
    // folder's mine id (see ProjectsStore.forget).
    expect(byId.get(mineIdForPath(FORGE))?.hiddenAt).not.toBeNull()
  })

  /**
   * The case #348 asked to be decided out loud. A hidden worktree row is left
   * exactly as it is, and its hiding is NEVER carried up to the project:
   * "hide this branch's folder" must not take the whole repository off the
   * board, which is a disappearance with no card left to bring it back from.
   */
  it('never lets a HIDDEN worktree hide the project it folds into', async () => {
    const projects = createProjectsStore({
      filePath: 'C:\\userData\\projects-v1.db',
      sqlite: new MemoryWritableSqlite()
    })
    await projects.declare({ path: FORGE, at: 1 })
    await projects.forget({ id: mineIdForPath(FORGE), at: 2 })
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [
        {
          kind: 'claude',
          scan: vi.fn().mockResolvedValue([
            {
              provider: 'claude' as const,
              sessionId: 's1',
              cwd: FORGE,
              status: 'busy' as const,
              updatedAt: 7,
              dwarfs: [
                {
                  id: 'claude:s1',
                  provider: 'claude' as const,
                  role: 'foreman' as const,
                  name: 's1',
                  status: 'working' as const,
                  sessionId: 's1'
                }
              ]
            }
          ]),
          feed: vi.fn()
        } as Provider
      ],
      projects,
      fs: repoFs(),
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })

    await runtime.loadDeclared()
    await runtime.refresh()
    const mines = runtime.getMines()
    const rows = await projects.list()
    runtime.stop()

    // The project is on the board with its crew, and it is NOT hidden: the
    // flag on the worktree row stayed where it was.
    expect(mines.map((mine) => mine.path)).toEqual([ROOT])
    expect(mines[0]!.dwarfs).toHaveLength(1)
    const byId = new Map((rows.ok ? rows.value : []).map((row) => [row.id, row]))
    expect(byId.get(mineIdForPath(FORGE))?.hiddenAt).not.toBeNull()
    // The project's own row is the observer's ordinary sighting of a mine with
    // a crew in it — DISCOVERED, never declared on the user's behalf, because
    // they never declared this project, only one of its worktrees.
    const project = byId.get(mineIdForPath(ROOT))
    expect(project?.origin).toBe('discovered')
    expect(project?.hiddenAt).toBeNull()
  })
})

/**
 * Adding a folder that turns out to be a worktree (#348). The runtime asks
 * rather than declaring: the board folds every worktree into its project, so a
 * row for the worktree would name a folder that is never a mine.
 */
describe('AgentRuntime.declareMine — worktrees (#348)', () => {
  const ROOT = 'C:\\Code\\Anvil'
  const FORGE = 'C:\\Code\\Anvil-worktrees\\forge'

  function repoFs(head = 'ref: refs/heads/feat/forge\n'): FakeFs {
    const fs = new FakeFs()
    fs.addFile('C:/Code/Anvil/.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('C:/Code/Anvil-worktrees/forge/.git', 'gitdir: C:/Code/Anvil/.git/worktrees/forge\n')
    fs.addFile('C:/Code/Anvil/.git/worktrees/forge/commondir', '../..\n')
    fs.addFile('C:/Code/Anvil/.git/worktrees/forge/HEAD', head)
    return fs
  }

  function runtimeFor(picked: string, fs: FakeFs, projects?: ProjectsStore): AgentRuntime {
    return new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 0 },
      providers: [],
      projects:
        projects ??
        createProjectsStore({
          filePath: 'C:\\userData\\projects-v1.db',
          sqlite: new MemoryWritableSqlite()
        }),
      chooseDirectory: async () => picked,
      fs,
      onMinesUpdated: vi.fn(),
      now: () => 9_000
    })
  }

  it('asks about a picked worktree instead of declaring it', async () => {
    const projects = createProjectsStore({
      filePath: 'C:\\userData\\projects-v1.db',
      sqlite: new MemoryWritableSqlite()
    })
    const runtime = runtimeFor(FORGE, repoFs(), projects)

    const result = await runtime.declareMine()
    const rows = await projects.list()
    runtime.stop()

    expect(result).toEqual({
      outcome: 'worktree-of',
      worktreeOf: { worktree: FORGE, root: ROOT, branch: 'feat/forge' }
    })
    // Nothing was written: the question has not been answered yet.
    expect(rows.ok ? rows.value : []).toEqual([])
  })

  it('names the commit of a detached worktree, which has no branch to name', async () => {
    const runtime = runtimeFor(FORGE, repoFs('3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a\n'))

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result.worktreeOf).toEqual({ worktree: FORGE, root: ROOT, commit: '3f2a1b9' })
  })

  it('declares a picked MAIN working tree with no question at all', async () => {
    const runtime = runtimeFor(ROOT, repoFs())

    const result = await runtime.declareMine()
    runtime.stop()

    expect(result).toMatchObject({ outcome: 'added', mineId: mineIdForPath(ROOT) })
  })

  it('adopts the project on the answer, and lands exactly where a plain Add lands', async () => {
    const runtime = runtimeFor(FORGE, repoFs())

    await runtime.declareMine()
    const result = await runtime.declareMainProject()
    runtime.stop()

    expect(result).toMatchObject({ outcome: 'added', mineId: mineIdForPath(ROOT) })
    expect(result.project).toMatchObject({ id: mineIdForPath(ROOT), path: ROOT, declared: true })
  })

  it('refuses an answer to a question nobody asked, and never guesses a folder', async () => {
    const runtime = runtimeFor(FORGE, repoFs())

    const result = await runtime.declareMainProject()
    runtime.stop()

    expect(result.outcome).toBe('failed')
    expect(result.reason).toBeDefined()
  })

  it('forgets the project once it is used, so a second press adopts nothing', async () => {
    const runtime = runtimeFor(FORGE, repoFs())

    await runtime.declareMine()
    await runtime.declareMainProject()
    const again = await runtime.declareMainProject()
    runtime.stop()

    expect(again.outcome).toBe('failed')
  })
})
