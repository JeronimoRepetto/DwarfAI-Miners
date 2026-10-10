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
import { useDwarfMessaging } from './useDwarfMessaging'
import { useDwarfQuestion } from './useDwarfQuestion'
import { useMines } from './useMines'
import { useToasts } from './useToasts'

function stubApi(
  answerDwarfQuestion: (request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { answerDwarfQuestion }
  })
}

/** Same shape as stubApi, for the permission channel `decide` sends over. */
function stubPermissionApi(
  answerDwarfPermission: (
    request: DwarfPermissionAnswerRequest
  ) => Promise<DwarfQuestionAnswerResult>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { answerDwarfQuestion: vi.fn(), answerDwarfPermission }
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
    expect(sent).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database should the importer write to?': 'SQLite' }
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
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: 'That session is not one this panel is holding.'
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
    expect(sent).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'put it in Redis'
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
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: 'There was nothing written to send.'
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
    expect(sent).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database?': 'Postgres', 'Which regions?': 'West' }
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
    expect(sent).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_09',
      decision: 'deny'
    })
  })

  it('keeps main’s refusal and its reason so the panel can explain itself', async () => {
    stubPermissionApi(() =>
      Promise.resolve({ answered: false, error: 'That prompt is no longer open.' })
    )
    const { decide, stateFor } = useDwarfQuestion()

    await decide('claude:s1', permission(), 'allow')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'refused',
      toolUseId: 'toolu_09',
      decision: 'allow',
      error: 'That prompt is no longer open.'
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        answerDwarfQuestion: vi.fn().mockResolvedValue({ answered: true }),
        answerDwarfPermission: vi.fn().mockResolvedValue({ answered: true })
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        answerDwarfQuestion: vi.fn().mockResolvedValue({ answered: true }),
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

  function stub(result: () => Promise<DwarfQuestionAnswerResult>) {
    const answerDwarfQuestion = vi.fn(result)
    const answerDwarfPermission = vi.fn(result)
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

    expect(useDwarfMessaging().echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'failed',
      error: 'That ask is no longer open.'
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
        answerDwarfQuestion: vi.fn(() =>
          Promise.resolve(answered ? { answered: true } : { answered: false, error: 'nope' })
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
      value: { answerDwarfQuestion: vi.fn(() => Promise.resolve({ answered: true })) }
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
})
/* --- end of the dual-source ask read model block --------------------------------------------- */
