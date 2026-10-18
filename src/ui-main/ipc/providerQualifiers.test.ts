// layer: L1
// L1 (17 §1.1): the provider qualifiers of the step-3a rows (21 §1 item 2; 21 §2 cut 3 "provider-qualified rows";
// 14 §8 I-11): A-13, A-23 and A-N29 qualify a call by the provider of its dwarf, read synchronously from the Host board
// UI-main holds; A-35 by `LaunchParams.way` — a supplier launch by its `providerId`, a "Let Jev choose" launch by the
// table's `host` route (3a's Jev candidates are only providers the Host launches, 21 §2 "Let Jev choose (each step)").
// Each is proven through `resolveRoute` on a 3a-shaped table: Claude reaches `host`, every other provider the
// unqualified `legacy` route through its shape adapter.
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS, type ChannelKey } from '@dwarfai/contracts'
import type { ChannelRoute } from './channelRoute'
import { resolveRoute } from './routeResolver'
import {
  composeProviderQualifiers,
  createDwarfProviderQualifier,
  createLaunchQualifier,
  DWARF_PROVIDER_ROWS,
  LAUNCH_ROW
} from './providerQualifiers'

const [CLAUDE = '', CODEX = '', ANTIGRAVITY = ''] = CATALOG_PROVIDER_IDS
const CLAUDE_DWARF = '01920000-0000-7000-a000-000000000011'
const CODEX_DWARF = '01920000-0000-7000-a000-000000000012'
const UNKNOWN_DWARF = '01920000-0000-7000-a000-000000000013'
const MINE = '01920000-0000-7000-a000-000000000014'
const REQUEST = '01920000-0000-7000-a000-000000000015'

/** The Host board UI-main holds, as the qualifiers read it: a dwarf's provider, synchronously. */
function boardOf(providers: Record<string, string>): {
  asked: string[]
  providerOf(dwarfId: string): string | undefined
} {
  const asked: string[] = []
  return {
    asked,
    providerOf(dwarfId) {
      asked.push(dwarfId)
      return providers[dwarfId]
    }
  }
}

const BOARD = { [CLAUDE_DWARF]: CLAUDE, [CODEX_DWARF]: CODEX }

function hostFor(channel: ChannelKey, provider: string): ChannelRoute {
  return {
    channel,
    owner: 'host',
    since: 'cut-3a',
    parity: 'passed',
    qualifier: { provider },
    shape: 'target'
  }
}

function legacyThroughAdapter(channel: ChannelKey): ChannelRoute {
  return {
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: 'PerProviderShapeAdapter'
  }
}

/** A-13, A-23, A-35 and A-N29 as 3a routes them (21 §2 cut 3a): `host` for Claude, `legacy` for every other one. */
const TABLE_3A: readonly ChannelRoute[] = [
  hostFor('dwarf:activate', CLAUDE),
  legacyThroughAdapter('dwarf:activate'),
  hostFor('dwarf:sendText', CLAUDE),
  legacyThroughAdapter('dwarf:sendText'),
  hostFor('agent:launch', CLAUDE),
  legacyThroughAdapter('agent:launch'),
  hostFor('dwarf:stop', CLAUDE)
]

function launch(way: unknown): Record<string, unknown> {
  return {
    mineId: MINE,
    way,
    prompt: 'Survey the north seam',
    jevOn: false,
    jevAutoAccept: false,
    requestId: REQUEST
  }
}

describe('provider qualifiers of the step-3a rows (21 §1 item 2, §2 cut 3)', () => {
  it('[ADR-001] A-13, A-23 and A-N29 qualify a call by the provider of its dwarf on the Host board', () => {
    const board = boardOf(BOARD)
    const qualify = createDwarfProviderQualifier(board)

    expect(DWARF_PROVIDER_ROWS).toEqual(['dwarf:activate', 'dwarf:sendText', 'dwarf:stop'])
    expect(qualify({ dwarfId: CLAUDE_DWARF, purpose: 'open-console' })).toEqual({
      provider: CLAUDE
    })
    expect(
      qualify({ dwarfId: CODEX_DWARF, text: 'Dig', attachments: [], requestId: REQUEST })
    ).toEqual({ provider: CODEX })
    // A dwarf the board does not hold carries no qualifier: the unqualified route answers it, never a guess.
    expect(qualify({ dwarfId: UNKNOWN_DWARF, requestId: REQUEST })).toEqual({})
    expect(board.asked).toEqual([CLAUDE_DWARF, CODEX_DWARF, UNKNOWN_DWARF])

    // A payload with no dwarf id string is not looked up: the router's gate refuses it on its route.
    for (const payload of [undefined, null, 'dwarf', { dwarfId: 7 }, { id: CLAUDE_DWARF }]) {
      expect(qualify(payload), JSON.stringify(payload)).toEqual({})
    }
    expect(board.asked).toHaveLength(3)
  })

  it('[ADR-001] A-35 qualifies a supplier launch by its providerId and a Let Jev choose launch by the host route', () => {
    const qualify = createLaunchQualifier(TABLE_3A)

    expect(qualify(launch({ kind: 'supplier', providerId: CLAUDE }))).toEqual({ provider: CLAUDE })
    expect(qualify(launch({ kind: 'supplier', providerId: ANTIGRAVITY }))).toEqual({
      provider: ANTIGRAVITY
    })
    expect(
      qualify({ ...launch({ kind: 'supplier', providerId: CODEX }), retryOf: REQUEST })
    ).toEqual({ provider: CODEX })
    expect(qualify(launch({ kind: 'jev' }))).toEqual({ provider: CLAUDE })
    for (const payload of [
      undefined,
      launch(undefined),
      launch({ kind: 'supplier' }),
      launch({ kind: 'supplier', providerId: 7 }),
      launch({ kind: 'held', providerId: CLAUDE })
    ]) {
      expect(qualify(payload), JSON.stringify(payload)).toEqual({})
    }
  })

  it('[ADR-001] a Let Jev choose launch follows the table: an unqualified host route, or legacy where none is host', () => {
    const jev = launch({ kind: 'jev' })
    const allMoved: readonly ChannelRoute[] = [
      { ...hostFor('agent:launch', CLAUDE), qualifier: undefined }
    ]
    const rolledBack: readonly ChannelRoute[] = [
      { ...legacyThroughAdapter('agent:launch'), qualifier: { provider: CLAUDE } },
      legacyThroughAdapter('agent:launch')
    ]

    expect(createLaunchQualifier(allMoved)(jev)).toEqual({})
    expect(resolveRoute(allMoved, LAUNCH_ROW, createLaunchQualifier(allMoved)(jev))?.owner).toBe(
      'host'
    )
    expect(createLaunchQualifier(rolledBack)(jev)).toEqual({})
    expect(resolveRoute(rolledBack, LAUNCH_ROW, createLaunchQualifier(rolledBack)(jev))).toBe(
      rolledBack[1]
    )
  })

  it('[ADR-001] on the 3a table Claude reaches host and every other provider the legacy route through its shape adapter', () => {
    const qualifiers = composeProviderQualifiers({ routes: TABLE_3A, board: boardOf(BOARD) })
    const ownerOf = (channel: ChannelKey, payload: unknown): ChannelRoute | undefined => {
      const qualify = qualifiers[channel]
      return resolveRoute(TABLE_3A, channel, qualify === undefined ? {} : qualify(payload))
    }

    expect(Object.keys(qualifiers).sort()).toEqual([
      'agent:launch',
      'dwarf:activate',
      'dwarf:sendText',
      'dwarf:stop'
    ])
    for (const channel of ['dwarf:activate', 'dwarf:sendText'] as const) {
      expect(ownerOf(channel, { dwarfId: CLAUDE_DWARF })).toMatchObject({ owner: 'host' })
      expect(ownerOf(channel, { dwarfId: CODEX_DWARF })).toMatchObject({
        owner: 'legacy',
        shapeAdapter: 'PerProviderShapeAdapter'
      })
      expect(ownerOf(channel, { dwarfId: UNKNOWN_DWARF })).toMatchObject({ owner: 'legacy' })
    }
    expect(ownerOf('dwarf:stop', { dwarfId: CLAUDE_DWARF })).toMatchObject({ owner: 'host' })
    expect(ownerOf(LAUNCH_ROW, launch({ kind: 'supplier', providerId: CLAUDE }))).toMatchObject({
      owner: 'host'
    })
    expect(ownerOf(LAUNCH_ROW, launch({ kind: 'supplier', providerId: CODEX }))).toMatchObject({
      owner: 'legacy',
      shapeAdapter: 'PerProviderShapeAdapter'
    })
    expect(ownerOf(LAUNCH_ROW, launch({ kind: 'jev' }))).toMatchObject({ owner: 'host' })
  })

  it('[ADR-001] a table with no provider-qualified route for a row composes no qualifier for it', () => {
    const cut2: readonly ChannelRoute[] = [
      {
        channel: 'dwarf:sendText',
        owner: 'legacy',
        since: 'pre-cut-0',
        parity: 'n/a',
        shape: 'today'
      },
      {
        channel: 'agent:launch',
        owner: 'legacy',
        since: 'pre-cut-0',
        parity: 'n/a',
        shape: 'today'
      }
    ]
    const askOrigin: readonly ChannelRoute[] = [
      { ...legacyThroughAdapter('dwarf:sendText'), qualifier: { origin: 'legacy-launch' } }
    ]

    expect(composeProviderQualifiers({ routes: cut2, board: boardOf(BOARD) })).toEqual({})
    expect(composeProviderQualifiers({ routes: askOrigin, board: boardOf(BOARD) })).toEqual({})
  })
})
