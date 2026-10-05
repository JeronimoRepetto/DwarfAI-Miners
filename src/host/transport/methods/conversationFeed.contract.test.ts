// layer: L6
// L6 (17 §1.6): B-M26 `conversation.feed` (14 §2.3, §3.4 `FeedParams`, §3.6 `FeedPage`; ADR-003
// item 12; ADR-031 item 2) over the real seam-B transport — frame codec, hello-first
// authentication, roles, the Host dispatcher main composes — behind in-process duplexes, with the
// conversation queries faked (FakeConversationQueries). Every answer is validated against its
// contract schema (14 §1.4). A viewer cannot authenticate before its per-view token issuer exists
// (hello.ts, later: ISSUE-170), so its scope is checked at the dispatcher with the dwarf its token
// would bind (RequestContext.dwarfId), as session.snapshot and mines.list check theirs.
//
// TC-103-01 (pages before a message, never more than 50), TC-103-02 (FORBIDDEN for another dwarf),
// TC-103-04 (no message text in a log line).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_METHOD_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { DwarfId, MessageId } from '../../kernel/domain/values'
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
import { registerConversationFeed } from './conversationFeed'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0103'
const T0 = 1_790_000_000_000
/** A message text that must never reach a log line (NFR-SEC-12). */
const CANARY = 'canary-0103-message-text'

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const DWARF_A = id(0xa1) as DwarfId
const DWARF_B = id(0xb2) as DwarfId

/** `count` rows of `dwarfId`, newest first; row n was said at T0 + n. */
function rows(dwarfId: DwarfId, base: number, count: number): MessageView[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - 1 - i
    return {
      id: id(base + n) as MessageId,
      dwarfId,
      role: n % 2 === 0 ? 'person' : 'dwarf',
      text: `${CANARY} ${n}`,
      attachments: [],
      providerTime: T0 + n,
      createdAt: T0 + n
    }
  })
}

/** One Host transport serving B-M26 over faked conversation queries. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-103-feed-'))
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
  conversation.seed(DWARF_A, rows(DWARF_A, 0x100, 50))
  conversation.seed(DWARF_B, rows(DWARF_B, 0x200, 3))
  registerConversationFeed(dispatcher, { conversation })

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
      { id: 'v-1', method: 'conversation.feed', params },
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

type Page = z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.feed']['result']>

function pageOf(res: Res): Page {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return HOST_METHOD_SCHEMAS['conversation.feed'].result.parse(res.result)
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('conversation.feed over seam B (B-M26)', () => {
  it("[ADR-003] a ui client pages any dwarf's feed; a viewer pages only the dwarf its token is bound to and gets FORBIDDEN for another", async () => {
    const { attach, asViewer, conversation } = await host()
    const ui = await attach('ui')

    // The newest page of A: at most 50 rows exist, newest first; the oldest is in it.
    const newest = pageOf(await call(ui, 'conversation.feed', { dwarfId: DWARF_A }))
    expect(newest.dwarfId).toBe(DWARF_A)
    expect(newest.messages).toHaveLength(50)
    expect(newest.messages[0]?.text).toBe(`${CANARY} 49`)
    expect(newest.reachedStart).toBe(true)

    // A page before a given message: only older rows, and reachedStart once the oldest is in it.
    const before = newest.messages[19]?.id
    const older = pageOf(
      await call(ui, 'conversation.feed', { dwarfId: DWARF_A, page: { before, limit: 20 } })
    )
    expect(older.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `${CANARY} ${29 - i}`)
    )
    expect(older.reachedStart).toBe(false)
    expect(pageOf(await call(ui, 'conversation.feed', { dwarfId: DWARF_B })).messages).toHaveLength(
      3
    )

    // A viewer bound to A pages A; for B it gets FORBIDDEN, and B's feed is never read for it.
    const own = await asViewer(DWARF_A, { dwarfId: DWARF_A, page: { limit: 5 } })
    expect(pageOf(own).messages).toHaveLength(5)
    const reads = conversation.calls.length
    expect(codeOf(await asViewer(DWARF_A, { dwarfId: DWARF_B }))).toBe('FORBIDDEN')
    expect(conversation.calls).toHaveLength(reads)
  })

  it('[ADR-003] a notifier calling conversation.feed gets FORBIDDEN', async () => {
    const { attach, conversation } = await host()
    const notifier = await attach('notifier')

    expect(codeOf(await call(notifier, 'conversation.feed', { dwarfId: DWARF_A }))).toBe(
      'FORBIDDEN'
    )
    expect(conversation.calls).toEqual([])
  })

  it('[ADR-003] a limit above 50, an extra key or a non-string before gets INVALID_PARAMS', async () => {
    const { attach, conversation } = await host()
    const ui = await attach('ui')

    for (const params of [
      { dwarfId: DWARF_A, page: { limit: 51 } },
      { dwarfId: DWARF_A, page: { limit: 0 } },
      { dwarfId: DWARF_A, page: { before: 7 } },
      { dwarfId: DWARF_A, page: { before: id(0x149), cursor: 'x' } },
      { dwarfId: DWARF_A, mineId: DWARF_A },
      { dwarfId: 'claude:s1' },
      {}
    ]) {
      expect(codeOf(await call(ui, 'conversation.feed', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(conversation.calls).toEqual([])
  })

  it('[NFR-SEC-12] a canary message text in a feed result never reaches a log line', async () => {
    const { attach, asViewer, log } = await host()
    const ui = await attach('ui')

    expect(
      pageOf(await call(ui, 'conversation.feed', { dwarfId: DWARF_A })).messages[0]?.text
    ).toBe(`${CANARY} 49`)
    await asViewer(DWARF_A, { dwarfId: DWARF_A })
    await asViewer(DWARF_A, { dwarfId: DWARF_B })

    // The calls were logged (names, outcome, code), and none of what was said.
    expect(log.byEvent('channel.req').some((entry) => entry.method === 'conversation.feed')).toBe(
      true
    )
    const logged = JSON.stringify([log.entries, log.refused])
    expect(logged).not.toContain(CANARY)
  })
})
