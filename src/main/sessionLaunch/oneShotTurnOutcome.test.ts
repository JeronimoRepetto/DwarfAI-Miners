import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS } from '../domain/types'
import { ERRORED_DETAIL_MAX_CHARS, oneShotTurnOutcome } from './oneShotTurnOutcome'

/**
 * `oneShotTurnOutcome` (#510) is the detached-launch twin of
 * `claudeTurnOutcome.ts`'s `resultTurnOutcome`: pure, and proven here without
 * ever spawning a real process — `launchRunner.test.ts` proves the file
 * capture and read-back around it instead (see `TurnOutcomeWatch`).
 */

const NOW = 1_726_000_000_000

function result(overrides: {
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdoutTail?: string
  stderrTail?: string
}) {
  return {
    // `?? 0` would wrongly turn an explicit `exitCode: null` back into 0 —
    // `null` is itself a meaningful case here (a signal-terminated or
    // unexplained exit), so only a truly OMITTED field defaults.
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: overrides.signal === undefined ? null : overrides.signal,
    stdoutTail: overrides.stdoutTail ?? '',
    stderrTail: overrides.stderrTail ?? '',
    now: NOW
  }
}

describe('oneShotTurnOutcome (#510)', () => {
  it('reads a clean exit with stdout as a concluded turn, text trimmed', () => {
    expect(
      oneShotTurnOutcome(result({ exitCode: 0, stdoutTail: '  the build is green\n' }))
    ).toEqual({ kind: 'concluded', text: 'the build is green', endedAt: NOW })
  })

  it('reads a clean exit with no stdout as a concluded turn carrying no text', () => {
    expect(oneShotTurnOutcome(result({ exitCode: 0, stdoutTail: '' }))).toEqual({
      kind: 'concluded',
      endedAt: NOW
    })
  })

  it('reads a clean exit whose stdout is only whitespace as carrying no text either', () => {
    expect(oneShotTurnOutcome(result({ exitCode: 0, stdoutTail: '\n  \n' }))).toEqual({
      kind: 'concluded',
      endedAt: NOW
    })
  })

  it('bounds a concluded turn´s text to MAX_DWARF_TEXT_CHARS, flagging the cut', () => {
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 10)
    const outcome = oneShotTurnOutcome(result({ exitCode: 0, stdoutTail: long }))
    expect(outcome.kind).toBe('concluded')
    expect(outcome.text).toHaveLength(MAX_DWARF_TEXT_CHARS)
    expect(outcome.truncated).toBe(true)
  })

  it('reads a non-zero exit as errored, naming the code and a stderr tail', () => {
    expect(
      oneShotTurnOutcome(
        result({ exitCode: 1, stdoutTail: 'ignored', stderrTail: 'auth token expired' })
      )
    ).toEqual({ kind: 'errored', detail: 'exit 1: auth token expired', endedAt: NOW })
  })

  it('keeps an errored detail short: the stderr tail is cut to ERRORED_DETAIL_MAX_CHARS with a marker', () => {
    // The runner hands over up to STDERR_TAIL_BYTES of stderr; `detail` is a
    // one-line word for what happened (the panel draws it in parentheses),
    // not a log viewer — so the tail is cut, and the cut is marked rather
    // than hidden.
    const noisy = 'e'.repeat(ERRORED_DETAIL_MAX_CHARS + 500)
    const outcome = oneShotTurnOutcome(result({ exitCode: 2, stderrTail: noisy }))
    expect(outcome.kind).toBe('errored')
    expect(outcome.detail?.startsWith('exit 2: ')).toBe(true)
    expect(outcome.detail?.endsWith('…')).toBe(true)
    expect(outcome.detail?.length).toBe('exit 2: '.length + ERRORED_DETAIL_MAX_CHARS + 1)
  })

  it('reads a non-zero exit with no stderr as errored, naming only the code', () => {
    expect(oneShotTurnOutcome(result({ exitCode: 1, stderrTail: '' }))).toEqual({
      kind: 'errored',
      detail: 'exit 1',
      endedAt: NOW
    })
  })

  it('reads a null exit code with no signal as errored rather than a silent conclusion', () => {
    // Node's own contract is that one of code/signal is always set on 'exit';
    // this is the defensive branch for the shape TypeScript still allows.
    expect(oneShotTurnOutcome(result({ exitCode: null, signal: null }))).toEqual({
      kind: 'errored',
      detail: 'exit unknown',
      endedAt: NOW
    })
  })

  it('reads a signal-terminated exit as interrupted, the signal as its detail', () => {
    expect(
      oneShotTurnOutcome(result({ exitCode: null, signal: 'SIGTERM', stdoutTail: 'partial work' }))
    ).toEqual({ kind: 'interrupted', detail: 'SIGTERM', endedAt: NOW })
  })

  it('never reads a one-shot exit as capped — that kind is the held path´s own', () => {
    // capped only ever comes from an SDK-reported turn/budget cap (#510,
    // claudeTurnOutcome.ts); a bare exit status has no such signal to read.
    const outcomes = [
      oneShotTurnOutcome(result({ exitCode: 0 })),
      oneShotTurnOutcome(result({ exitCode: 1 })),
      oneShotTurnOutcome(result({ signal: 'SIGINT' }))
    ]
    for (const outcome of outcomes) expect(outcome.kind).not.toBe('capped')
  })
})
