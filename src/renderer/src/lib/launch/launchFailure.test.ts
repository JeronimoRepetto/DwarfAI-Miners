import { describe, expect, it } from 'vitest'
import type { JevFallbackReason } from '../../types'
import { OTHER_CHOICE, jevFailureOf, type LaunchFailure } from './launchState'
import { jevFallbackReasonWords, launchFailureNotice } from './launchFailure'

/*
 * The Add panel's launch-failure notice (#635; decision log, Five launch-failure causes, MESSAGE-
 * QUESTIONS 14/16/17): what each cause says, and which of Retry and Pick manually it offers.
 */
describe('launchFailureNotice', () => {
  it('names a supplier that is not installed, with Retry alone', () => {
    const notice = launchFailureNotice({ cause: 'not-installed', choice: 'claude' })

    expect(notice.title).toBe('Claude is not installed')
    expect(notice.text).toBe(
      'Its command-line tool was not found on this computer. Install it, then retry.'
    )
    expect(notice.retry).toBe(true)
    expect(notice.pickManually).toBe(false)
  })

  it('names a supplier that stopped as soon as it started, with Retry alone', () => {
    const notice = launchFailureNotice({ cause: 'exited-at-once', choice: 'codex' })

    expect(notice.title).toBe('Codex stopped as soon as it started')
    expect(notice.text).toBe(
      'The command ran and exited at once. Run it once in a terminal to see why, then retry.'
    )
    expect(notice.retry).toBe(true)
    expect(notice.pickManually).toBe(false)
  })

  it('names a supplier that could not be started, with Retry alone', () => {
    const notice = launchFailureNotice({ cause: 'could-not-start', choice: 'codex' })

    expect(notice.title).toBe('Codex could not be started')
    expect(notice.text).toBe(
      'Its command was found but would not start. Run it once in a terminal to see why, then retry.'
    )
    expect(notice.retry).toBe(true)
    expect(notice.pickManually).toBe(false)
  })

  it('calls a command of the person’s own "The custom command" (screens/launch.md)', () => {
    expect(launchFailureNotice({ cause: 'could-not-start', choice: OTHER_CHOICE }).title).toBe(
      'The custom command could not be started'
    )
  })

  it('calls no supplier at all "The supplier"', () => {
    expect(launchFailureNotice({ cause: 'not-installed', choice: null }).title).toBe(
      'The supplier is not installed'
    )
  })

  it('offers Retry and Pick manually when Jev could not be reached', () => {
    const notice = launchFailureNotice({ cause: 'jev-unreachable' })

    expect(notice.title).toBe('Jev could not be reached')
    expect(notice.text).toBe('Retry, or pick the supplier and model yourself.')
    expect(notice.retry).toBe(true)
    expect(notice.pickManually).toBe(true)
  })

  it('opens "Jev could not choose" with the app’s reason, and offers Pick manually alone', () => {
    const notice = launchFailureNotice({ cause: 'jev-could-not-choose', reason: 'no-key' })

    expect(notice.title).toBe('Jev could not choose')
    expect(notice.text).toBe('No TypeSafe key is set. Pick the supplier and model yourself.')
    expect(notice.retry).toBe(false)
    expect(notice.pickManually).toBe(true)
  })

  it('carries low confidence’s figure, as the app words it', () => {
    const notice = launchFailureNotice({
      cause: 'jev-could-not-choose',
      reason: 'low-confidence',
      confidence: 0.41
    })

    expect(notice.text).toBe(
      'Jev was not confident enough (41%). Pick the supplier and model yourself.'
    )
  })

  it('says the reason alone, with no action, when there is no launchable provider to pick', () => {
    const notice = launchFailureNotice({
      cause: 'jev-could-not-choose',
      reason: 'no-launchable-provider'
    })

    expect(notice.title).toBe('Jev could not choose')
    expect(notice.text).toBe('No launchable provider to choose from.')
    expect(notice.retry).toBe(false)
    expect(notice.pickManually).toBe(false)
  })

  it('words every reason a retry cannot change as the design lists it', () => {
    const texts = (['unauthorized', 'budget-exceeded'] as const).map(
      (reason) => launchFailureNotice({ cause: 'jev-could-not-choose', reason }).text
    )

    expect(texts).toEqual([
      'TypeSafe rejected the API key. Pick the supplier and model yourself.',
      "The prompt and catalogue do not fit Jev's request budget. Pick the supplier and model yourself."
    ])
  })
})

describe('jevFailureOf', () => {
  /*
   * A retry can change a service that gave no usable answer; it cannot change a missing key, a
   * refused one, an empty catalogue, a budget or a low confidence (decision log, Jev cause of a
   * failed launch).
   */
  it.each<[JevFallbackReason, LaunchFailure['cause']]>([
    ['unreachable', 'jev-unreachable'],
    ['timeout', 'jev-unreachable'],
    ['rate-limited', 'jev-unreachable'],
    ['invalid-response', 'jev-unreachable'],
    ['no-key', 'jev-could-not-choose'],
    ['unauthorized', 'jev-could-not-choose'],
    ['no-launchable-provider', 'jev-could-not-choose'],
    ['budget-exceeded', 'jev-could-not-choose'],
    ['low-confidence', 'jev-could-not-choose']
  ])('reads %s as %s', (reason, cause) => {
    expect(jevFailureOf(reason).cause).toBe(cause)
  })

  it('keeps the reason and its figure for "Jev could not choose"', () => {
    expect(jevFailureOf('low-confidence', 0.41)).toEqual({
      cause: 'jev-could-not-choose',
      reason: 'low-confidence',
      confidence: 0.41
    })
  })
})

describe('jevFallbackReasonWords', () => {
  it('keeps the Jev fallback line’s own words for each reason (#509)', () => {
    expect(jevFallbackReasonWords('timeout')).toBe('Jev took too long')
    expect(jevFallbackReasonWords('low-confidence', 0.412)).toBe(
      'Jev was not confident enough (41%)'
    )
    expect(jevFallbackReasonWords('low-confidence')).toBe('Jev was not confident enough')
  })
})
