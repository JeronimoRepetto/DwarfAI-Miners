// layer: L2
import { describe, expect, it } from 'vitest'
import type { Dwarf, DwarfProvider, ProviderSnapshot } from '../main/domain/types'
import {
  createLegacyAgentRegistryFeed,
  LEGACY_FEED_PROVIDERS_CUT_1,
  type LegacyFeedModes,
  type LegacyRuntimeSurface
} from './LegacyAgentRegistryFeed'

// L2 (17 §1): `LegacyAgentRegistryFeed` (21 §3, cuts 1–4; ADR-001 Consequences, IR-21-07) over a fake legacy
// runtime: each legacy provider's discovery (`scan()`, which for Codex also reads the pending questions) is scripted,
// and every other part of today's observer (board publish, ledger crediting, projects store, notifier) records what
// reaches it. The feed composes only the discovery into the legacy agent registry. TC-087-01, TC-087-02.

const MINE_PATH = '/work/moria'

function dwarf(provider: DwarfProvider, sessionId: string, extra: Partial<Dwarf> = {}): Dwarf {
  return {
    id: `${provider}:${sessionId}`,
    provider,
    role: 'worker',
    name: `${provider}-${sessionId}`,
    status: 'working',
    sessionId,
    ...extra
  }
}

function snapshot(
  provider: DwarfProvider,
  sessionId: string,
  extra: Partial<Dwarf> = {}
): ProviderSnapshot {
  return {
    provider,
    sessionId,
    cwd: MINE_PATH,
    status: 'busy',
    dwarfs: [dwarf(provider, sessionId, extra)],
    updatedAt: 1
  }
}

/** A Codex session blocked on a question (the Codex pending-question reader of `LegacyAskRelay`). */
const QUESTION: NonNullable<Dwarf['pendingQuestion']> = {
  toolUseId: 'call-1',
  channel: 'terminal',
  questions: [{ question: 'Which seam?', multiSelect: false, options: [] }]
}

/** Today's runtime as the feed meets it: scripted discovery per provider, every other part recording. */
function fakeLegacyRuntime(scans: Partial<Record<DwarfProvider, ProviderSnapshot[]>>) {
  const scanned: DwarfProvider[] = []
  const registry: ProviderSnapshot[][] = []
  const writes = { board: 0, ledger: 0, projects: 0, notifier: 0 }
  const surface: LegacyRuntimeSurface = {
    pollIntervalMs: 2_000,
    discovery: (Object.keys(scans) as DwarfProvider[]).map((kind) => ({
      kind,
      scan: async () => {
        scanned.push(kind)
        return scans[kind] ?? []
      }
    })),
    registry: { replace: (sessions) => void registry.push([...sessions]) },
    board: { publish: () => void writes.board++ },
    ledger: { credit: () => void writes.ledger++ },
    projects: { record: () => void writes.projects++ },
    notifier: { update: () => void writes.notifier++ }
  }
  return { surface, scanned, registry, writes }
}

/** A hand-driven interval: `fire()` runs the registered cycle once. */
function fakeInterval() {
  let run: (() => void) | null = null
  return {
    every: (_ms: number, cycle: () => void) => {
      run = cycle
      return () => (run = null)
    },
    fire: () => run?.(),
    running: () => run !== null
  }
}

describe('LegacyAgentRegistryFeed', () => {
  it('[ADR-001] discovered sessions reach only the legacy agent registry and nothing is written to the projects store or the ledger', async () => {
    const legacy = fakeLegacyRuntime({
      claude: [snapshot('claude', 's1')],
      codex: [snapshot('codex', 't1', { pendingQuestion: QUESTION })]
    })
    const timers = fakeInterval()
    const feed = createLegacyAgentRegistryFeed({
      legacy: legacy.surface,
      modes: LEGACY_FEED_PROVIDERS_CUT_1,
      timers
    })

    feed.start()
    await feed.whenIdle()
    timers.fire()
    await feed.whenIdle()

    // Each cycle lists every live session with its provider identity, Codex pending questions included, in the registry.
    expect(legacy.registry).toHaveLength(2)
    expect(legacy.registry.at(-1)?.map((s) => [s.provider, s.sessionId])).toEqual([
      ['claude', 's1'],
      ['codex', 't1']
    ])
    expect(legacy.registry.at(-1)?.[1]?.dwarfs[0]?.pendingQuestion).toEqual(QUESTION)
    // No board publish, no crediting, no projects-store write and no notifier: the Host writes those (21 §1 item 4).
    expect(legacy.writes).toEqual({ board: 0, ledger: 0, projects: 0, notifier: 0 })

    feed.stop()
    expect(timers.running()).toBe(false)
  })

  it('[ADR-001] a provider switched off by a later step is no longer discovered', async () => {
    const legacy = fakeLegacyRuntime({
      claude: [snapshot('claude', 's1')],
      codex: [snapshot('codex', 't1', { pendingQuestion: QUESTION }), snapshot('codex', 't2')],
      opencode: [snapshot('opencode', 'o1')]
    })
    // The step that moves Claude and Codex (21 §2 cuts 3a, 3b) keeps only the Codex pending-question reader for
    // `LegacyAskRelay` and the providers whose rows are still `legacy` (OpenCode until 4b).
    const modes: LegacyFeedModes = {
      ...LEGACY_FEED_PROVIDERS_CUT_1,
      claude: 'off',
      codex: 'pending-questions'
    }
    const feed = createLegacyAgentRegistryFeed({
      legacy: legacy.surface,
      modes,
      timers: fakeInterval()
    })

    await feed.refresh()

    expect(legacy.scanned.sort()).toEqual(['codex', 'opencode'])
    expect(legacy.registry.at(-1)?.map((s) => [s.provider, s.sessionId])).toEqual([
      ['codex', 't1'],
      ['opencode', 'o1']
    ])
    expect(legacy.writes).toEqual({ board: 0, ledger: 0, projects: 0, notifier: 0 })
  })
})
