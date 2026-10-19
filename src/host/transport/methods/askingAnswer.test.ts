// layer: L6
// L6 (17 §1.6): B-M30 `asking.answerQuestion` and B-M31 `asking.answerPermission` (14 §2.3, §3.4
// `AnswerQuestionParams`, `AnswerPermissionParams`, ADR-010 `AnswerOutcome`; ADR-003 items 6, 12)
// over the real seam-B transport — frame codec, hello-first authentication, roles, the requestId
// table, the Host dispatcher main composes — behind in-process duplexes, with the broker's two
// answer paths recorded by a scripted double. Every answer is validated against its contract schema
// (14 §1.4).
//
// TC-128-03 (invalid payloads and another role refused; answers never logged). The frames half of
// "answers after the channel result, every frame before the res" needs the broker's events as
// frames (later: ISSUE-130); the transport half — no res until the broker settled — is proved here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_METHOD_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { AnswerOutcome, QuestionAnswers } from '../../kernel/domain/sharedContracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { AskBroker } from '../../modules/asking'
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
import { registerAskingAnswer } from './askingAnswer'
import { createUpgradeTargetRule } from './hostUpgradeRequest'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0128'
const T0 = 1_790_000_000_000
/** A free-text answer that must never reach a log line (NFR-SEC-12). */
const CANARY = 'canary-0128-free-text-answer'

const uuid = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`
const ASK = uuid(0xa5)

type BrokerCall =
  | { path: 'question'; askId: string; answers: QuestionAnswers; requestId: string }
  | { path: 'permission'; askId: string; decision: 'allow' | 'deny'; requestId: string }

/** The broker's two answer paths, recorded; each answers the next scripted outcome, held on request. */
class ScriptedBroker implements Pick<AskBroker, 'answerQuestion' | 'answerPermission'> {
  readonly calls: BrokerCall[] = []
  readonly outcomes: AnswerOutcome[] = []
  hold = false
  private readonly held: Array<() => void> = []

  release(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  answerQuestion(askId: string, answers: QuestionAnswers, requestId: string) {
    this.calls.push({ path: 'question', askId, answers, requestId })
    return this.next()
  }

  answerPermission(askId: string, decision: 'allow' | 'deny', requestId: string) {
    this.calls.push({ path: 'permission', askId, decision, requestId })
    return this.next()
  }

  private next(): Promise<AnswerOutcome> {
    const outcome = this.outcomes.shift() ?? { kind: 'accepted' }
    if (!this.hold) return Promise.resolve(outcome)
    return new Promise((resolve) => this.held.push(() => resolve(outcome)))
  }
}

/** One Host transport serving B-M30 and B-M31 over the scripted broker. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-128-answer-'))
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
  const broker = new ScriptedBroker()
  registerAskingAnswer(dispatcher, { broker })

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

  return { attach, broker, log }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

function isRes(frame: unknown, id: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === id
}

/** Sends one request; returns its frame id. */
function request(client: FrameClient, method: string, params: unknown): string {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  return id
}

/** Waits for the `res` of request `id` and returns it. */
async function response(client: FrameClient, id: string): Promise<Res> {
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  return response(client, request(client, method, params))
}

/** The answer's `AnswerOutcome`, validated by the method's result schema. */
function outcomeOf(res: Res, method: 'asking.answerQuestion' | 'asking.answerPermission'): unknown {
  expect(res.ok ? undefined : res.error.code).toBeUndefined()
  return res.ok ? HOST_METHOD_SCHEMAS[method].result.parse(res.result) : undefined
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('asking.answerQuestion and asking.answerPermission over seam B (B-M30, B-M31)', () => {
  it('[ADR-003] asking.answerPermission accepts only allow or deny and asking.answerQuestion only QuestionAnswers; any other value gets INVALID_PARAMS', async () => {
    const { attach, broker } = await host()
    const ui = await attach('ui')

    for (const params of [
      { askId: ASK, decision: 'always', requestId: uuid(1) },
      { askId: ASK, decision: 'allow_always', requestId: uuid(2) },
      { askId: ASK, decision: 'Allow', requestId: uuid(3) },
      { askId: ASK, decision: 'allow' },
      { askId: ASK, decision: 'allow', requestId: 'r-1' },
      { askId: 'ask-1', decision: 'allow', requestId: uuid(4) },
      { askId: ASK, decision: 'allow', requestId: uuid(5), scope: 'session' },
      { askId: ASK, answers: [{ step: 0, option: 'Yes' }], requestId: uuid(6) }
    ]) {
      expect(
        codeOf(await call(ui, 'asking.answerPermission', params)),
        JSON.stringify(params)
      ).toBe('INVALID_PARAMS')
    }
    for (const params of [
      { askId: ASK, answers: [{ step: -1, option: 'Yes' }], requestId: uuid(7) },
      { askId: ASK, answers: [{ step: 0, option: 7 }], requestId: uuid(8) },
      { askId: ASK, answers: [{ step: 0, picks: ['Yes'] }], requestId: uuid(9) },
      { askId: ASK, answers: 'Yes', requestId: uuid(10) },
      { askId: ASK, decision: 'allow', requestId: uuid(11) },
      { askId: ASK, answers: [{ step: 0, option: 'Yes' }] }
    ]) {
      expect(codeOf(await call(ui, 'asking.answerQuestion', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(broker.calls).toEqual([])

    // The valid shapes reach the broker unchanged, with the caller's requestId.
    expect(
      outcomeOf(
        await call(ui, 'asking.answerPermission', {
          askId: ASK,
          decision: 'deny',
          requestId: uuid(12)
        }),
        'asking.answerPermission'
      )
    ).toEqual({ kind: 'accepted' })
    expect(
      outcomeOf(
        await call(ui, 'asking.answerQuestion', {
          askId: ASK,
          answers: [
            { step: 0, option: 'Yes' },
            { step: 1, freeText: 'Keep them until Friday' }
          ],
          requestId: uuid(13)
        }),
        'asking.answerQuestion'
      )
    ).toEqual({ kind: 'accepted' })
    expect(broker.calls).toEqual([
      { path: 'permission', askId: ASK, decision: 'deny', requestId: uuid(12) },
      {
        path: 'question',
        askId: ASK,
        answers: [
          { step: 0, option: 'Yes' },
          { step: 1, freeText: 'Keep them until Friday' }
        ],
        requestId: uuid(13)
      }
    ])
  })

  it('[ADR-003] a notifier calling either answer method gets FORBIDDEN and the broker is never called', async () => {
    const { attach, broker } = await host()
    const notifier = await attach('notifier')

    expect(
      codeOf(
        await call(notifier, 'asking.answerPermission', {
          askId: ASK,
          decision: 'allow',
          requestId: uuid(20)
        })
      )
    ).toBe('FORBIDDEN')
    expect(
      codeOf(
        await call(notifier, 'asking.answerQuestion', {
          askId: ASK,
          answers: [{ step: 0, option: 'Yes' }],
          requestId: uuid(21)
        })
      )
    ).toBe('FORBIDDEN')
    expect(broker.calls).toEqual([])
  })

  it('[ADR-003] the answer methods answer only once the broker settled, with its outcome unchanged', async () => {
    const { attach, broker } = await host()
    const ui = await attach('ui')
    broker.hold = true
    broker.outcomes.push({ kind: 'refused', reason: 'channel-unavailable' }, { kind: 'not-open' })

    const permission = request(ui, 'asking.answerPermission', {
      askId: ASK,
      decision: 'allow',
      requestId: uuid(30)
    })
    const question = request(ui, 'asking.answerQuestion', {
      askId: ASK,
      answers: [{ step: 0, option: 'Yes' }],
      requestId: uuid(31)
    })
    await ui.until(() => broker.calls.length === 2)
    await ui.settle()
    expect(ui.frames.some((frame) => isRes(frame, permission) || isRes(frame, question))).toBe(
      false
    )

    broker.release()
    expect(outcomeOf(await response(ui, permission), 'asking.answerPermission')).toEqual({
      kind: 'refused',
      reason: 'channel-unavailable'
    })
    // A stale submit's not-open reaches the UI unchanged (ADR-010 item 5): it renders nothing.
    expect(outcomeOf(await response(ui, question), 'asking.answerQuestion')).toEqual({
      kind: 'not-open'
    })
  })

  it('[INV-79] the same requestId twice on a connection returns the first result and calls the broker once', async () => {
    const { attach, broker } = await host()
    const ui = await attach('ui')
    const params = { askId: ASK, decision: 'allow', requestId: uuid(40) }

    const first = outcomeOf(
      await call(ui, 'asking.answerPermission', params),
      'asking.answerPermission'
    )
    broker.outcomes.push({ kind: 'not-open' })
    const second = outcomeOf(
      await call(ui, 'asking.answerPermission', params),
      'asking.answerPermission'
    )

    expect(first).toEqual({ kind: 'accepted' })
    expect(second).toEqual(first)
    expect(broker.calls).toHaveLength(1)
  })

  it('[NFR-SEC-12] free-text answers never reach a log line', async () => {
    const { attach, log } = await host()
    const ui = await attach('ui')

    await call(ui, 'asking.answerQuestion', {
      askId: ASK,
      answers: [{ step: 0, freeText: CANARY }],
      requestId: uuid(50)
    })
    // A refused payload carrying the canary is not logged either.
    await call(ui, 'asking.answerQuestion', {
      askId: ASK,
      answers: [{ step: 0, freeText: CANARY, extra: CANARY }],
      requestId: uuid(51)
    })

    expect(
      log.byEvent('channel.req').some((entry) => entry.method === 'asking.answerQuestion')
    ).toBe(true)
    expect(JSON.stringify([log.entries, log.refused])).not.toContain(CANARY)
  })
})
