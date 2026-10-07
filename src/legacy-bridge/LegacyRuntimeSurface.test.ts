// layer: L2
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../main/adapters/fakeFs'
import { defaultConfig } from '../main/config/config'
import { mineIdForPath } from '../main/domain/aggregate'
import type { Dwarf, Mine, ProviderSnapshot } from '../main/domain/types'
import type { HookEvent } from '../main/hooks/hookPayload'
import { createCliDetector } from '../main/platform/cliDetection'
import { worktreePlatformAdapters } from '../main/platform/fakePlatformAdapters'
import type { Provider } from '../main/providers/provider'
import { AgentRuntime } from '../main/runtime/runtime'
import type { HeldSessionStartRequest } from '../main/sessionLaunch/heldSession'
import { HeldSessionRegistry } from '../main/sessionLaunch/heldSessionRegistry'
import type { DwarfPermissionAnswerRequest } from '../shared/contracts'
import {
  createLegacyAgentRegistryFeed,
  LEGACY_FEED_PROVIDERS_CUT_1,
  type LegacyRuntimeSurface
} from './LegacyAgentRegistryFeed'
import { createLegacyAskRelay, legacyOpenAsksOf } from './LegacyAskRelay'
import { createLegacyRegistryTap } from './LegacyDwarfIdBridge'
import {
  boardSessions,
  createLegacyRuntimeSurface,
  legacyBoardOf,
  type LegacyBoardSource
} from './LegacyRuntimeSurface'

// L2 (17 §1): the production `LegacyRuntimeSurface` (21 §3 `LegacyRuntimeRoute`, `LegacyAgentRegistryFeed`,
// `LegacyAskRelay`; ISSUE-123 stage (a), lead resolution H2). Today's runtime is the real `AgentRuntime` over a stub
// provider (the raw transcript reading) and the real held registry over a fake Agent SDK port, never started: the feed's
// cycles are the only ticks. The relay joins legacy ids to Host ids through a fixed join (the real join is
// `LegacyDwarfIdBridge`'s, proven in its own suite). TC-123-01 (no legacy publish, crediting or notifier composed through
// the feed), TC-123-02 (board parity: open ask cards, a legacy Claude permission included).

const QUARRY = 'C:\\X\\quarry'
const CLAUDE_BIN = '/home/j/.local/bin/claude'
const HELD = 'sess-held'
const OBSERVED = 'sess-obs'

/** A Claude foreman of `sessionId` in the quarry, as today's provider reads it off the transcript tail. */
function foreman(sessionId: string, extra: Partial<Dwarf> = {}): Dwarf {
  return {
    id: `claude:${sessionId}`,
    provider: 'claude',
    role: 'foreman',
    name: sessionId,
    status: 'waiting',
    sessionId,
    ...extra
  }
}

/** A permission call the transcript tail shows unanswered (`'terminal'`: the provider's own channel). */
function tailPermission(toolUseId: string): NonNullable<Dwarf['pendingPermission']> {
  return {
    toolUseId,
    toolName: 'Bash',
    input: 'rm -rf build',
    channel: 'terminal',
    askedAt: '2026-10-07T10:00:00.000Z'
  }
}

/**
 * Today's raw reading: the held session's tail still shows a permission call (a candidate the held stream already
 * answered), and an observed session's tail shows one Claude Code's hook may confirm.
 */
function rawProvider(): Provider {
  const session = (sessionId: string, dwarf: Dwarf): ProviderSnapshot => ({
    provider: 'claude',
    sessionId,
    cwd: QUARRY,
    status: 'waiting',
    updatedAt: 7,
    dwarfs: [dwarf]
  })
  return {
    kind: 'claude',
    scan: async () => [
      session(HELD, foreman(HELD, { pendingPermission: tailPermission('toolu_raw') })),
      session(OBSERVED, foreman(OBSERVED, { pendingPermission: tailPermission('toolu_obs') }))
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

/** Today's runtime, never started, with a held registry over a fake Agent SDK port. */
function todaysRuntime() {
  const fs = new FakeFs()
  fs.addFile(CLAUDE_BIN, '#!/bin/sh\n')
  const started: HeldSessionStartRequest[] = []
  const heldSessions = new HeldSessionRegistry({
    detector: createCliDetector({ home: '/home/j', platform: 'linux', fs, env: {} }),
    start: {
      claude: async (request) => {
        started.push(request)
        return {
          close: () => {},
          send: () => true,
          interrupt: async () => true,
          contextUsage: async () => null
        }
      }
    },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  const runtime = new AgentRuntime({
    fs: new FakeFs(),
    config: defaultConfig(),
    providers: [rawProvider()],
    heldSessions,
    platformAdapters: worktreePlatformAdapters(),
    onMinesUpdated: () => {}
  })
  return { runtime, started }
}

/**
 * The cut-1 composition the root builds over the surface (index.ts `composeLegacyDwarfIdBridge`,
 * `composeLegacyAskRelay`, `composeLegacyAgentRegistryFeed`): the feed writes through the tap, and the relay re-reads
 * today's open asks after each write. Legacy dwarf `x` joins Host dwarf `host:x`.
 */
function cut1Composition(runtime: AgentRuntime) {
  const surface = createLegacyRuntimeSurface(legacyBoardOf(() => runtime, 2_000))
  const tap = createLegacyRegistryTap(surface.registry)
  const relay = createLegacyAskRelay({
    bridge: {
      toHost: async (legacyId) => `host:${legacyId}`,
      toLegacy: async (hostId) => (hostId.startsWith('host:') ? hostId.slice('host:'.length) : null)
    },
    asks: { openAsks: () => legacyOpenAsksOf(tap.sessions()) },
    // Today's A-41 handler (LegacyRuntimeRoute: `parsePermissionRequest` then `runtime.answerDwarfPermission`).
    legacy: {
      serve: async (channel, payload) =>
        channel === 'agent:answerPermission'
          ? runtime.answerDwarfPermission(payload as DwarfPermissionAnswerRequest)
          : undefined
    },
    changed: () => {}
  })
  let reading: Promise<void> = Promise.resolve()
  const feed = createLegacyAgentRegistryFeed({
    legacy: {
      ...surface,
      registry: {
        replace(sessions) {
          tap.registry.replace(sessions)
          reading = relay.update()
        }
      }
    },
    modes: LEGACY_FEED_PROVIDERS_CUT_1,
    timers: { every: () => () => {} }
  })
  return {
    relay,
    async cycle() {
      await feed.refresh()
      await reading
    }
  }
}

describe('the production LegacyRuntimeSurface over today’s runtime (21 §3; ISSUE-123 stage a)', () => {
  it('[ADR-001] a held session’s live question shows as an ask card and the permission its transcript tail still shows does not', async () => {
    const { runtime, started } = todaysRuntime()
    const { relay, cycle } = cut1Composition(runtime)
    await cycle()
    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(QUARRY, 'win32'),
      prompt: 'dig'
    })
    started[0]?.onSessionId(HELD)
    void started[0]?.onAsk('toolu_live', {
      questions: [
        {
          question: 'Which colour?',
          multiSelect: false,
          options: [{ label: 'Green' }, { label: 'Red' }]
        }
      ]
    })
    await Promise.resolve()

    await cycle()
    const card = relay.askFields(`host:claude:${HELD}`)
    runtime.stop()

    expect(card.pendingQuestion?.toolUseId).toBe('legacy:toolu_live')
    expect(card.pendingQuestion?.channel).toBe('held')
    expect(card.pendingPermission).toBeUndefined()
  })

  it('[ADR-001] an observed session’s permission confirmed by Claude Code’s hook shows with today’s approval reason', async () => {
    const { runtime } = todaysRuntime()
    const { relay, cycle } = cut1Composition(runtime)

    runtime.noteHookEvent(permissionPrompt(OBSERVED))
    await cycle()
    const card = relay.askFields(`host:claude:${OBSERVED}`)
    runtime.stop()

    expect(card.pendingPermission?.toolUseId).toBe('legacy:toolu_obs')
    expect(card.waitingReason).toBe('approval')
  })

  it('[ADR-010] with today’s poll never started, an answer to a held permission card reaches today’s handler, which finds its dwarf', async () => {
    const { runtime, started } = todaysRuntime()
    const { relay, cycle } = cut1Composition(runtime)
    await cycle()
    await runtime.launchHeldSession({
      provider: 'claude',
      mineId: mineIdForPath(QUARRY, 'win32'),
      prompt: 'dig'
    })
    started[0]?.onSessionId(HELD)
    const decided = started[0]?.onPermission({
      toolUseId: 'toolu_held',
      toolName: 'Bash',
      input: { command: 'pnpm test' }
    })
    await Promise.resolve()
    await cycle()

    const answer = await relay.serve('agent:answerPermission', {
      dwarfId: `host:claude:${HELD}`,
      toolUseId: 'legacy:toolu_held',
      decision: 'allow'
    })
    runtime.stop()

    expect(answer).toEqual({ answered: true })
    await expect(decided).resolves.toEqual({ decision: 'allow' })
  })

  it('[ADR-001] each provider’s discovery lists only its own sessions of today’s board, after one tick of today’s poll per feed cycle', async () => {
    const worker: Dwarf = {
      id: 'claude:s-1:agent-7',
      provider: 'claude',
      role: 'worker',
      name: 'agent-7',
      status: 'working',
      sessionId: 's-1'
    }
    const board: Mine[] = [
      {
        id: 'mine-1',
        path: '/work/moria',
        name: 'moria',
        tier: 'bronze',
        tokensObserved: 0,
        updatedAt: 11,
        dwarfs: [
          foreman('s-1'),
          worker,
          {
            id: 'codex:t-1',
            provider: 'codex',
            role: 'foreman',
            name: 't-1',
            status: 'waiting',
            sessionId: 't-1'
          },
          // A command this panel hosts (#194): no provider's session, so no provider lists it.
          {
            id: 'panel:h-1',
            provider: 'panel',
            role: 'foreman',
            name: 'my-cli',
            status: 'working',
            sessionId: 'h-1'
          }
        ]
      }
    ]
    let ticks = 0
    const source: LegacyBoardSource = {
      pollIntervalMs: 2_000,
      refresh: async () => {
        ticks += 1
      },
      current: () => board
    }
    const surface = createLegacyRuntimeSurface(source)
    const written: ProviderSnapshot[][] = []
    const feed = createLegacyAgentRegistryFeed({
      legacy: { ...surface, registry: { replace: (s) => written.push([...s]) } },
      modes: LEGACY_FEED_PROVIDERS_CUT_1,
      timers: { every: () => () => {} }
    })

    await feed.refresh()
    const claude = await surface.discovery.find((p) => p.kind === 'claude')?.scan()

    expect(surface.discovery.map((p) => p.kind).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'opencode'].sort()
    )
    expect(surface.pollIntervalMs).toBe(2_000)
    expect(ticks).toBe(2)
    expect(claude).toEqual([
      {
        provider: 'claude',
        sessionId: 's-1',
        cwd: '/work/moria',
        status: 'busy',
        dwarfs: [foreman('s-1'), worker],
        updatedAt: 11
      }
    ])
    expect(written).toEqual([
      [
        {
          provider: 'claude',
          sessionId: 's-1',
          cwd: '/work/moria',
          status: 'busy',
          dwarfs: [foreman('s-1'), worker],
          updatedAt: 11
        },
        {
          provider: 'codex',
          sessionId: 't-1',
          cwd: '/work/moria',
          status: 'waiting',
          dwarfs: [board[0]!.dwarfs[2]!],
          updatedAt: 11
        }
      ]
    ])
    expect(boardSessions(board)).toEqual(written[0])
  })

  it('[ADR-001] the surface composes none of today’s board publish, crediting, projects store or notifier', () => {
    const surface: LegacyRuntimeSurface = createLegacyRuntimeSurface({
      pollIntervalMs: 2_000,
      refresh: async () => {},
      current: () => []
    })

    expect(() => surface.board.publish([])).toThrow(/never composed/)
    expect(() => surface.ledger.credit([])).toThrow(/never composed/)
    expect(() => surface.projects.record([])).toThrow(/never composed/)
    expect(() => surface.notifier.update([])).toThrow(/never composed/)
  })
})
