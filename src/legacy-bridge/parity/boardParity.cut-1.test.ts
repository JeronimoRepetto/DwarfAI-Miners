// layer: L2
// Board parity and legacy-row parity of cut 1 (21 §2 cut 1 "Exit criteria"; ISSUE-123 TC-123-02, TC-123-05).
//
// The fixture world is one mine with a Claude foreman holding a permission and a Codex dwarf with a pending question:
// the Host's board of it (snapshot `mines` and `dwarfs` over the real HostClient and FakeHost, the in-process fake Host
// speaking seam B) and today's board of the same world, written by hand from today's `Mine` and `Dwarf` fields, which
// is what today's runtime publishes on A-P2 before the cut (`toMinesSnapshot` in `LegacyRuntimeRoute.ts`). The facade is
// the real `BoardFacadeAdapter` with today's asks from the real `LegacyAskRelay` over the real `LegacyDwarfIdBridge`
// (B-M41). Legacy code is reached only from `src/legacy-bridge/**` (R16).
//
// Fact-equal means: the same mines (path, name, tier, ore per material), the same present dwarfs (provider, rank,
// name, status) and the same open ask cards, with each dwarf compared through the bridge's join (Host `DwarfId` to
// today's id) and each relayed ask id through its `legacy:` namespace (21 §3 `LegacyAskRelay`). The differences cut 1
// accepts are listed in docs/strangler/parity-cut-1.md; this world exercises none of them.
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type DwarfId,
  type DwarfWire,
  type FolderPath,
  type Material,
  type MineId,
  type MineWire,
  type StranglerDwarfIdentity
} from '@dwarfai/contracts'
import {
  defaultDwarf,
  type Dwarf,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type Mine,
  type MinesSnapshot,
  type ProviderSnapshot
} from '../../main/domain/types'
import { RecordingUiLog } from '../../ui-main/hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from '../../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../../ui-main/host-client/testing/FakeHostClientTimers'
import { createBoardFacadeAdapter, type BoardFacade } from '../BoardFacadeAdapter'
import {
  createLegacyAskRelay,
  legacyAskIdOf,
  legacyOpenAsksOf,
  type LegacyAskRelay
} from '../LegacyAskRelay'
import {
  createLegacyDwarfIdBridge,
  createLegacyDwarfIdRows,
  type LegacyDwarfIdBridge
} from '../LegacyDwarfIdBridge'
import { boardSessions } from '../LegacyRuntimeSurface'

const MINE = '01920000-0000-7000-9000-0000000b0101' as MineId
const FOREMAN = '01920000-0000-7000-9000-0000000e0101' as DwarfId
const CODEX = '01920000-0000-7000-9000-0000000e0102' as DwarfId
const SESSION = '9f1c2a7e-0000-4000-8000-00000000c1b0'
const THREAD = '0199aa00-0000-7000-8000-00000000c1de'
const LEGACY_FOREMAN = `claude:${SESSION}`
const LEGACY_CODEX = `codex:${THREAD}`
const MATERIALS: readonly Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']

const permission: DwarfPermissionRequest = {
  toolUseId: 'toolu_01ParityPermission0000',
  toolName: 'Bash',
  title: 'Claude wants to run a command',
  input: 'pnpm test',
  channel: 'held',
  askedAt: '2026-10-07T10:00:00.000Z'
}
const question: DwarfQuestion = {
  toolUseId: '0199aa00-0000-7000-8000-0000000a5c11',
  channel: 'terminal',
  questions: [
    {
      question: 'Which branch should I use?',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'develop' }]
    }
  ],
  askedAt: '2026-10-07T10:00:01.000Z'
}

/** The ore of the fixture mine, in tokens per material. */
const ORE: Readonly<Record<Material, number>> = {
  coal: 1_200,
  bronze: 0,
  copper: 0,
  silver: 0,
  gold: 48_000,
  uranium: 0
}

/** The Host's board of the fixture world. */
const hostMine: MineWire = {
  id: MINE,
  path: '/work/moria' as FolderPath,
  name: 'moria',
  state: 'active',
  tier: 'gold',
  hasBeenMeasured: true,
  lastUsedAt: 1_700_000_000_000,
  totals: Object.fromEntries(
    MATERIALS.map((material) => [material, { tokens: ORE[material] }])
  ) as MineWire['totals']
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

/** Today's board of the same world, as today's runtime publishes it on A-P2 before the cut. */
const todayBoard: MinesSnapshot = {
  mines: [
    {
      id: 'mine:/work/moria',
      path: '/work/moria',
      name: 'moria',
      tier: 'gold',
      dwarfs: [
        {
          ...defaultDwarf(),
          id: LEGACY_FOREMAN,
          provider: 'claude',
          role: 'foreman',
          name: 'Thorin',
          status: 'waiting',
          sessionId: SESSION,
          pendingPermission: permission,
          waitingReason: 'approval'
        },
        {
          ...defaultDwarf(),
          id: LEGACY_CODEX,
          provider: 'codex',
          role: 'worker',
          name: 'Kili',
          status: 'waiting',
          sessionId: THREAD,
          pendingQuestion: question
        }
      ],
      tokensObserved: MATERIALS.reduce((sum, material) => sum + ORE[material], 0),
      materials: { ...ORE },
      updatedAt: 1_700_000_000_000
    }
  ],
  tokensObserved: MATERIALS.reduce((sum, material) => sum + ORE[material], 0),
  materials: { ...ORE }
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

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** The cut-1 composition over the fixture world: the facade, the relay, the bridge and today's runtime recorded. */
async function cut1World(answers: Readonly<Record<string, unknown>> = {}) {
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
    { section: 'mines', data: [hostMine] },
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

  // Today's registry as `LegacyAgentRegistryFeed` writes it: the sessions of today's board (./LegacyRuntimeSurface.ts).
  const sessions: ProviderSnapshot[] = boardSessions(todayBoard.mines as Mine[])
  const served: Array<[string, unknown]> = []
  const legacy = {
    serve: (channel: string, payload: unknown) => {
      served.push([channel, payload])
      return Promise.resolve(answers[channel])
    }
  }
  const bridge = createLegacyDwarfIdBridge({ client, legacy: { sessions: () => sessions } })
  const rows = createLegacyDwarfIdRows({ bridge, legacy })
  const macrotasks: Array<() => void> = []
  let facade: BoardFacade | null = null
  const relay = createLegacyAskRelay({
    bridge,
    asks: { openAsks: () => legacyOpenAsksOf(sessions) },
    legacy: rows,
    changed: () => facade?.refresh()
  })
  facade = createBoardFacadeAdapter({
    client,
    push: () => {},
    defer: (run) => macrotasks.push(run),
    askFields: (dwarfId) => relay.askFields(dwarfId)
  })
  disposables.push(facade, bridge, relay)
  await client.ensureHost()
  await settle()
  await relay.update()
  await settle()
  for (const run of macrotasks.splice(0)) run()
  return { facade, relay, rows, bridge, served }
}

/** A board's facts, each dwarf named by today's id, each relayed ask by today's ask id. */
async function factsOf(board: MinesSnapshot, toLegacy: (id: string) => Promise<string | null>) {
  return Promise.all(
    board.mines.map(async (mine) => ({
      path: mine.path,
      name: mine.name,
      tier: mine.tier,
      ore: MATERIALS.map((material) => mine.materials?.[material] ?? 0),
      dwarfs: (
        await Promise.all(
          mine.dwarfs.map(async (dwarf: Dwarf) => ({
            id: (await toLegacy(dwarf.id)) ?? dwarf.id,
            provider: dwarf.provider,
            role: dwarf.role,
            name: dwarf.name,
            status: dwarf.status,
            permission:
              dwarf.pendingPermission === undefined
                ? null
                : {
                    ...dwarf.pendingPermission,
                    toolUseId:
                      legacyAskIdOf(dwarf.pendingPermission.toolUseId) ??
                      dwarf.pendingPermission.toolUseId
                  },
            question:
              dwarf.pendingQuestion === undefined
                ? null
                : {
                    ...dwarf.pendingQuestion,
                    toolUseId:
                      legacyAskIdOf(dwarf.pendingQuestion.toolUseId) ??
                      dwarf.pendingQuestion.toolUseId
                  },
            waitingReason: dwarf.waitingReason ?? null
          }))
        )
      ).sort((a, b) => a.id.localeCompare(b.id))
    }))
  )
}

describe('board and legacy-row parity of cut 1 (21 §2 cut 1)', () => {
  it("[ADR-001] the facade's MinesSnapshot validates against today's schema and is fact-equal to the legacy board, open ask cards included", async () => {
    const { facade, bridge } = await cut1World()
    const board = facade.getMines()

    expect(CHANNELS['mines:get'].response.safeParse(board).success).toBe(true)
    expect(board.tokensObserved).toBe(todayBoard.tokensObserved)
    expect(board.materials).toEqual(todayBoard.materials)
    const toLegacy = (id: string) => bridge.toLegacy(id as DwarfId)
    const asToday = (id: string) => Promise.resolve(id)
    expect(await factsOf(board, toLegacy)).toEqual(await factsOf(todayBoard, asToday))
  })

  it('[ADR-001] send, open console, answer an observed Codex question and stop a legacy-launched dwarf through the bridges equal the pre-cut build', async () => {
    const answers = {
      'dwarf:sendText': { delivered: true, via: 'terminal' },
      'dwarf:activate': { focused: true, openedTerminal: false, feed: [] },
      'agent:answerQuestion': { answered: true },
      'dwarf:kick': { delivered: true, via: 'terminal' },
      'dwarf:retire': undefined
    }
    const { relay, served } = await cut1World(answers)

    // What the cut-1 renderer sends: Host dwarf ids, and the relayed ask id on the card it answers.
    const cut1Calls: Array<[string, unknown]> = [
      ['dwarf:sendText', { dwarfId: FOREMAN, text: 'dig deeper', pressEnter: true }],
      ['dwarf:activate', FOREMAN],
      [
        'agent:answerQuestion',
        { dwarfId: CODEX, toolUseId: `legacy:${question.toolUseId}`, answers: { q0: 'main' } }
      ],
      ['dwarf:kick', { dwarfId: FOREMAN }],
      ['dwarf:retire', FOREMAN]
    ]
    // What the pre-cut renderer sent for the same acts: today's ids, and today's ask id.
    const preCutCalls: Array<[string, unknown]> = [
      ['dwarf:sendText', { dwarfId: LEGACY_FOREMAN, text: 'dig deeper', pressEnter: true }],
      ['dwarf:activate', LEGACY_FOREMAN],
      [
        'agent:answerQuestion',
        { dwarfId: LEGACY_CODEX, toolUseId: question.toolUseId, answers: { q0: 'main' } }
      ],
      ['dwarf:kick', { dwarfId: LEGACY_FOREMAN }],
      ['dwarf:retire', LEGACY_FOREMAN]
    ]

    const got: unknown[] = []
    for (const [channel, payload] of cut1Calls) got.push(await relay.serve(channel, payload))

    // Today's runtime received exactly what the pre-cut build sent it, and the renderer gets today's answers back.
    expect(served).toEqual(preCutCalls)
    expect(got).toEqual(preCutCalls.map(([channel]) => answers[channel as keyof typeof answers]))
  })
})
