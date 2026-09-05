// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DwarfPermissionAnswerRequest,
  DwarfPermissionRequest,
  DwarfQuestion,
  DwarfQuestionAnswerRequest,
  DwarfQuestionAnswerResult
} from '../types'
import { useDwarfQuestion } from './useDwarfQuestion'

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

function question(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
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
