// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DwarfQuestion, DwarfQuestionAnswerRequest, DwarfQuestionAnswerResult } from '../types'
import { useDwarfQuestion } from './useDwarfQuestion'

function stubApi(
  answerDwarfQuestion: (request: DwarfQuestionAnswerRequest) => Promise<DwarfQuestionAnswerResult>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { answerDwarfQuestion }
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
