// layer: L2
// L2 flow (17 §1.2): an OpenCode plugin report through the Host's `/opencode/*` route into the one
// ask broker and the person's answer back to the OpenCode server (ISSUE-229; ADR-011 item 7;
// ADR-016 items 1, 4; ADR-017 item 3; 21 §2 4a). The parts are composed as the asking wiring
// composes them: the route, the OpenCode plugin asks and the `http` answer channel of
// routes/asking.ts; the broker's `open` and answer paths (asking's index) over the real
// `SqliteAskRepository` on a migrated template copy; a `SessionCapabilities` binding that reads an
// observed session through `observedCapabilities` (the gate) and a launched one as suppliers'
// catalogue does (OpenCode's `answerChannelGate` applied: no answer path while the gate is closed).
// The route is driven through its own `admits` and `accept`, as the ingress calls them; the real
// 127.0.0.1 listener is the L6 and L8 suites' (transport/ingress/openCodeRoutes.*). The OpenCode
// server is a fake that records every request; the password is drawn at run time.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../../contracts/logging'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type {
  AskId,
  DwarfId,
  HostEpoch,
  IntegrationState,
  MessageId,
  ProviderId
} from '../../kernel/domain/values'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import {
  createAsking,
  createAskOpening,
  type AskCapabilities,
  type AskingEvent,
  type AskSession
} from '../../modules/asking'
import type { OpenCodeHttpPost } from '../../modules/asking/adapters/openCodePlugin/OpenCodePluginAskChannel'
import { FakeAnswerRecords } from '../../modules/asking/testing/FakeAnswerRecords'
import { FakeConversationLines } from '../../modules/asking/testing/FakeConversationLines'
import { seededAskDb } from '../../modules/asking/testing/sqliteAskDb'
import type { AnswerRecordEvent } from '../../modules/conversation'
import { OPENCODE_OBSERVED_CAPABILITIES, type ObservedSession } from '../../modules/observation'
import { inMemoryChannelTokens } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { wireOpenCodePluginAsking } from '../routes/asking'

const OPENCODE = 'opencode' as ProviderId
const EPOCH = 'epoch-0229' as HostEpoch
const SERVER_URL = 'http://127.0.0.1:4096/'

/** The OpenCode observation adapter's declaration as the asking wiring reads it (omitted → none). */
const OPENCODE_DECLARED: AskCapabilities = {
  permission: OPENCODE_OBSERVED_CAPABILITIES.permission ?? 'none',
  question: OPENCODE_OBSERVED_CAPABILITIES.question ?? 'none',
  observedPermission: OPENCODE_OBSERVED_CAPABILITIES.observedPermission ?? 'none',
  observedQuestion: OPENCODE_OBSERVED_CAPABILITIES.observedQuestion ?? 'none'
}

/** The text of the one chat line an auto-denied request leaves (ADR-011 item 3, owner-approved). */
const AUTO_DENIED_LINE = 'Declined automatically: this request cannot be answered from the panel.'

/** A `permission.asked` report as the written plugin posts it (S-011-1 event shape). */
function report(sessionId: string, requestId: string): string {
  return JSON.stringify({
    event: {
      id: `evt-${requestId}`,
      type: 'permission.asked',
      properties: {
        id: requestId,
        sessionID: sessionId,
        permission: 'edit',
        patterns: ['deny-probe.txt'],
        metadata: { filepath: '/work/mine-one/deny-probe.txt', diff: '+probe' },
        always: ['*'],
        tool: { messageID: 'msg-1', callID: 'call-1' }
      }
    },
    serverUrl: SERVER_URL
  })
}

/**
 * conversation's answers-records as the double keeps them, each also written as the `messages` row
 * `ask_answers.message_id` references (09 §4.5), inside the answer's transaction.
 */
class StoredAnswerRecords extends FakeAnswerRecords {
  constructor(
    private readonly db: SqliteDatabase,
    deps: ConstructorParameters<typeof FakeAnswerRecords>[0]
  ) {
    super(deps)
  }

  override write(dwarfId: DwarfId, askId: AskId, text: string, existing?: MessageId): MessageId {
    const id = super.write(dwarfId, askId, text, existing)
    if (existing === undefined) {
      this.db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at, ask_id)
         VALUES (?, ?, 'answers-record', ?, 'dwarfai', 0, ?)`,
        [id, dwarfId, text, askId]
      )
    }
    return id
  }
}

/** The Host composed around the OpenCode plugin route; `observed` and `launched` are its dwarfs. */
function host() {
  const seeded = seededAskDb()
  const { runner, clock } = seeded
  const [observed, launched] = seeded.dwarfs
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<AskingEvent | AnswerRecordEvent>({ transactionScope: runner })
  const lines = new FakeConversationLines(runner)
  const tokens = inMemoryChannelTokens()
  const password = randomBytes(12).toString('hex')
  const secrets = new FakeSecretReader({ scheduler, values: { 'opencode-password': password } })
  const received: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const post: OpenCodeHttpPost = (url, init) => {
    received.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) })
    return Promise.resolve({ status: 200, text: () => Promise.resolve('true') })
  }
  let state: IntegrationState = 'on-verified'

  /** The sessions observation knows: a legacy-launched one it observes, and a Host-launched one. */
  const sessions = new Map<string, ObservedSession>([
    ['ses-observed', { dwarfId: observed, cwd: '/work/mine-one' } as ObservedSession],
    ['ses-launched', { dwarfId: launched, cwd: '/work/mine-one' } as ObservedSession]
  ])
  const asks = seeded.open()
  let open: ReturnType<typeof createAskOpening>['open'] = () => {
    throw new Error('not wired')
  }
  const wired = wireOpenCodePluginAsking({
    providerId: OPENCODE,
    sessions: {
      byIdentity: (identity) =>
        identity.providerId === OPENCODE ? (sessions.get(identity.providerSessionId) ?? null) : null
    },
    asks: { open: (dwarfId, input) => open(dwarfId, input) },
    preferences: {
      queries: { integrationState: () => state },
      channelTokens: tokens.store
    },
    observation: { nudge: () => undefined },
    secrets,
    post,
    scheduler,
    redact: redactSecrets,
    log
  })
  const channelFor = (channel: string) => (channel === 'http' ? wired.channel : null)

  /** Suppliers' launched OpenCode capabilities: the catalog ceiling only while the gate is open. */
  const launchedCapabilities = (): AskCapabilities =>
    state === 'on-verified'
      ? {
          permission: 'interactive',
          question: 'none',
          observedPermission: 'none',
          observedQuestion: 'none'
        }
      : {
          permission: 'none',
          question: 'none',
          observedPermission: 'none',
          observedQuestion: 'none'
        }
  const sessionOf = (dwarfId: DwarfId): AskSession =>
    dwarfId === launched
      ? { providerId: OPENCODE, origin: 'launched', capabilities: launchedCapabilities() }
      : {
          providerId: OPENCODE,
          origin: 'observed',
          capabilities: wired.observedCapabilities(OPENCODE, OPENCODE_DECLARED)
        }

  const opening = createAskOpening({
    asks,
    sessions: { sessionOf },
    lines,
    joinedLines: lines,
    channelFor,
    transactions: runner,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH
  })
  open = (dwarfId, input) => opening.open(dwarfId, input)
  const answering = createAsking({
    asks,
    records: new StoredAnswerRecords(seeded.db, { scope: runner, clock, ids }),
    channelFor,
    staleAnswerSafe: (channel) => channelFor(channel)?.capabilities.staleAnswerSafe ?? true,
    transactions: runner,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH
  })

  const pluginToken = tokens.issue('opencode-plugin', clock.now())
  /** One plugin request as the ingress serves it: the admission, then the accepted delivery. */
  const plugin = (body: string, token = pluginToken): 'accepted' | 401 | 400 => {
    if (!wired.route.admits(token)) return 401
    const delivery = wired.route.accept(body)
    if (delivery === null) return 400
    delivery()
    return 'accepted'
  }

  return {
    observed,
    launched,
    asks,
    bus,
    lines,
    received,
    password,
    answering,
    plugin,
    tokens,
    setState: (next: IntegrationState) => {
      state = next
    }
  }
}

/** Lets the answer channel's awaited secret read and post settle (no timer involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('OpenCode plugin asks through the Host broker (ISSUE-229)', () => {
  it('[C-27, ADR-011] with opencode-permissions on-verified a plugin permission report opens one card in the Host broker', () => {
    const h = host()

    expect(h.plugin(report('ses-observed', 'per-1'))).toBe('accepted')
    // OpenCode reports an ask once, but a repeated report never opens a second card (INV-71).
    expect(h.plugin(report('ses-observed', 'per-1'))).toBe('accepted')

    const opened = h.bus.ofType('AskOpened')
    expect(opened).toHaveLength(1)
    expect(opened[0]?.payload.ask).toMatchObject({
      dwarfId: h.observed,
      kind: 'permission',
      channel: 'http',
      providerRequestId: 'per-1',
      state: 'open',
      payload: { toolName: 'edit', requestText: 'edit: deny-probe.txt' }
    })
    expect(h.received).toStrictEqual([])
  })

  it("[C-27, ADR-011] with the gate off or on-unverified no card opens; a launched session's request is auto-denied with one chat line", async () => {
    const h = host()
    h.setState('on-unverified')

    expect(h.plugin(report('ses-observed', 'per-2'))).toBe('accepted')
    expect(h.asks.byProviderRequest({ dwarfId: h.observed }, 'per-2')).toBeNull()

    expect(h.plugin(report('ses-launched', 'per-3'))).toBe('accepted')
    await settle()

    expect(h.bus.ofType('AskOpened')).toStrictEqual([])
    expect(h.asks.byProviderRequest({ dwarfId: h.launched }, 'per-3')?.state).toBe('auto-denied')
    expect(h.bus.ofType('AskClosed').map((event) => event.payload.reason)).toStrictEqual([
      'auto-denied'
    ])
    expect(h.lines.rows.map((row) => [row.dwarfId, row.entry.text])).toStrictEqual([
      [h.launched, AUTO_DENIED_LINE]
    ])
    // Denied through the OpenCode protocol, on the server that asked.
    expect(h.received.map((sent) => [sent.url, sent.body])).toStrictEqual([
      [
        'http://127.0.0.1:4096/permission/per-3/reply?directory=%2Fwork%2Fmine-one',
        { reply: 'reject' }
      ]
    ])

    // Off: the plugin token is revoked with the integration (ADR-016 item 1), so nothing arrives.
    h.setState('off')
    h.tokens.store.revoke('opencode-plugin', 2)
    expect(h.plugin(report('ses-launched', 'per-4'))).toBe(401)
    expect(h.asks.byProviderRequest({ dwarfId: h.launched }, 'per-4')).toBeNull()
  })

  it('[ADR-011] a plugin ask of a legacy-launched OpenCode session reaches the Host broker and is answered by the Host', async () => {
    const h = host()
    // A session the legacy runtime launched is one the Host observes (still `legacy` until 4b).
    expect(h.plugin(report('ses-observed', 'per-5'))).toBe('accepted')
    const ask = h.asks.byProviderRequest({ dwarfId: h.observed }, 'per-5')
    expect(ask?.state).toBe('open')

    const outcome = await h.answering.answers.answerPermission(
      ask?.id as AskId,
      'allow',
      '00000000-0000-7000-8000-00000000a229'
    )

    expect(outcome).toStrictEqual({ kind: 'accepted' })
    expect(h.asks.byProviderRequest({ dwarfId: h.observed }, 'per-5')?.state).toBe(
      'answered-in-app'
    )
    expect(h.received).toStrictEqual([
      {
        url: 'http://127.0.0.1:4096/permission/per-5/reply?directory=%2Fwork%2Fmine-one',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`opencode:${h.password}`).toString('base64')}`
        },
        body: { reply: 'once' }
      }
    ])
  })
})
