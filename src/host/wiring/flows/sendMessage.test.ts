// L2 flow (17 §1.2; 11 F4; 12 UC-012; ADR-022 items 1–3, 6; 07 machine 7): `ConversationCommands.send`
// over one copy of the template database (the real `SqliteMessageLog`), the real `TurnSender` bridge
// (bridges/turnSender.ts) to a `SimulatedDriver` session or a scripted sender, a `FakeClock` and the
// snapshot `marks` section. Driver events reach conversation only with ISSUE-182, so this file routes
// the simulated session's `turn.ended` to `recordTurnEnd` itself, as that route will.
//
// TC-166-02 (no ack in 30 s: delivered{unconfirmed}, never reacted without correlated activity);
// TC-166-03 (a repeated requestId after a Host restart returns the stored messageId, nothing handed
// over); TC-166-04 (a reattached UI gets the Host's phase of each message).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DwarfId, MessageId, MineId, ProviderIdentity } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import {
  advance,
  createConversation,
  type Conversation,
  type ConversationEvent,
  type Delivery,
  type SendEvent,
  type TurnHandOver,
  type TurnSender,
  type TurnSendResult
} from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import type {
  DriverSession,
  ProviderCapabilities,
  ProviderProfile,
  TurnInput
} from '../../modules/suppliers'
import {
  SIMULATED_HANDSHAKE_MS,
  SIMULATED_STEP_MS,
  SimulatedDriver,
  type SimulatedSession
} from '../../modules/suppliers/adapters/drivers/simulated/SimulatedDriver'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { marksSection } from '../../transport/snapshot/marksSection'
import { launchedTurnSender } from '../bridges/turnSender'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000001f6' as MineId
const DWARF = '00000000-0000-7000-8000-0000000016d1' as DwarfId
const IDENTITY: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-166' }
const request = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

const PROFILE: ProviderProfile = {
  id: 'simulated',
  label: 'Simulated',
  binaries: [],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['acp'],
  publicLaunch: 'enabled'
}

function capabilities(reactionEvidence: ProviderCapabilities['reactionEvidence']) {
  return {
    launch: true,
    observe: true,
    sendTurn: true,
    interrupt: true,
    permission: 'none',
    question: 'none',
    answeredElsewhere: false,
    staleAnswerSafe: true,
    resume: 'none',
    adopt: false,
    turnEnd: 'reliable',
    reactionEvidence,
    subagents: 'none',
    usage: { fidelity: 0, rateLimits: false },
    mcpInjection: 'none',
    console: 'log',
    earlyFailure: 'handshake',
    installDetection: 'none',
    observedPermission: 'none',
    observedQuestion: 'none'
  } satisfies ProviderCapabilities
}

/** Lets every pending promise continuation run (no timers: the scheduler is fake). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** A sender a test answers by hand, recording each turn and what the log held when it came. */
class ScriptedTurnSender implements TurnSender {
  readonly turns: TurnInput[] = []
  readonly rowsAtHandOver: Array<Delivery | undefined> = []
  private pending: Array<(result: TurnSendResult) => void> = []

  constructor(private readonly peek: () => Delivery | undefined) {}

  send(_dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    this.turns.push(turn)
    this.rowsAtHandOver.push(this.peek())
    return new Promise((resolve) => this.pending.push(resolve))
  }

  answer(result: TurnSendResult): void {
    const next = this.pending.shift()
    if (next === undefined) throw new Error('no hand-over is waiting')
    next(result)
  }
}

const RECEIPT: TurnHandOver = {
  confidence: 'confirmed',
  heldUntilTurnEnd: false,
  correlation: 'c-1',
  providerTurnId: 'turn-9',
  reactionEvidence: 'turn-id'
}

const opened: Array<{ close(): void }> = []
afterEach(() => {
  opened.splice(0)
})

/** Every unhandled rejection while a case runs: the Host would exit on one (wiring/uncaught.ts). */
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})
afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

/** One macrotask turn (no time passes), after which Node has reported any unhandled rejection. */
async function rejectionsReported(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** One Host database with the dwarf's row, and conversation booted over it as often as asked. */
function world() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-166', 'mine-166', 'mine-166', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'simulated', 'session-166', 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
  })
  let boots = 0
  return {
    db,
    clock,
    scheduler,
    /** A Host boot: a new epoch and a new conversation over the same database. */
    boot(turns: (peek: () => Delivery | undefined) => TurnSender, receives = () => true) {
      boots += 1
      const bus = new RecordingEventBus<ConversationEvent | SendEvent>({
        transactionScope: transactions
      })
      const conversation: Conversation = createConversation({
        db,
        transactions,
        bus,
        lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
        clock,
        ids,
        hostEpoch: `epoch-166-${boots}`
      })
      const stored = (): Delivery[] =>
        conversation.queries
          .feed(DWARF, { limit: 50 })
          .messages.flatMap((m) => (m.delivery === undefined ? [] : [m.delivery]))
      const sender = turns(() => stored()[0])
      const diagnostics = new RecordingDiagnosticsLog()
      const { send } = conversation.sending({
        turns: sender,
        recipients: { canReceiveMessages: (dwarfId) => dwarfId === DWARF && receives() },
        bus,
        diagnostics
      })
      return {
        conversation,
        bus,
        send,
        stored,
        sender,
        diagnostics,
        rowCount: () => rowCount(db)
      }
    }
  }
}

function rowCount(db: SqliteDatabase): number {
  return Number(db.all('SELECT count(*) AS n FROM messages WHERE dwarf_id = ?', [DWARF])[0]?.['n'])
}

/** A launched simulated session, its `turn.ended` routed to `recordTurnEnd` as ISSUE-182 will. */
async function simulatedSession(
  w: ReturnType<typeof world>,
  reactionEvidence: ProviderCapabilities['reactionEvidence'] = 'turn-id'
): Promise<SimulatedSession> {
  const driver = new SimulatedDriver({
    profile: PROFILE,
    transport: 'acp',
    capabilities: capabilities(reactionEvidence),
    seed: 'seed-166',
    clock: w.clock,
    scheduler: w.scheduler
  })
  const pending = driver.launch({
    launchId: 'launch-166' as never,
    install: {
      providerId: 'simulated',
      binaryPath: 'simulated',
      version: '1',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-166' as never,
    prompt: 'first prompt',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install:launch-166:epoch',
    onSpawned: async () => {}
  })
  await settle()
  w.clock.advance(SIMULATED_HANDSHAKE_MS)
  return pending
}

/** Routes the session's turn ends to conversation (the driver route of ISSUE-182). */
function routeTurnEnds(session: SimulatedSession, conversation: Conversation): void {
  void (async () => {
    for await (const event of session.events()) {
      if (event.t === 'turn.ended') {
        conversation.commands.recordTurnEnd({ ...event.end, dwarfId: DWARF })
      }
      if (event.t === 'exited') return
    }
  })()
}

/** The real bridge to `session`, or to no session when the route went away. */
function bridgeTo(session: () => DriverSession | null) {
  return () =>
    launchedTurnSender({
      dwarfs: { identityOf: () => IDENTITY },
      sessions: { sessionFor: () => session() }
    })
}

describe('send message flow F4', () => {
  it('[US-MSG-001.AC01, S7.01, INV-63] send writes the message and a sending delivery before any hand-over and answers with the messageId', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))

    const answer = await host.send(DWARF, 'dig the north seam', [], request(1))

    expect(answer.ok).toBe(true)
    const messageId = (answer as { value: MessageId }).value
    // Answered at acceptance with the row's id; its bubble and "…" mark were published first.
    expect(host.bus.published.map((e) => e.type)).toEqual(['MessagesAppended', 'MessageSent'])
    const appended = host.bus.ofType('MessagesAppended')[0]?.payload.messages[0]
    expect(appended).toMatchObject({ id: messageId, role: 'person', text: 'dig the north seam' })

    await settle()
    // The hand-over came after the write, and the row was there, `sending`, when it did (INV-63).
    expect(scripted?.turns).toEqual([
      { messageId, kind: 'message', text: 'dig the north seam', attachments: [] }
    ])
    expect(scripted?.rowsAtHandOver).toEqual([
      { messageId, dwarfId: DWARF, kind: 'message', phase: 'sending', attempts: 1, phaseAt: T0 }
    ])
  })

  it('[US-MSG-001.AC03, S7.04] the mark becomes delivered when the session accepts the turn', async () => {
    const w = world()
    const session = await simulatedSession(w)
    const host = w.boot(bridgeTo(() => session))

    const answer = await host.send(DWARF, 'carry on', [], request(2))
    await settle()

    const messageId = (answer as { value: MessageId }).value
    expect(host.stored()[0]).toEqual({
      messageId,
      dwarfId: DWARF,
      kind: 'message',
      phase: 'delivered',
      confidence: 'confirmed',
      attempts: 1,
      phaseAt: T0 + SIMULATED_HANDSHAKE_MS
    })
    expect(host.bus.ofType('MessageHandedOver').map((e) => e.payload)).toEqual([
      { messageId, dwarfId: DWARF, confidence: 'confirmed' }
    ])
  })

  it('[US-MSG-001.AC04, S7.05] the mark becomes reacted only when the turn that consumed the message ends with work done', async () => {
    const w = world()
    const session = await simulatedSession(w)
    const host = w.boot(bridgeTo(() => session))
    routeTurnEnds(session, host.conversation)

    await host.send(DWARF, 'survey it', [], request(3))
    await settle()
    expect(host.stored()[0]?.phase).toBe('delivered')

    // The simulated turn's steps, then its `turn.ended {concluded}` for the receipt's turn id.
    for (let i = 0; i < 6; i++) {
      w.clock.advance(SIMULATED_STEP_MS)
      await settle()
    }
    expect(host.stored()[0]).toMatchObject({ phase: 'reacted', confidence: 'confirmed' })
    expect(host.bus.ofType('MessageReactedTo')).toHaveLength(1)
  })

  it('[US-MSG-001.AC05, NFR-TIM-05, S-022-1] a session that correlates by transcript match stays delivered after its turn ends until S-022-1 records the rule', async () => {
    const w = world()
    const session = await simulatedSession(w, 'transcript-match')
    const host = w.boot(bridgeTo(() => session))
    routeTurnEnds(session, host.conversation)

    await host.send(DWARF, 'survey it', [], request(4))
    for (let i = 0; i < 10; i++) {
      w.clock.advance(SIMULATED_STEP_MS)
      await settle()
    }
    w.clock.advance(86_400_000)
    await settle()

    expect(host.stored()[0]).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })
    expect(host.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[FM-077, NFR-TIM-05] no protocol acknowledgement within 30 s makes the delivery delivered unconfirmed, never reacted', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    await host.send(DWARF, 'are you there', [], request(5))
    await settle()

    // The driver wrote the turn and heard no ack for 30 s (15 §1.3): its receipt says so.
    w.scheduler.after(30_000, () =>
      scripted?.answer({ ok: true, value: { ...RECEIPT, confidence: 'unconfirmed' } })
    )
    w.clock.advance(29_999)
    await settle()
    expect(host.stored()[0]?.phase).toBe('sending')
    w.clock.advance(1)
    await settle()
    expect(host.stored()[0]).toMatchObject({ phase: 'delivered', confidence: 'unconfirmed' })

    // However long it waits, and whatever other turn ends, it stays ✓.
    for (const ms of [60_000, 3_600_000, 86_400_000 * 7]) {
      w.clock.advance(ms)
      await settle()
      host.conversation.commands.recordTurnEnd({
        dwarfId: DWARF,
        turnKey: `other-turn-${ms}`,
        kind: 'concluded',
        at: w.clock.now(),
        reliability: 'reliable',
        cancelledFromApp: false
      })
      expect(host.stored()[0]).toMatchObject({ phase: 'delivered', confidence: 'unconfirmed' })
    }
    expect(host.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[US-MSG-001.AC11, INV-33] a dwarf that cannot receive refuses send with cannot-receive and writes no row', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    let receives = false
    const host = w.boot(
      (peek) => (scripted = new ScriptedTurnSender(peek)),
      () => receives
    )

    expect(await host.send(DWARF, 'hello?', [], request(6))).toEqual({
      ok: false,
      error: 'cannot-receive'
    })
    expect(await host.send(DWARF, 'with a file', ['/tmp/a.txt'], request(7))).toEqual({
      ok: false,
      error: 'attachment-refused'
    })
    await settle()
    expect(host.rowCount()).toBe(0)
    expect(host.bus.published).toEqual([])
    expect(scripted?.turns).toEqual([])

    // The refusal is the dwarf's state, not the request's: once it can receive, the same requestId sends.
    receives = true
    expect((await host.send(DWARF, 'hello?', [], request(6))).ok).toBe(true)
    await settle()
    expect(host.rowCount()).toBe(1)
    expect(scripted?.turns).toHaveLength(1)
  })

  it('[US-MSG-013.AC01, US-MSG-013.AC06, S7.07, FM-078] a session that ended, or whose delivery route went away while its process lives, fails a sending message session-closed and makes canReceiveMessages false', async () => {
    // The session ended: the driver refuses the turn with `session-closed`.
    const ended = world()
    const session = await simulatedSession(ended)
    await session.close('end-thread')
    const first = ended.boot(bridgeTo(() => session))
    await first.send(DWARF, 'still there?', [], request(8))
    await settle()
    expect(first.stored()[0]).toMatchObject({
      phase: 'failed',
      failure: { kind: 'session-closed' }
    })

    // The process lives but its delivery route went away: no session to reach. The send was
    // accepted while crew still saw the route; once it sees none, canReceiveMessages is false.
    const gone = world()
    let routed = true
    const second = gone.boot(
      bridgeTo(() => null),
      () => routed
    )
    const sent = await second.send(DWARF, 'hello again', [], request(9))
    await settle()
    expect(sent.ok).toBe(true)
    expect(second.stored()[0]).toMatchObject({
      phase: 'failed',
      failure: { kind: 'session-closed' }
    })
    routed = false
    expect(await second.send(DWARF, 'hello?', [], request(10))).toEqual({
      ok: false,
      error: 'cannot-receive'
    })
    expect(second.bus.ofType('MessageDeliveryFailed').map((e) => e.payload.failure)).toEqual([
      { kind: 'session-closed' }
    ])
  })

  it('[US-OBS-005.AC04, US-MSG-013.AC02, S7.12] a failed message of a dwarf that can no longer receive offers no retry: retry answers cannot-receive and the row keeps its failure', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    let receives = true
    const host = w.boot(
      (peek) => (scripted = new ScriptedTurnSender(peek)),
      () => receives
    )
    await host.send(DWARF, 'before the closure', [], request(11))
    await settle()
    scripted?.answer({ ok: false, error: { kind: 'channel-error', reason: 'pipe closed' } })
    await settle()
    receives = false

    const failed = host.stored()[0] as Delivery
    // Machine 7: with `canReceiveMessages` false a Retry is no transition (S7.09's guard), and the
    // row only takes S7.12, unchanged. The retry command itself is ISSUE-168's.
    expect(advance(failed, { t: 'retry', canReceiveMessages: false }, w.clock.now())).toEqual({
      ok: false,
      refused: 'not-in-machine-7'
    })
    expect(advance(failed, { t: 'cannot-receive' }, w.clock.now())).toEqual({
      ok: true,
      transition: 'S7.12',
      delivery: failed
    })
    expect(await host.send(DWARF, 'before the closure', [], request(12))).toEqual({
      ok: false,
      error: 'cannot-receive'
    })
    expect(host.stored()).toEqual([failed])
    expect(failed).toMatchObject({
      phase: 'failed',
      failure: { kind: 'channel-error', reason: 'pipe closed' }
    })
  })

  it('[FM-076, S7.06] a channel error fails the message channel-error and nothing retries by itself (BR-17)', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    await host.send(DWARF, 'over the wire', [], request(13))
    await settle()
    scripted?.answer({ ok: false, error: { kind: 'channel-error', reason: 'pipe closed' } })
    await settle()

    w.clock.advance(86_400_000)
    await settle()
    expect(host.stored()[0]).toMatchObject({
      phase: 'failed',
      failure: { kind: 'channel-error', reason: 'pipe closed' },
      attempts: 1
    })
    expect(scripted?.turns).toHaveLength(1)
  })

  it('[US-MSG-001.AC10, US-RES-003.AC03, S7.18, NFR-PERS-04, BR-07] a message still sending while every UI is detached shows, on the next attach, the phase the Host recorded meanwhile', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    const marks = marksSection({
      mines: { list: () => [{ mineId: MINE }] } as unknown as Pick<MinesQueries, 'list'>,
      crew: {
        crewOf: () => [{ id: DWARF, departed: false }]
      } as unknown as Pick<CrewQueries, 'crewOf'>,
      conversation: host.conversation.queries
    })
    const first = await host.send(DWARF, 'one', [], request(14))
    const second = await host.send(DWARF, 'two', [], request(15))
    await settle()

    // Every window closed: nothing reads. The Host settles one message and not the other.
    scripted?.answer({ ok: true, value: RECEIPT })
    await settle()

    // The next attach reads the marks: one ✓ it earned, one still "…", never a mark it did not earn.
    const byId = new Map(marks().map((mark) => [mark.messageId, mark]))
    expect(byId.get((first as { value: MessageId }).value)).toMatchObject({
      phase: 'delivered',
      confidence: 'confirmed'
    })
    expect(byId.get((second as { value: MessageId }).value)).toMatchObject({ phase: 'sending' })
    expect(byId.get((second as { value: MessageId }).value)?.failure).toBeUndefined()
  })

  it('[ADR-022, S7.03] a message sent during a running turn is held until the turn ends, then handed over', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    await host.send(DWARF, 'after this turn', [], request(16))
    await settle()
    scripted?.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()
    expect(host.stored()[0]).toMatchObject({ phase: 'sending', heldUntilTurnEnd: true })
    expect(host.bus.ofType('MessageHandedOver')).toEqual([])

    host.conversation.commands.recordTurnEnd({
      dwarfId: DWARF,
      turnKey: 'running-turn',
      kind: 'concluded',
      at: w.clock.now(),
      reliability: 'reliable',
      cancelledFromApp: false
    })
    expect(host.stored()[0]).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })
    expect(host.stored()[0]?.heldUntilTurnEnd).toBeUndefined()
    // The turn that ended was the one it waited behind, not its own: no ✓✓ from it.
    expect(host.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[ADR-022] conversation.send repeated with the same requestId after a Host restart returns the first messageId and hands nothing over', async () => {
    const w = world()
    let before: ScriptedTurnSender | undefined
    const first = w.boot((peek) => (before = new ScriptedTurnSender(peek)))
    const sent = await first.send(DWARF, 'only once', [], request(17))
    await settle()
    expect(before?.turns).toHaveLength(1)

    // The Host restarts (new epoch, empty memory); the dwarf can no longer receive meanwhile.
    let after: ScriptedTurnSender | undefined
    const restarted = w.boot(
      (peek) => (after = new ScriptedTurnSender(peek)),
      () => false
    )
    const repeat = await restarted.send(DWARF, 'only once', [], request(17))
    await settle()

    expect(repeat).toEqual(sent)
    expect(after?.turns).toEqual([])
    expect(restarted.bus.published).toEqual([])
    expect(restarted.rowCount()).toBe(1)
  })

  it('[ADR-022, INV-63] a message deleted with its delivery while its hand-over is pending ends the tracking quietly, never as an unhandled rejection', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    await host.send(DWARF, 'before the reset', [], request(18))
    await settle()

    // The dwarf's rows go while the hand-over waits (as when a departed dwarf's messages are
    // deleted); its delivery goes with its message (`deliveries` ON DELETE CASCADE).
    w.db.run('DELETE FROM messages WHERE dwarf_id = ?', [DWARF])
    scripted?.answer({ ok: true, value: RECEIPT })
    await rejectionsReported()
    host.conversation.commands.recordTurnEnd({
      dwarfId: DWARF,
      turnKey: 'turn-9',
      kind: 'concluded',
      at: w.clock.now(),
      reliability: 'reliable',
      cancelledFromApp: false
    })
    await rejectionsReported()

    expect(unhandled).toEqual([])
    expect(host.diagnostics.entries).toEqual([])
    expect(host.bus.ofType('MessageHandedOver')).toEqual([])
  })

  it('[US-OBS-005.AC04, US-MSG-013.AC01, S7.07] a held message fails session-closed when recordSessionEnd routes the session end or departure', async () => {
    const w = world()
    let scripted: ScriptedTurnSender | undefined
    const host = w.boot((peek) => (scripted = new ScriptedTurnSender(peek)))
    await host.send(DWARF, 'queued then closed', [], request(19))
    await settle()
    scripted?.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()
    expect(host.stored()[0]).toMatchObject({ phase: 'sending', heldUntilTurnEnd: true })

    host.conversation.commands.recordSessionEnd(DWARF, w.clock.now())

    expect(host.stored()[0]).toMatchObject({
      phase: 'failed',
      failure: { kind: 'session-closed' }
    })
    expect(host.bus.ofType('MessageDeliveryFailed')).toHaveLength(1)
  })
})
