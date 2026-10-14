// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Dwarf,
  DwarfPermissionAnswerRequest,
  DwarfPermissionRequest,
  DwarfQuestion,
  DwarfQuestionAnswerRequest,
  DwarfQuestionAnswerResult
} from '../types'
import type {
  AskId,
  AskRecord,
  DwarfId,
  HostFrame,
  HostFrames,
  IpcResult,
  SnapshotPage,
  UiSessionChange,
  UiSessionPatch,
  UiSessionSnapshot
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { defaultDwarf, defaultMine } from '../testing/factories'
import { ref } from 'vue'
import { DEFAULT_AUDIO_PREFERENCES } from '../types'
import { useAttentionCues } from './useAttentionCues'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useDwarfQuestion } from './useDwarfQuestion'
import { useMines } from './useMines'
import { useToasts } from './useToasts'

/**
 * AMENDED for ISSUE-141 (was: the fake answered today's `DwarfQuestionAnswerResult`): from the cut-2 switch A-40 and
 * A-41 answer `IpcResult<AnswerOutcome>` (14 §3.4; ADR-010 item 5). These cases still script each verdict in today's
 * words, and the bridge answers it in the 14 shape: handed over is `accepted`, a refusal is `refused` (whose reason is a
 * code: the panel shows today's "That answer could not be delivered.", never main's own sentence any more), and a
 * bridge that never answered still rejects.
 */
function asOutcome(result: Promise<DwarfQuestionAnswerResult>): Promise<unknown> {
  return result.then((today) =>
    today.answered
      ? { ok: true, value: { kind: 'accepted' } }
      : { ok: true, value: { kind: 'refused', reason: 'channel-rejected' } }
  )
}

/** The panel's own words for an answer not handed over (today's, unchanged). */
const NOT_ANSWERED = 'That answer could not be delivered.'

/** A UUIDv7, as each submit's `requestId` is minted (14 §1.6). */
const REQUEST_ID = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
)

function stubApi(
  answerDwarfQuestion: (request: never) => Promise<DwarfQuestionAnswerResult>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { answerDwarfQuestion: (request: never) => asOutcome(answerDwarfQuestion(request)) }
  })
}

/** Same shape as stubApi, for the permission channel `decide` sends over. */
function stubPermissionApi(
  answerDwarfPermission: (request: never) => Promise<DwarfQuestionAnswerResult>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      answerDwarfQuestion: vi.fn(),
      answerDwarfPermission: (request: never) => asOutcome(answerDwarfPermission(request))
    }
  })
}

/** Resolves only when `release()` is called, so a pending state can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

// AMENDED for #443 (was: the question's fields flat beside `questionCount: 1`).
// Every override below names a call field, which the new shape still spreads.
function question(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    channel: 'held',
    questions: [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }]
      }
    ],
    ...overrides
  }
}

describe('useDwarfQuestion', () => {
  beforeEach(() => {
    useDwarfQuestion().clearAll()
  })

  it('marks the dwarf as answering that ask until the verdict arrives', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    stubApi(() => pending.promise)
    const { answer, stateFor } = useDwarfQuestion()

    const answering = answer('claude:s1', question(), 'SQLite')
    expect(stateFor('claude:s1')).toEqual({ phase: 'answering', toolUseId: 'toolu_01' })

    pending.release({ answered: true })
    await answering
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_01' })
  })

  it('answers with the agent’s own words, keyed by the question it asked', async () => {
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => Promise.resolve({ answered: true })
    )
    stubApi(sent)
    const { answer } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    // AMENDED for ISSUE-141 (was: today's `{ dwarfId, toolUseId, answers: { [question text]: label } }`): the 14
    // `AnswerQuestionParams`, the ask's own id, each label on its step, one requestId per submit.
    expect(sent).toHaveBeenCalledWith({
      askId: 'toolu_01',
      answers: [{ step: 0, option: 'SQLite' }],
      requestId: REQUEST_ID
    })
  })

  it('keeps main’s refusal and its reason so the panel can explain itself', async () => {
    stubApi(() =>
      Promise.resolve({
        answered: false,
        error: 'That session is not one this panel is holding.'
      })
    )
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    // AMENDED for ISSUE-141 (was: main's own sentence): a refused `AnswerOutcome` carries a reason code, so the panel
    // explains itself with today's own words.
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: NOT_ANSWERED
    })
  })

  it('treats a bridge that never answered as a refusal, not as an answer', async () => {
    // Nothing was released, so nothing may be claimed — and the panel still has
    // to be able to say why the card went back to being answerable.
    stubApi(() => Promise.reject(new Error('bridge down')))
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: 'The panel lost contact with the app.'
    })
  })

  it('never releases the same tool call twice while one answer is in flight', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => pending.promise
    )
    stubApi(sent)
    const { answer } = useDwarfQuestion()

    const first = answer('claude:s1', question(), 'SQLite')
    await answer('claude:s1', question(), 'Postgres')
    expect(sent).toHaveBeenCalledTimes(1)

    pending.release({ answered: true })
    await first
  })

  it('lets a refused answer be tried again', async () => {
    let answered = false
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => {
        const result = answered
          ? { answered: true }
          : { answered: false, error: 'That question is no longer open.' }
        answered = true
        return Promise.resolve(result)
      }
    )
    stubApi(sent)
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    await answer('claude:s1', question(), 'Postgres')
    expect(sent).toHaveBeenCalledTimes(2)
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_01' })
  })

  it('stamps each verdict with the ask it belongs to, never the one before it', async () => {
    stubApi(() => Promise.resolve({ answered: true }))
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    await answer('claude:s1', question({ toolUseId: 'toolu_02' }), 'Postgres')
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_02' })
  })

  it('keeps one dwarf’s verdict off another dwarf', async () => {
    stubApi(() => Promise.resolve({ answered: true }))
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    expect(stateFor('claude:s2')).toBeUndefined()
  })

  /* --- Answering in the person's own words (#481) — one block, appended ---- */

  it('sends the words as the answer’s own field, with no record beside them', async () => {
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => Promise.resolve({ answered: true })
    )
    stubApi(sent)
    const { answerWithText } = useDwarfQuestion()

    await answerWithText('claude:s1', question({ channel: 'terminal' }), 'put it in Redis')
    // AMENDED for ISSUE-141 (was: today's `{ dwarfId, toolUseId, text }`): the 14 shape's free text of the first step.
    expect(sent).toHaveBeenCalledWith({
      askId: 'toolu_01',
      answers: [{ step: 0, freeText: 'put it in Redis' }],
      requestId: REQUEST_ID
    })
  })

  it('writes the same verdict the option answer does, into the same store', async () => {
    // One store for both, because a verdict is about a toolUseId whichever way
    // the answer was given — the module's own rule since #203.
    stubApi(() => Promise.resolve({ answered: true }))
    const { answerWithText, stateFor } = useDwarfQuestion()

    await answerWithText('claude:s1', question({ channel: 'terminal' }), 'put it in Redis')
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_01' })
  })

  it('keeps main’s refusal so the card can print the reason verbatim', async () => {
    stubApi(() => Promise.resolve({ answered: false, error: 'There was nothing written to send.' }))
    const { answerWithText, stateFor } = useDwarfQuestion()

    await answerWithText('claude:s1', question({ channel: 'terminal' }), '   ')
    // AMENDED for ISSUE-141 (was: main's own sentence, printed verbatim): a refused `AnswerOutcome` carries a reason
    // code, so the card prints today's own words.
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: NOT_ANSWERED
    })
  })

  it('treats a bridge that never answered as a refusal here too', async () => {
    stubApi(() => Promise.reject(new Error('bridge down')))
    const { answerWithText, stateFor } = useDwarfQuestion()

    await answerWithText('claude:s1', question({ channel: 'terminal' }), 'put it in Redis')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: 'The panel lost contact with the app.'
    })
  })

  it('never releases the same tool call twice, whichever form the second takes', async () => {
    // The in-flight guard is the store's and not the form's: a typed answer
    // behind an option answer would release the same blocked call twice.
    const pending = deferred<DwarfQuestionAnswerResult>()
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => pending.promise
    )
    stubApi(sent)
    const { answer, answerWithText } = useDwarfQuestion()

    const first = answer('claude:s1', question(), 'SQLite')
    await answerWithText('claude:s1', question(), 'put it in Redis')
    expect(sent).toHaveBeenCalledTimes(1)

    pending.release({ answered: true })
    await first
  })

  /* --- A call that asks several questions (#443) — one block, appended ----- */

  function pair(): DwarfQuestion {
    return question({
      questions: [
        {
          question: 'Which database?',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }]
        },
        {
          question: 'Which regions?',
          multiSelect: true,
          options: [{ label: 'East' }, { label: 'West' }]
        }
      ]
    })
  }

  it('sends one request whose answers carry every question of the call', async () => {
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => Promise.resolve({ answered: true })
    )
    stubApi(sent)
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', pair(), ['Postgres', 'West'])
    expect(sent).toHaveBeenCalledTimes(1)
    // AMENDED for ISSUE-141 (was: today's record keyed by question text): one entry per step, in the call's order.
    expect(sent).toHaveBeenCalledWith({
      askId: 'toolu_01',
      answers: [
        { step: 0, option: 'Postgres' },
        { step: 1, option: 'West' }
      ],
      requestId: REQUEST_ID
    })
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_01' })
  })

  it('keeps the in-flight guard for a several-question answer too', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    const sent = vi.fn<(request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>>(
      () => pending.promise
    )
    stubApi(sent)
    const { answer } = useDwarfQuestion()

    const first = answer('claude:s1', pair(), ['Postgres', 'West'])
    await answer('claude:s1', pair(), ['SQLite', 'East'])
    expect(sent).toHaveBeenCalledTimes(1)

    pending.release({ answered: true })
    await first
  })
})

function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    input: 'rm -rf /tmp/scratch',
    channel: 'held',
    askedAt: '2026-09-05T09:00:00.000Z',
    ...overrides
  }
}

describe('useDwarfQuestion decide (#203)', () => {
  beforeEach(() => {
    useDwarfQuestion().clearAll()
  })

  it('marks the dwarf as answering that prompt until the verdict arrives', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    stubPermissionApi(() => pending.promise)
    const { decide, stateFor } = useDwarfQuestion()

    const deciding = decide('claude:s1', permission(), 'allow')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'answering',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })

    pending.release({ answered: true })
    await deciding
    expect(stateFor('claude:s1')).toEqual({
      phase: 'answered',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
  })

  it('sends the dwarf, the prompt’s own toolUseId and the chosen decision', async () => {
    const sent = vi.fn<
      (request: DwarfPermissionAnswerRequest) => Promise<DwarfQuestionAnswerResult>
    >(() => Promise.resolve({ answered: true }))
    stubPermissionApi(sent)
    const { decide } = useDwarfQuestion()

    await decide('claude:s1', permission(), 'deny')
    // AMENDED for ISSUE-141 (was: today's `{ dwarfId, toolUseId, decision }`): the 14 `AnswerPermissionParams`, the
    // prompt's own id as its AskId, one requestId per submit.
    expect(sent).toHaveBeenCalledWith({
      askId: 'toolu_09',
      decision: 'deny',
      requestId: REQUEST_ID
    })
  })

  it('keeps main’s refusal and its reason so the panel can explain itself', async () => {
    stubPermissionApi(() =>
      Promise.resolve({ answered: false, error: 'That prompt is no longer open.' })
    )
    const { decide, stateFor } = useDwarfQuestion()

    await decide('claude:s1', permission(), 'allow')
    // AMENDED for ISSUE-141 (was: main's own sentence): a refused `AnswerOutcome` carries a reason code.
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_09',
      decision: 'allow',
      error: NOT_ANSWERED
    })
  })

  it('treats a bridge that never answered as a refusal, not as an answer', async () => {
    stubPermissionApi(() => Promise.reject(new Error('bridge down')))
    const { decide, stateFor } = useDwarfQuestion()

    await decide('claude:s1', permission(), 'allow')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_09',
      decision: 'allow',
      error: 'The panel lost contact with the app.'
    })
  })

  it('never releases the same prompt twice while one decision is in flight', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    const sent = vi.fn<
      (request: DwarfPermissionAnswerRequest) => Promise<DwarfQuestionAnswerResult>
    >(() => pending.promise)
    stubPermissionApi(sent)
    const { decide } = useDwarfQuestion()

    const first = decide('claude:s1', permission(), 'allow')
    await decide('claude:s1', permission(), 'deny')
    expect(sent).toHaveBeenCalledTimes(1)

    pending.release({ answered: true })
    await first
  })

  it('shares one store with answer, keyed by dwarf rather than by kind of prompt', async () => {
    // #203's whole reason to reuse DwarfAnswerState rather than a shape of its
    // own: a verdict is about a toolUseId, whichever kind of prompt named it.
    // AMENDED for ISSUE-141 (was: today's `{ answered: true }`): the 14 `accepted` outcome.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        answerDwarfQuestion: vi.fn().mockResolvedValue({ ok: true, value: { kind: 'accepted' } }),
        answerDwarfPermission: vi.fn().mockResolvedValue({ ok: true, value: { kind: 'accepted' } })
      }
    })
    const { answer, decide, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    expect(stateFor('claude:s1')).toEqual({ phase: 'answered', toolUseId: 'toolu_01' })

    await decide('claude:s1', permission(), 'allow')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'answered',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
  })

  /*
   * Issue #203. The decision is kept on the verdict because the panel's own
   * wording depends on it: on a terminal channel an Allow is a keypress
   * waiting to be acted on, and a Deny is an Esc that interrupts the turn if
   * the prompt was already answered there. An ANSWER to a question keeps
   * none, because that vocabulary is the permission prompt's alone.
   */
  it('remembers which decision a verdict was given for', async () => {
    stubPermissionApi(() => Promise.resolve({ answered: true }))
    const { decide, stateFor } = useDwarfQuestion()

    await decide('claude:s1', permission(), 'deny')
    expect(stateFor('claude:s1')?.decision).toBe('deny')
  })

  it('leaves an answered question carrying no decision at all', async () => {
    // AMENDED for ISSUE-141 (was: today's `{ answered: true }`): the 14 `accepted` outcome.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        answerDwarfQuestion: vi.fn().mockResolvedValue({ ok: true, value: { kind: 'accepted' } }),
        answerDwarfPermission: vi.fn()
      }
    })
    const { answer, stateFor } = useDwarfQuestion()

    await answer('claude:s1', question(), 'SQLite')
    expect(stateFor('claude:s1')?.decision).toBeUndefined()
  })
})

/* --- The "Answers:" record (#635, MESSAGE-QUESTIONS 8) — one block, appended ---- */

/*
 * Submitting an ask draws its "Answers:" record in the conversation (decision log, Answers bubble
 * is a record): the answer goes out on the ask's own channel, and the record walks that answer's
 * verdict. It is never a second message — the message channel is never called for it.
 */
describe('useDwarfQuestion: the "Answers:" record', () => {
  const sendDwarfText = vi.fn()

  // AMENDED for ISSUE-141 (was: the fakes answered today's result): each answers the scripted verdict in the 14 shape.
  function stub(result: () => Promise<DwarfQuestionAnswerResult>) {
    const answerDwarfQuestion = vi.fn(() => asOutcome(result()))
    const answerDwarfPermission = vi.fn(() => asOutcome(result()))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { answerDwarfQuestion, answerDwarfPermission, sendDwarfText }
    })
    return { answerDwarfQuestion, answerDwarfPermission }
  }

  function perm(): DwarfPermissionRequest {
    return {
      toolUseId: 'toolu_p1',
      toolName: 'Bash',
      input: 'pnpm install',
      channel: 'held',
      askedAt: '2026-09-28T09:00:00.000Z'
    }
  }

  beforeEach(() => {
    useDwarfQuestion().clearAll()
    useDwarfMessaging().clearAll()
    sendDwarfText.mockClear()
  })

  it('draws the record in sending while the answer is on its way', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    stub(() => pending.promise)
    const answering = useDwarfQuestion().answer('claude:s1', question(), 'SQLite')

    expect(useDwarfMessaging().echoesFor('claude:s1')).toMatchObject([
      {
        text: 'Answers:\n\n- Which database should the importer write to: **SQLite**',
        answers: true,
        state: { phase: 'sending' }
      }
    ])
    pending.release({ answered: true })
    await answering
  })

  it('walks the record to ✓ on the answer’s own verdict, and sends no message', async () => {
    const { answerDwarfQuestion } = stub(() => Promise.resolve({ answered: true }))
    await useDwarfQuestion().answer('claude:s1', question(), 'SQLite')

    expect(useDwarfMessaging().echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'delivered',
      awaitingReaction: true
    })
    expect(answerDwarfQuestion).toHaveBeenCalledTimes(1)
    expect(sendDwarfText).not.toHaveBeenCalled()
  })

  it('reads ✕ with main’s reason when the channel refused the answer', async () => {
    stub(() => Promise.resolve({ answered: false, error: 'That ask is no longer open.' }))
    await useDwarfQuestion().answer('claude:s1', question(), 'SQLite')

    // AMENDED for ISSUE-141 (was: main's own sentence): a refused `AnswerOutcome` carries a reason code.
    expect(useDwarfMessaging().echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'failed',
      error: NOT_ANSWERED
    })
  })

  it('records a terminal answer in the person’s own words', async () => {
    stub(() => Promise.resolve({ answered: true }))
    await useDwarfQuestion().answerWithText('claude:s1', question({ channel: 'terminal' }), 'Redis')

    expect(useDwarfMessaging().echoesFor('claude:s1')[0]?.text).toBe(
      'Answers:\n\n- Which database should the importer write to: **Redis**'
    )
  })

  it('records a permission’s decision as one item, Allow or Deny in bold', async () => {
    const { answerDwarfPermission } = stub(() => Promise.resolve({ answered: true }))
    await useDwarfQuestion().decide('claude:s1', perm(), 'deny')

    expect(useDwarfMessaging().echoesFor('claude:s1')).toMatchObject([
      { text: 'Answers:\n\n- Bash · pnpm install: **Deny**', answers: true }
    ])
    expect(answerDwarfPermission).toHaveBeenCalledTimes(1)
    expect(sendDwarfText).not.toHaveBeenCalled()
  })

  it('draws one record for one submit, however many presses reached it', async () => {
    const pending = deferred<DwarfQuestionAnswerResult>()
    stub(() => pending.promise)
    const first = useDwarfQuestion().answer('claude:s1', question(), 'SQLite')
    await useDwarfQuestion().answer('claude:s1', question(), 'Postgres')
    await useDwarfQuestion().decide('claude:s1', perm(), 'allow')

    expect(useDwarfMessaging().echoesFor('claude:s1')).toHaveLength(1)
    pending.release({ answered: true })
    await first
  })
})
/* --- end of the "Answers:" record block ------------------------------------- */

/* --- MESSAGE-QUESTIONS 19 and 20 on the "Answers:" record — one block, appended ------------- */

describe('useDwarfQuestion: answering again after a refusal (MESSAGE-QUESTIONS 19, 20)', () => {
  beforeEach(() => {
    useDwarfQuestion().clearAll()
    useDwarfMessaging().clearAll()
  })

  it('replaces the refused record in place with the new answer, and walks it again', async () => {
    let answered = false
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        // AMENDED for ISSUE-141 (was: today's result): the scripted verdict in the 14 shape.
        answerDwarfQuestion: vi.fn(() =>
          asOutcome(
            Promise.resolve(answered ? { answered: true } : { answered: false, error: 'nope' })
          )
        )
      }
    })
    await useDwarfQuestion().answer('claude:s1', question(), 'SQLite')
    const [refused] = useDwarfMessaging().echoesFor('claude:s1')
    expect(refused?.state.phase).toBe('failed')

    answered = true
    await useDwarfQuestion().answer('claude:s1', question(), 'Postgres')
    const records = useDwarfMessaging().echoesFor('claude:s1')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: refused!.id,
      text: 'Answers:\n\n- Which database should the importer write to: **Postgres**',
      state: { phase: 'delivered', awaitingReaction: true }
    })
  })

  it('puts the record’s verdict on the dwarf’s marker', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      // AMENDED for ISSUE-141 (was: today's `{ answered: true }`): the 14 `accepted` outcome.
      value: { answerDwarfQuestion: vi.fn(() => asOutcome(Promise.resolve({ answered: true }))) }
    })
    await useDwarfQuestion().answer('claude:s1', question(), 'SQLite')
    expect(useDwarfMessaging().stateFor('claude:s1')).toEqual({
      phase: 'delivered',
      awaitingReaction: true
    })
  })
})
/* --- end of the rulings 19 and 20 block ----------------------------------------------------- */

/* --- The dual-source ask read model (ISSUE-138) — one block, appended ------------------------ */

/*
 * From cut 2 the question store is a read model with two sources (21 §2 cut 2 "Legacy-bridge adapters", §3
 * `LegacyAskRelay`; 14 §6.4 row `useDwarfQuestion`; ADR-033 items 3, 4): the Host's asks (the snapshot `asks` section
 * and the `ask.*` frames above its seq) and the legacy overlay the facade's board carries (its own `legacy:` ids,
 * replaced whole, never sequence-filtered). A card's source is its id namespace. Partial picks live in the UI main
 * session store (`ask-picks`), never in the Host.
 */
describe('useDwarfQuestion: the dual-source ask read model (ISSUE-138)', () => {
  const EPOCH = 'epoch-0138'
  const DWARF_A = '01920000-0000-7000-a000-00000000d001'
  const DWARF_B = '01920000-0000-7000-a000-00000000d002'
  const ASK_A = '01920000-0000-7000-a000-00000000a001'
  const ASK_B = '01920000-0000-7000-a000-00000000a002'
  const ASK_STALE = '01920000-0000-7000-a000-00000000a003'

  type Api = ReturnType<typeof createFakeWindowApi>

  function hostAsk(id: string, dwarfId: string, overrides: Partial<AskRecord> = {}): AskRecord {
    return {
      id,
      dwarfId,
      kind: 'question',
      channel: 'driver',
      providerRequestId: `req-${id.slice(-4)}`,
      payload: {
        steps: [
          { text: 'Which database?', options: ['Postgres', 'SQLite'], allowsFreeText: true },
          { text: 'Which schema?', options: ['public', 'app'], allowsFreeText: true },
          { text: 'Run migrations?', options: ['Yes', 'No'], allowsFreeText: true }
        ]
      },
      currentStep: 0,
      state: 'open',
      reannounce: true,
      openedAt: 1_000,
      ...overrides
    }
  }

  function page(seq: number, asks: AskRecord[]): IpcResult<SnapshotPage> {
    return {
      ok: true,
      value: {
        snapshotId: `snap-${seq}`,
        seq,
        epoch: EPOCH,
        chunks: [{ section: 'asks', data: { asks, needsYou: [] } }]
      }
    } as IpcResult<SnapshotPage>
  }

  function frame<N extends 'ask.opened' | 'ask.closed' | 'ask.step'>(
    seq: number,
    name: N,
    data: HostFrames[N]
  ): HostFrame {
    return { type: 'evt', seq, epoch: EPOCH, name, data } as HostFrame
  }

  interface Fake {
    push(frames: HostFrame[]): void
    patches: UiSessionPatch[]
    session(change: UiSessionChange): void
  }

  function emptySession(askPicks: UiSessionSnapshot['askPicks'] = {}): UiSessionSnapshot {
    return { drafts: {}, chatViews: {}, askPicks, openChat: {}, currentMine: {}, valle: {} }
  }

  /** The fake `window.api`: A-N01/A-N02 for the Host source, A-N17…A-N19 for the UI session store. */
  function install(
    snapshot: () => IpcResult<SnapshotPage>,
    session: UiSessionSnapshot = emptySession()
  ): Fake {
    let listener: ((frames: HostFrame[]) => void) | null = null
    let sessionListener: ((change: UiSessionChange) => void) | null = null
    const patches: UiSessionPatch[] = []
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn(() =>
        Promise.resolve(snapshot())
      ) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }) as unknown as Api['onHostEvent'],
      getUiSession: vi.fn(() => Promise.resolve(session)) as unknown as Api['getUiSession'],
      patchUiSession: vi.fn((patch: UiSessionPatch) => {
        patches.push(patch)
      }) as unknown as Api['patchUiSession'],
      onUiSessionChanged: vi.fn((follow: (change: UiSessionChange) => void) => {
        sessionListener = follow
        return () => {
          sessionListener = null
        }
      }) as unknown as Api['onUiSessionChanged']
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    return {
      push(frames) {
        if (listener === null) throw new Error('nothing follows onHostEvent')
        listener(frames)
      },
      patches,
      session(change) {
        if (sessionListener === null) throw new Error('nothing follows onUiSessionChanged')
        sessionListener(change)
      }
    }
  }

  /** The facade's board (A-12/A-P2) with today's open asks on its dwarfs, ids in the relay's namespace. */
  function facadeBoard(dwarfs: Array<Partial<Dwarf> & { id: string }>): void {
    useMines().setMines({
      mines: [defaultMine({ dwarfs: dwarfs.map((dwarf) => defaultDwarf(dwarf)) })],
      tokensObserved: 0
    })
  }

  beforeEach(() => {
    useDwarfQuestion().stopAsks()
    useDwarfQuestion().clearAll()
    useMines().stop()
    useMines().clear()
  })

  it('[ADR-033] Host asks come from the asks section and ask frames with a higher seq, legacy asks from the facade overlay, each keyed by its own id', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    facadeBoard([{ id: DWARF_B, pendingQuestion: question({ toolUseId: 'legacy:toolu_01' }) }])
    const store = useDwarfQuestion()

    expect(await store.startAsks()).toBe(true)
    fake.push([
      frame(9, 'ask.opened', { ask: hostAsk(ASK_STALE, DWARF_A) }),
      frame(11, 'ask.opened', { ask: hostAsk(ASK_B, DWARF_B, { openedAt: 2_000 }) })
    ])
    facadeBoard([{ id: DWARF_B, pendingQuestion: question({ toolUseId: 'legacy:toolu_02' }) }])

    expect(Object.keys(store.asks.host).sort()).toEqual([ASK_A, ASK_B])
    expect(Object.keys(store.asks.legacy)).toEqual(['legacy:toolu_02'])
    expect(store.asks.legacy['legacy:toolu_02']).toMatchObject({
      source: 'legacy',
      dwarfId: DWARF_B,
      kind: 'question'
    })
    expect(store.frontAsk(DWARF_A)).toMatchObject({ source: 'host', id: ASK_A })
  })

  it('[US-RES-003.AC02] after a reopen the card shows on its current step with no earlier pick selected', async () => {
    install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const store = useDwarfQuestion()
    await store.startAsks()
    store.pick(ASK_A, [{ step: 0, option: 'SQLite' }])
    store.stopAsks()

    // The window reopens: the Host kept the step, the UI session store (never persisted) holds no pick.
    install(() => page(20, [hostAsk(ASK_A, DWARF_A, { currentStep: 2 })]))
    await store.startAsks()

    expect(store.stepOf(ASK_A)).toBe(2)
    expect(store.picksFor(ASK_A)).toEqual([])
  })

  it('[US-ASK-001.AC07] going back to an answered step shows its pick from the UI session store', async () => {
    const fake = install(
      () => page(10, [hostAsk(ASK_A, DWARF_A, { currentStep: 1 })]),
      emptySession({ [ASK_A]: [{ step: 0, option: 'SQLite' }] } as UiSessionSnapshot['askPicks'])
    )
    const store = useDwarfQuestion()
    await store.startAsks()

    expect(store.picksFor(ASK_A)).toEqual([{ step: 0, option: 'SQLite' }])

    store.pick(ASK_A, [
      { step: 0, option: 'SQLite' },
      { step: 1, option: 'app' }
    ])
    expect(fake.patches).toEqual([
      {
        kind: 'ask-picks',
        askId: ASK_A,
        picks: [
          { step: 0, option: 'SQLite' },
          { step: 1, option: 'app' }
        ]
      }
    ])

    // Another window changed the picks: this one follows.
    fake.session({
      kind: 'ask-picks',
      askId: ASK_A as AskId,
      picks: [{ step: 0, option: 'Postgres' }],
      origin: 'valle'
    })
    expect(store.picksFor(ASK_A)).toEqual([{ step: 0, option: 'Postgres' }])
  })

  it('[US-ASK-006.AC06] an ask.closed frame lets the card give way to the composer with no notice', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const store = useDwarfQuestion()
    await store.startAsks()
    expect(store.frontAsk(DWARF_A)).toMatchObject({ id: ASK_A })

    fake.push([
      frame(11, 'ask.closed', {
        askId: ASK_A as AskId,
        dwarfId: DWARF_A as DwarfId,
        reason: 'answered-elsewhere'
      })
    ])

    expect(store.frontAsk(DWARF_A)).toBeUndefined()
    expect(store.stateFor(DWARF_A)).toBeUndefined()
    expect(useToasts().toasts.value).toEqual([])
  })

  it('[US-ASK-007.AC02] an ask.opened frame re-sent for the same askId after a refusal brings the card back with no alert', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const store = useDwarfQuestion()
    await store.startAsks()
    // The card's last verdict was a refusal of this ask, and the ask closed.
    store.state.byDwarfId[DWARF_A] = { phase: 'refused', toolUseId: ASK_A, error: 'refused' }
    fake.push([
      frame(11, 'ask.closed', {
        askId: ASK_A as AskId,
        dwarfId: DWARF_A as DwarfId,
        reason: 'cancelled'
      })
    ])

    fake.push([frame(12, 'ask.opened', { ask: hostAsk(ASK_A, DWARF_A, { reannounce: false }) })])

    expect(store.frontAsk(DWARF_A)).toMatchObject({ source: 'host', id: ASK_A })
    expect(store.stateFor(DWARF_A)).toBeUndefined()
    expect(useToasts().toasts.value).toEqual([])
  })

  it('[ADR-033] an ask.step frame above the seq moves the card to the step the Host reports', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const store = useDwarfQuestion()
    await store.startAsks()

    fake.push([frame(11, 'ask.step', { askId: ASK_A as AskId, currentStep: 1 })])
    fake.push([frame(11, 'ask.step', { askId: ASK_A as AskId, currentStep: 2 })])

    expect(store.stepOf(ASK_A)).toBe(1)
  })

  it('[US-MINE-003.AC03, US-ASK-006.AC02, INV-103] an ask.opened frame reaches the attention cues through askOpened once, a snapshot ask is no arrival, and reannounce false plays nothing', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const played: string[] = []
    // The cues subscribe first, so the fake's one A-N02 listener is the read model's once it starts.
    const stopCues = useAttentionCues().start({
      settings: ref({ ...DEFAULT_AUDIO_PREFERENCES, notificationSounds: true }),
      windowShown: ref(true),
      playSfx: (kind) => played.push(kind)
    })
    try {
      await useDwarfQuestion().startAsks()
      expect(played).toEqual([])

      const permissionAsk = hostAsk(ASK_B, DWARF_B, {
        kind: 'permission',
        payload: { toolName: 'Bash', requestText: 'npm test' }
      })
      fake.push([frame(11, 'ask.opened', { ask: permissionAsk })])
      fake.push([
        frame(12, 'ask.opened', { ask: hostAsk(ASK_STALE, DWARF_A, { reannounce: false }) })
      ])
      // Re-sent for the same askId: the same need, never a second cue.
      fake.push([frame(13, 'ask.opened', { ask: permissionAsk })])

      expect(played).toEqual(['permission'])
    } finally {
      stopCues()
    }
  })

  // AMENDED for ISSUE-141 (appended; lead decision 2026-10-14: ISSUE-138's answer half, folded into the cut-2 switch).
  // From the switch A-40/A-41 have their 14 shape, and main routes each answer by its AskId: a `legacy:` id through
  // `LegacyAnswerShapeAdapter` to today's runtime, any other to the Host's broker (routes.ts; the route per AskId is
  // proven by the L6 router case "in cut 2 A-40 and A-41 route host…"). The renderer's half: each card answers with its
  // own id, in the 14 shape, one UUIDv7 per submit.
  it('[ADR-001] an answer to a legacy: card goes through the legacy route and an answer to a Host card through the host route', async () => {
    const fake = install(() => page(10, [hostAsk(ASK_A, DWARF_A)]))
    const sent: Array<[string, unknown]> = []
    const answered = { ok: true, value: { kind: 'accepted' } }
    Object.assign(window.api, {
      answerDwarfQuestion: vi.fn((request: unknown) => {
        sent.push(['A-40', request])
        return Promise.resolve(answered)
      }),
      answerDwarfPermission: vi.fn((request: unknown) => {
        sent.push(['A-41', request])
        return Promise.resolve(answered)
      })
    })
    facadeBoard([{ id: DWARF_B, pendingPermission: permission({ toolUseId: 'legacy:toolu_09' }) }])
    const store = useDwarfQuestion()
    await store.startAsks()
    expect(fake.patches).toEqual([])

    const host = store.frontAsk(DWARF_A)
    const legacy = store.frontAsk(DWARF_B)
    expect(host).toMatchObject({ source: 'host', id: ASK_A })
    expect(legacy).toMatchObject({ source: 'legacy', id: 'legacy:toolu_09', kind: 'permission' })
    await store.answer(
      DWARF_A,
      question({
        toolUseId: ASK_A,
        questions: [
          {
            question: 'Which database?',
            multiSelect: false,
            options: [{ label: 'Postgres' }, { label: 'SQLite' }]
          }
        ]
      }),
      'SQLite'
    )
    await store.decide(DWARF_B, permission({ toolUseId: 'legacy:toolu_09' }), 'allow')

    const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(sent).toEqual([
      [
        'A-40',
        {
          askId: ASK_A,
          answers: [{ step: 0, option: 'SQLite' }],
          requestId: expect.stringMatching(UUID_V7)
        }
      ],
      [
        'A-41',
        { askId: 'legacy:toolu_09', decision: 'allow', requestId: expect.stringMatching(UUID_V7) }
      ]
    ])
    expect(store.stateFor(DWARF_A)).toEqual({ phase: 'answered', toolUseId: ASK_A })
    expect(store.stateFor(DWARF_B)).toEqual({
      phase: 'answered',
      toolUseId: 'legacy:toolu_09',
      decision: 'allow'
    })
  })

  it('[US-ASK-006.AC09] a not-open outcome renders nothing and leaves the card state as the Host reports it', async () => {
    install(() =>
      page(10, [
        hostAsk(ASK_A, DWARF_A, {
          kind: 'permission',
          payload: { toolName: 'Bash', requestText: 'npm test' }
        })
      ])
    )
    Object.assign(window.api, {
      answerDwarfPermission: vi.fn(() => Promise.resolve({ ok: true, value: { kind: 'not-open' } }))
    })
    const store = useDwarfQuestion()
    await store.startAsks()

    await store.decide(DWARF_A, permission({ toolUseId: ASK_A }), 'allow')

    // No verdict, no alert, no toast: the stale submit is dropped silently, and the card is the Host's to close.
    expect(store.stateFor(DWARF_A)).toBeUndefined()
    expect(store.frontAsk(DWARF_A)).toMatchObject({ source: 'host', id: ASK_A })
    expect(useToasts().toasts.value).toEqual([])
  })

  // ADDED for ISSUE-141 (lead decision 2026-10-14): the "Answers:" record drawn at Submit is withdrawn on a not-open
  // outcome, so the conversation shows no ✕ and the dwarf's marker no verdict for an answer that was never handed over.
  it('[US-ASK-006.AC09] a not-open outcome withdraws the "Answers:" record and the marker it took', async () => {
    install(() =>
      page(10, [
        hostAsk(ASK_A, DWARF_A, {
          kind: 'permission',
          payload: { toolName: 'Bash', requestText: 'npm test' }
        })
      ])
    )
    Object.assign(window.api, {
      answerDwarfPermission: vi.fn(() => Promise.resolve({ ok: true, value: { kind: 'not-open' } }))
    })
    useDwarfMessaging().clearAll()
    const store = useDwarfQuestion()
    await store.startAsks()

    await store.decide(DWARF_A, permission({ toolUseId: ASK_A }), 'allow')

    expect(useDwarfMessaging().echoesFor(DWARF_A)).toEqual([])
    expect(useDwarfMessaging().stateFor(DWARF_A)).toBeUndefined()
  })
})
/* --- end of the dual-source ask read model block --------------------------------------------- */
