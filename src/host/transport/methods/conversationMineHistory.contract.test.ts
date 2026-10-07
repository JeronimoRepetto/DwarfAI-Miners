// layer: L6
// L6 (17 §1.6): B-M27 `conversation.mineHistory` (14 §2.3, §3.4, §3.6 `MineHistoryView`; ADR-003
// item 12; PO #87) over the real seam-B transport — frame codec, hello-first authentication,
// roles, the Host dispatcher main composes — behind in-process duplexes, with the conversation
// queries faked (FakeConversationQueries). Every answer is validated against its contract schema
// (14 §1.4). A viewer cannot authenticate before its per-view token issuer exists (hello.ts, later:
// ISSUE-170), so its refusal is checked at the dispatcher with the dwarf its token would bind
// (RequestContext.dwarfId), as conversation.feed checks its own.
//
// TC-104-02 (the Host half: a notifier or a viewer calling B-M27 gets FORBIDDEN).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_METHOD_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { DwarfId, MessageId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { MessageView } from '../../modules/conversation'
import { FakeConversationQueries } from '../../modules/conversation/testing/FakeConversationQueries'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import { registerConversationMineHistory } from './conversationMineHistory'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0104'
const T0 = 1_790_000_000_000
/** A message text that must never reach a log line (NFR-SEC-12). */
const CANARY = 'canary-0104-message-text'

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const MINE = id(0xf1) as MineId
const DWARF_A = id(0xa1) as DwarfId
const DWARF_B = id(0xb2) as DwarfId

/** `count` rows of `dwarfId`, oldest first; row n was said at T0 + n. */
function rows(dwarfId: DwarfId, base: number, count: number): MessageView[] {
  return Array.from({ length: count }, (_, n) => ({
    id: id(base + n) as MessageId,
    dwarfId,
    role: n % 2 === 0 ? 'person' : 'dwarf',
    text: `${CANARY} ${n}`,
    attachments: [],
    providerTime: T0 + n,
    createdAt: T0 + n
  }))
}

/** One Host transport serving B-M27 over faked conversation queries. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-104-history-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const ids = new SequenceIdGenerator()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: EPOCH,
    ids,
    sections: new SectionRegistry(),
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => true
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const conversation = new FakeConversationQueries()
  conversation.seedHistory({
    mineId: MINE,
    speakers: [
      {
        dwarfId: DWARF_A,
        displayName: 'Dáin',
        rank: 'foreman',
        providerId: 'claude',
        departed: false,
        messages: rows(DWARF_A, 0x100, 50)
      },
      {
        dwarfId: DWARF_B,
        displayName: 'Thráin',
        rank: 'worker',
        providerId: 'codex',
        departed: true,
        messages: rows(DWARF_B, 0x200, 3)
      }
    ]
  })
  registerConversationMineHistory(dispatcher, { conversation })

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }
  /** A viewer's request, bound to `bound`, through the dispatcher a viewer connection reaches. */
  const asViewer = (bound: DwarfId, params: unknown) =>
    dispatcher.dispatch(
      { id: 'v-1', method: 'conversation.mineHistory', params },
      { role: 'viewer', clientId: 'viewer-1', dwarfId: bound }
    )

  return { attach, asViewer, conversation, log }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const requestId = `req-${nextId}`
  client.send({ type: 'req', id: requestId, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, requestId)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, requestId)))
}

function isRes(frame: unknown, requestId: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === requestId
}

type History = z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.mineHistory']['result']>

function historyOf(res: Res): History {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return HOST_METHOD_SCHEMAS['conversation.mineHistory'].result.parse(res.result)
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('conversation.mineHistory over seam B (B-M27)', () => {
  it('[ADR-003] a ui client reads mine history; a notifier or a viewer gets FORBIDDEN', async () => {
    const { attach, asViewer, conversation } = await host()
    const ui = await attach('ui')

    // Every speaker, present or departed, with its stored rows (at most 50), oldest first.
    const history = historyOf(await call(ui, 'conversation.mineHistory', { mineId: MINE }))
    expect(history.mineId).toBe(MINE)
    // Amended: each speaker's rank and provider reach the wire (owner amendment F, 2026-10-07).
    expect(
      history.speakers.map((s) => [s.dwarfId, s.displayName, s.rank, s.providerId, s.departed])
    ).toEqual([
      [DWARF_A, 'Dáin', 'foreman', 'claude', false],
      [DWARF_B, 'Thráin', 'worker', 'codex', true]
    ])
    expect(history.speakers[0]?.messages).toHaveLength(50)
    expect(history.speakers[0]?.messages.at(-1)?.text).toBe(`${CANARY} 49`)
    expect(history.speakers[1]?.messages.map((m) => m.text)).toEqual(
      [0, 1, 2].map((n) => `${CANARY} ${n}`)
    )
    // A mine where nobody ever worked: no speakers.
    const EMPTY = id(0xf2)
    expect(historyOf(await call(ui, 'conversation.mineHistory', { mineId: EMPTY }))).toEqual({
      mineId: EMPTY,
      speakers: []
    })
    expect(conversation.historyCalls).toEqual([MINE, EMPTY])

    // A notifier and a viewer are refused before the module is read.
    const notifier = await attach('notifier')
    expect(codeOf(await call(notifier, 'conversation.mineHistory', { mineId: MINE }))).toBe(
      'FORBIDDEN'
    )
    expect(codeOf(await asViewer(DWARF_A, { mineId: MINE }))).toBe('FORBIDDEN')
    expect(conversation.historyCalls).toEqual([MINE, EMPTY])

    // The params are the strict() schema: anything else is INVALID_PARAMS before the handler runs.
    for (const params of [{ mineId: MINE, dwarfId: DWARF_A }, { mineId: 'mine-one' }, {}]) {
      expect(
        codeOf(await call(ui, 'conversation.mineHistory', params)),
        JSON.stringify(params)
      ).toBe('INVALID_PARAMS')
    }
    expect(conversation.historyCalls).toEqual([MINE, EMPTY])
  })

  it('[NFR-SEC-12] message text in a mine-history result never reaches a log line', async () => {
    const { attach, asViewer, log } = await host()
    const ui = await attach('ui')

    expect(
      historyOf(await call(ui, 'conversation.mineHistory', { mineId: MINE })).speakers[0]
        ?.messages[0]?.text
    ).toBe(`${CANARY} 0`)
    await asViewer(DWARF_A, { mineId: MINE })

    // The calls were logged (names, outcome, code), and none of what was said.
    expect(
      log.byEvent('channel.req').some((entry) => entry.method === 'conversation.mineHistory')
    ).toBe(true)
    const logged = JSON.stringify([log.entries, log.refused])
    expect(logged).not.toContain(CANARY)
  })
})
