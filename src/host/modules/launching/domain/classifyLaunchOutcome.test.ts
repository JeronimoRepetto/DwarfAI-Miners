import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import {
  classifyLaunchOutcome,
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  type LaunchOutcomeEvent
} from './classifyLaunchOutcome'

const T0 = 50_000

describe('classifyLaunchOutcome (ADR-020 item 4)', () => {
  it('[US-LAUNCH-006.AC02, S5.16] ENOENT at spawn or a negative detect is not-installed', () => {
    const clock = new FakeClock(1_000)

    expect(
      classifyLaunchOutcome([{ kind: 'spawn-error', code: 'ENOENT' }], null, clock.now())
    ).toEqual({
      kind: 'failed',
      cause: 'not-installed'
    })
    expect(classifyLaunchOutcome([{ kind: 'detect-negative' }], null, clock.now())).toEqual({
      kind: 'failed',
      cause: 'not-installed'
    })
  })

  it('[US-LAUNCH-006.AC03, NFR-TIM-06, S5.20, FM-056] an exit or error at 2 999 ms is exited-at-once and at 3 000 ms after readiness it is not', () => {
    const clock = new FakeClock(T0)
    const ready: LaunchOutcomeEvent = { kind: 'ready', at: T0 + 1_000 }
    clock.advance(EARLY_FAILURE_WINDOW_MS - 1)

    for (const how of ['exit', 'error'] as const) {
      const early: LaunchOutcomeEvent[] = [ready, { kind: 'ended', at: clock.now(), how }]
      expect(classifyLaunchOutcome(early, T0, clock.now())).toEqual({
        kind: 'failed',
        cause: 'exited-at-once'
      })
      // without readiness, the same instant is still inside the window
      expect(
        classifyLaunchOutcome([{ kind: 'ended', at: clock.now(), how }], T0, clock.now())
      ).toEqual({
        kind: 'failed',
        cause: 'exited-at-once'
      })
    }

    clock.advance(1) // t0 + 3 000 ms
    for (const how of ['exit', 'error'] as const) {
      const atWindow: LaunchOutcomeEvent[] = [ready, { kind: 'ended', at: clock.now(), how }]
      expect(classifyLaunchOutcome(atWindow, T0, clock.now())).toEqual({ kind: 'succeeded' })
    }
  })

  it('[US-LAUNCH-006.AC14, S5.17, S5.19, FM-057] EACCES, EPERM, EINVAL, a refused shim, a parser refusal and a 30 s handshake timeout are could-not-start', () => {
    const clock = new FakeClock(T0)
    const preSpawn: LaunchOutcomeEvent[][] = [
      [{ kind: 'spawn-error', code: 'EACCES' }],
      [{ kind: 'spawn-error', code: 'EPERM' }],
      [{ kind: 'spawn-error', code: 'EINVAL' }],
      [{ kind: 'shim-refused' }],
      [{ kind: 'parser-refused' }]
    ]
    for (const events of preSpawn) {
      expect(classifyLaunchOutcome(events, null, clock.now())).toEqual({
        kind: 'failed',
        cause: 'could-not-start'
      })
    }

    clock.advance(HANDSHAKE_TIMEOUT_MS - 1)
    expect(classifyLaunchOutcome([], T0, clock.now())).toEqual({ kind: 'pending' })
    clock.advance(1)
    expect(classifyLaunchOutcome([], T0, clock.now())).toEqual({
      kind: 'failed',
      cause: 'could-not-start'
    })
  })

  it('[S5.19] an exit after the window with no readiness is could-not-start, the handshake never completed', () => {
    const clock = new FakeClock(T0)
    clock.advance(EARLY_FAILURE_WINDOW_MS + 200)

    expect(
      classifyLaunchOutcome([{ kind: 'ended', at: clock.now(), how: 'exit' }], T0, clock.now())
    ).toEqual({ kind: 'failed', cause: 'could-not-start' })
  })

  it('[S5.21] readiness plus the first agent event before 3 s succeeds without waiting for the window', () => {
    const clock = new FakeClock(T0)
    clock.advance(800)
    const events: LaunchOutcomeEvent[] = [
      { kind: 'ready', at: T0 + 500 },
      { kind: 'first-agent-event', at: clock.now() }
    ]

    expect(classifyLaunchOutcome(events, T0, clock.now())).toEqual({ kind: 'succeeded' })
    // readiness alone still waits for the window
    expect(classifyLaunchOutcome([events[0]!], T0, clock.now())).toEqual({ kind: 'pending' })
  })
})
