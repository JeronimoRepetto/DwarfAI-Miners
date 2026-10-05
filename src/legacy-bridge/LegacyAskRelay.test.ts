// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type {
  DwarfId,
  DwarfWire,
  FolderPath,
  MineId,
  MineWire,
  StranglerDwarfIdentity
} from '@dwarfai/contracts'
import { isUuidV7 } from '@dwarfai/contracts'
import {
  defaultDwarf,
  type Dwarf,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type MinesSnapshot,
  type ProviderSnapshot
} from '../main/domain/types'
import { RecordingUiLog } from '../ui-main/hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from '../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../ui-main/host-client/testing/FakeHostClientTimers'
import type { HostClient } from '../ui-main/window/ports/hostClient'
import { createBoardFacadeAdapter, type BoardFacade } from './BoardFacadeAdapter'
import {
  createLegacyAskRelay,
  legacyAskIdOf,
  legacyOpenAsksOf,
  type LegacyAskRelay
} from './LegacyAskRelay'
import { createLegacyDwarfIdBridge, type LegacyDwarfIdBridge } from './LegacyDwarfIdBridge'
import { NOT_FOUND } from './rowShapes/notFound'
import { NOT_OPEN } from './rowShapes/notOpen'

// L2 (17 §1): `LegacyAskRelay` (21 §3, cuts 1–4; 14 §5, §8 I-11) over the real HostClient and FakeHost (the in-process
// fake Host speaking seam B), the real `LegacyDwarfIdBridge` (B-M41 `strangler.dwarfIdentities`) and the real
// `BoardFacadeAdapter`. The fixture world is one Host board (a Claude foreman and a Codex dwarf in one mine) and today's
// runtime's open asks for the same sessions, written by hand from today's `Dwarf` fields: a Claude permission and a
// Codex pending question (21 §2 cut 1 "Board parity", case "ask card shown"). Today's runtime is a recording fake that
// answers every ask it is handed. The macrotask boundary of A-P2 is the test's (`defer`), so no real timer runs.
// TC-089-01, TC-089-02, TC-089-03.

const MINE = '01920000-0000-7000-9000-0000000b0001' as MineId
const hostId = (n: number) =>
  `01920000-0000-7000-9000-0000000e00${String(n).padStart(2, '0')}` as DwarfId
const FOREMAN = hostId(1)
const CODEX = hostId(2)
const STRANGER = hostId(9)

const SESSION = '9f1c2a7e-0000-4000-8000-00000000c1a0'
const THREAD = '0199aa00-0000-7000-8000-00000000c0de'
const LEGACY_FOREMAN = `claude:${SESSION}`
const LEGACY_CODEX = `codex:${THREAD}`

/** Today's ask ids: a Claude `tool_use` id, and a Codex call id that happens to be a UUIDv7 (it must still not pass as one). */
const PERMISSION_ID = 'toolu_01AbCdEfGhIjKlMnOpQrStUv'
const QUESTION_ID = '0199aa00-0000-7000-8000-0000000a5c01'

const permission: DwarfPermissionRequest = {
  toolUseId: PERMISSION_ID,
  toolName: 'Bash',
  title: 'Claude wants to run a command',
  input: 'pnpm test',
  channel: 'held',
  askedAt: '2026-10-05T10:00:00.000Z'
}
const question: DwarfQuestion = {
  toolUseId: QUESTION_ID,
  channel: 'terminal',
  questions: [
    {
      question: 'Which branch should I use?',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'develop' }]
    }
  ],
  askedAt: '2026-10-05T10:00:01.000Z'
}

const legacyDwarf = (over: Partial<Dwarf> & Pick<Dwarf, 'id' | 'sessionId'>): Dwarf => ({
  ...defaultDwarf(),
  ...over
})
/** Today's sessions as `LegacyAgentRegistryFeed` wrote them, the asks given. */
function legacySessions(asks: { permission?: boolean; question?: boolean }): ProviderSnapshot[] {
  return [
    {
      provider: 'claude',
      sessionId: SESSION,
      cwd: '/work/moria',
      status: 'busy',
      dwarfs: [
        legacyDwarf({
          id: LEGACY_FOREMAN,
          sessionId: SESSION,
          role: 'foreman',
          status: 'waiting',
          ...(asks.permission === true
            ? { pendingPermission: permission, waitingReason: 'approval' as const }
            : {})
        })
      ],
      updatedAt: 1
    },
    {
      provider: 'codex',
      sessionId: THREAD,
      cwd: '/work/moria',
      status: 'idle',
      dwarfs: [
        legacyDwarf({
          id: LEGACY_CODEX,
          sessionId: THREAD,
          provider: 'codex',
          status: 'waiting',
          ...(asks.question === true ? { pendingQuestion: question } : {})
        })
      ],
      updatedAt: 1
    }
  ]
}

const HOST_SIDE: StranglerDwarfIdentity[] = [
  {
    dwarfId: FOREMAN,
    providerId: 'claude',
    identity: { providerId: 'claude', providerSessionId: SESSION }
  },
  {
    dwarfId: CODEX,
    providerId: 'codex',
    identity: { providerId: 'codex', providerSessionId: THREAD }
  }
]

const ore = { tokens: 0 }
const mine: MineWire = {
  id: MINE,
  path: '/work/moria' as FolderPath,
  name: 'moria',
  state: 'active',
  tier: 'gold',
  hasBeenMeasured: true,
  lastUsedAt: 1_700_000_000_000,
  totals: { coal: ore, bronze: ore, copper: ore, silver: ore, gold: ore, uranium: ore }
}
function hostDwarf(
  over: Partial<DwarfWire> & Pick<DwarfWire, 'id' | 'providerId' | 'baseName'>
): DwarfWire {
  return {
    mineId: MINE,
    customName: null,
    rank: 'worker',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId: over.providerId },
    presence: 'present',
    processState: 'running',
    status: 'asking',
    needsYou: true,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500,
    ...over
  }
}

const CAPABILITIES = [
  ...FAKE_HOST_CAPABILITIES,
  'section:mines',
  'section:dwarfs',
  'frame:mine.changed',
  'frame:dwarf.arrived',
  'frame:dwarf.changed',
  'frame:dwarf.departed',
  'strangler.dwarfIdentities'
]

const clients: HostClientService[] = []
const disposables: Array<BoardFacade | LegacyDwarfIdBridge | LegacyAskRelay> = []
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose()
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** The HostClient port, every member call recorded by name, with the method of each `call`. */
function recording(client: HostClient, calls: string[]): HostClient {
  return new Proxy(client, {
    get(target, member, receiver) {
      const value: unknown = Reflect.get(target, member, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(member === 'call' ? `call ${String(args[0])}` : String(member))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
}

async function world(asks: { permission?: boolean; question?: boolean }) {
  const host = new FakeHost({ capabilities: CAPABILITIES })
  host.board = [
    {
      section: 'meta',
      data: {
        hostVersion: '0.0.0-fake',
        state: 'ready',
        resetEpoch: 0,
        snapshotTail: 20,
        minesEverKnown: true
      }
    },
    { section: 'mines', data: [mine] },
    {
      section: 'dwarfs',
      data: [
        hostDwarf({ id: FOREMAN, providerId: 'claude', baseName: 'Thorin', rank: 'foreman' }),
        hostDwarf({ id: CODEX, providerId: 'codex', baseName: 'Kili' })
      ]
    }
  ]
  host.handle('strangler.dwarfIdentities', () => HOST_SIDE)
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new FakeHostClientTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  const calls: string[] = []
  const observed = recording(client, calls)

  let sessions = legacySessions(asks)
  const served: Array<[string, unknown]> = []
  const legacy = {
    serve: (channel: string, payload: unknown) => {
      served.push([channel, payload])
      return Promise.resolve({ answered: true })
    }
  }
  const bridge = createLegacyDwarfIdBridge({
    client: observed,
    legacy: { sessions: () => sessions }
  })
  const pushes: MinesSnapshot[] = []
  const macrotasks: Array<() => void> = []
  let facade: BoardFacade | null = null
  const relay = createLegacyAskRelay({
    bridge,
    asks: { openAsks: () => legacyOpenAsksOf(sessions) },
    legacy,
    changed: () => facade?.refresh()
  })
  facade = createBoardFacadeAdapter({
    client: observed,
    push: (snapshot) => pushes.push(snapshot),
    defer: (run) => macrotasks.push(run),
    askFields: (dwarfId) => relay.askFields(dwarfId)
  })
  disposables.push(facade, bridge, relay)
  await client.ensureHost()
  await settle()

  /** One feed cycle: today's registry holds `next`, the relay re-reads it, the facade pushes. */
  const cycle = async (next?: { permission?: boolean; question?: boolean }): Promise<void> => {
    if (next !== undefined) sessions = legacySessions(next)
    await relay.update()
    await settle()
    for (const run of macrotasks.splice(0)) run()
  }
  await cycle()
  const dwarfOn = (snapshot: MinesSnapshot | undefined, id: DwarfId) =>
    snapshot?.mines.flatMap((m) => m.dwarfs).find((d) => d.id === id)
  return { facade, relay, served, calls, pushes, cycle, dwarfOn }
}

describe('LegacyAskRelay through BoardFacadeAdapter (21 §3; 14 §5, §8 I-11)', () => {
  it('[ADR-001] a legacy Claude permission appears as an ask card in the facade’s MinesSnapshot on the Host dwarf', async () => {
    const { facade, pushes, dwarfOn } = await world({ permission: true })

    // TC-089-01: the card is today's, on the Host dwarf with the same provider identity; only its id is namespaced.
    const expected = { ...permission, toolUseId: `legacy:${PERMISSION_ID}` }
    expect(dwarfOn(facade.getMines(), FOREMAN)?.pendingPermission).toEqual(expected)
    expect(dwarfOn(facade.getMines(), FOREMAN)?.waitingReason).toBe('approval')
    expect(dwarfOn(pushes.at(-1), FOREMAN)?.pendingPermission).toEqual(expected)
    // No other dwarf carries it.
    expect(dwarfOn(facade.getMines(), CODEX)?.pendingPermission).toBeUndefined()
  })

  it('[ADR-001] a legacy Codex pending question appears as an ask card the same way', async () => {
    const { facade, pushes, dwarfOn } = await world({ question: true })

    const expected = { ...question, toolUseId: `legacy:${QUESTION_ID}` }
    expect(dwarfOn(facade.getMines(), CODEX)?.pendingQuestion).toEqual(expected)
    expect(dwarfOn(pushes.at(-1), CODEX)?.pendingQuestion).toEqual(expected)
    expect(dwarfOn(facade.getMines(), FOREMAN)?.pendingQuestion).toBeUndefined()
  })

  it('[ADR-001] every relayed ask id starts with legacy: and never parses as a UUIDv7', async () => {
    const { facade } = await world({ permission: true, question: true })

    // TC-089-03: the Codex call id is itself a UUIDv7; relayed, it can no longer collide with a Host AskId (21 §3).
    expect(isUuidV7(QUESTION_ID)).toBe(true)
    const ids = facade
      .getMines()
      .mines.flatMap((m) => m.dwarfs)
      .flatMap((d) => [d.pendingQuestion?.toolUseId, d.pendingPermission?.toolUseId])
      .filter((id): id is string => id !== undefined)
    expect(ids.sort()).toEqual([`legacy:${QUESTION_ID}`, `legacy:${PERMISSION_ID}`].sort())
    for (const id of ids) {
      expect(id.startsWith('legacy:'), id).toBe(true)
      expect(isUuidV7(id), id).toBe(false)
    }
    expect(legacyAskIdOf(`legacy:${QUESTION_ID}`)).toBe(QUESTION_ID)
    expect(legacyAskIdOf(QUESTION_ID)).toBeNull()
  })

  it('[ADR-001] answering a legacy: ask reaches the legacy runtime with the legacy ask and dwarf ids', async () => {
    const { relay, served, calls } = await world({ permission: true, question: true })
    calls.splice(0)

    // TC-089-02: the person answers both cards by Host dwarf and relayed ask id.
    const allowed = await relay.serve('agent:answerPermission', {
      dwarfId: FOREMAN,
      toolUseId: `legacy:${PERMISSION_ID}`,
      decision: 'allow'
    })
    const answered = await relay.serve('agent:answerQuestion', {
      dwarfId: CODEX,
      toolUseId: `legacy:${QUESTION_ID}`,
      answers: { 'Which branch should I use?': 'main' }
    })

    expect(served).toEqual([
      [
        'agent:answerPermission',
        { dwarfId: LEGACY_FOREMAN, toolUseId: PERMISSION_ID, decision: 'allow' }
      ],
      [
        'agent:answerQuestion',
        {
          dwarfId: LEGACY_CODEX,
          toolUseId: QUESTION_ID,
          answers: { 'Which branch should I use?': 'main' }
        }
      ]
    ])
    // Today's runtime's own verdicts come back unchanged, and no Host method was called.
    expect([allowed, answered]).toEqual([{ answered: true }, { answered: true }])
    expect(calls).toEqual([])
  })

  it('[ADR-001] a legacy ask that closes removes its card at the next facade push', async () => {
    const { facade, pushes, cycle, dwarfOn } = await world({ permission: true, question: true })
    const before = pushes.length

    // Today's runtime answered the permission elsewhere: the next feed cycle no longer carries it.
    await cycle({ question: true })

    expect(pushes.length).toBe(before + 1)
    const pushed = dwarfOn(pushes.at(-1), FOREMAN)
    expect(pushed?.pendingPermission).toBeUndefined()
    expect(pushed?.waitingReason).toBeUndefined()
    expect(dwarfOn(facade.getMines(), FOREMAN)?.pendingPermission).toBeUndefined()
    // The card still open stays.
    expect(dwarfOn(pushes.at(-1), CODEX)?.pendingQuestion?.toolUseId).toBe(`legacy:${QUESTION_ID}`)
    // A cycle that changes no card pushes nothing.
    await cycle({ question: true })
    expect(pushes.length).toBe(before + 1)
  })

  it('[ADR-001] an answer naming a Host dwarf the bridge cannot join answers the row’s own not-found shape', async () => {
    const { relay, served } = await world({ permission: true, question: true })

    // 21 §3: an exact join only; never a guess, and today's runtime is not reached.
    expect(
      await relay.serve('agent:answerPermission', {
        dwarfId: STRANGER,
        toolUseId: `legacy:${PERMISSION_ID}`,
        decision: 'allow'
      })
    ).toEqual(NOT_FOUND['agent:answerPermission'])
    expect(
      await relay.serve('agent:answerQuestion', {
        dwarfId: STRANGER,
        toolUseId: `legacy:${QUESTION_ID}`,
        answers: { 'Which branch should I use?': 'main' }
      })
    ).toEqual(NOT_FOUND['agent:answerQuestion'])
    expect(served).toEqual([])
  })

  it('[ADR-010] a stale answer to a legacy ask is dropped before it reaches the legacy runtime', async () => {
    const { relay, served, cycle } = await world({ permission: true, question: true })
    await cycle({})

    // The asks closed: an answer to either card is stale and answers today's "no longer open" shape (ADR-010 item 5).
    expect(
      await relay.serve('agent:answerPermission', {
        dwarfId: FOREMAN,
        toolUseId: `legacy:${PERMISSION_ID}`,
        decision: 'deny'
      })
    ).toEqual(NOT_OPEN['agent:answerPermission'])
    expect(
      await relay.serve('agent:answerQuestion', {
        dwarfId: CODEX,
        toolUseId: `legacy:${QUESTION_ID}`,
        answers: { 'Which branch should I use?': 'main' }
      })
    ).toEqual(NOT_OPEN['agent:answerQuestion'])
    expect(served).toEqual([])
  })

  it('[ADR-010] an answer outside the legacy: namespace or aimed at another dwarf’s ask never reaches the legacy runtime', async () => {
    const { relay, served } = await world({ permission: true, question: true })

    // The raw legacy id is not a relayed ask id (21 §2 cut 2 "the qualifier is decided by the AskId namespace").
    expect(
      await relay.serve('agent:answerPermission', {
        dwarfId: FOREMAN,
        toolUseId: PERMISSION_ID,
        decision: 'allow'
      })
    ).toEqual(NOT_OPEN['agent:answerPermission'])
    // The Codex dwarf has no such permission: an ask is answered only on the dwarf it is open on.
    expect(
      await relay.serve('agent:answerPermission', {
        dwarfId: CODEX,
        toolUseId: `legacy:${PERMISSION_ID}`,
        decision: 'allow'
      })
    ).toEqual(NOT_OPEN['agent:answerPermission'])
    expect(served).toEqual([])
  })

  it('[ADR-010] a permission answer reaches the legacy runtime only as Allow or Deny, and nothing else of the payload', async () => {
    const { relay, served } = await world({ permission: true })

    // INV-73: a third decision is not forwarded.
    expect(
      await relay.serve('agent:answerPermission', {
        dwarfId: FOREMAN,
        toolUseId: `legacy:${PERMISSION_ID}`,
        decision: 'always-allow'
      })
    ).toEqual({ answered: false })
    await relay.serve('agent:answerPermission', {
      dwarfId: FOREMAN,
      toolUseId: `legacy:${PERMISSION_ID}`,
      decision: 'deny',
      remember: true
    })
    expect(served).toEqual([
      [
        'agent:answerPermission',
        { dwarfId: LEGACY_FOREMAN, toolUseId: PERMISSION_ID, decision: 'deny' }
      ]
    ])
  })

  it('[ADR-001] the relay serves only A-40 and A-41; every other row passes to the legacy runtime unchanged', async () => {
    const { relay, served } = await world({})

    expect([...relay.requestChannels].sort()).toEqual(
      ['agent:answerPermission', 'agent:answerQuestion'].sort()
    )
    await relay.serve('mine:history', 'mine-1')
    expect(served).toEqual([['mine:history', 'mine-1']])
  })
})
