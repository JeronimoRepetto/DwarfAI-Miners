import { describe, expect, it } from 'vitest'
import { decideBind, type BindAttempt, type BindDecision } from './singleInstance'

// L1 (17 §1.1): the ADR-002 D3 single-instance table, pure. The endpoint of ISSUE-022 feeds it the
// outcome of each bind attempt and follows the decision.
describe('decideBind (ADR-002 D3)', () => {
  it('[S12.02, FM-009] an endpoint in use whose Host answers hello exits ALREADY_RUNNING', () => {
    const rows: ReadonlyArray<[BindAttempt, BindDecision]> = [
      [{ outcome: 'bound', retried: false }, { kind: 'continue' }],
      [{ outcome: 'bound', retried: true }, { kind: 'continue' }],
      [
        { outcome: 'in-use', existing: 'answers-hello', retried: false },
        { kind: 'exit', refusal: 'ALREADY_RUNNING' }
      ],
      // A Host that took the endpoint between the stale-file removal and the retry is still the one
      // Host of this user: D3's own rule, not a failure.
      [
        { outcome: 'in-use', existing: 'answers-hello', retried: true },
        { kind: 'exit', refusal: 'ALREADY_RUNNING' }
      ]
    ]
    for (const [attempt, decision] of rows) {
      expect(decideBind(attempt), JSON.stringify(attempt)).toEqual(decision)
    }
  })

  it('[FM-037] a stale POSIX socket is removed once and the bind retried; a second failure is an error', () => {
    const rows: ReadonlyArray<[BindAttempt, BindDecision]> = [
      [
        { outcome: 'in-use', existing: 'stale-socket', retried: false },
        { kind: 'remove-stale-and-retry' }
      ],
      [
        { outcome: 'in-use', existing: 'stale-socket', retried: true },
        { kind: 'error', cause: 'stale-socket-again' }
      ],
      // In use by something that never answers hello: not this user's Host, never removed.
      [
        { outcome: 'in-use', existing: 'no-hello', retried: false },
        { kind: 'error', cause: 'in-use-without-hello' }
      ],
      [
        { outcome: 'in-use', existing: 'no-hello', retried: true },
        { kind: 'error', cause: 'in-use-without-hello' }
      ],
      // Any other bind failure (permissions, a path over the sun_path limit) fails fast.
      [
        { outcome: 'failed', errCode: 'EACCES', retried: false },
        { kind: 'error', cause: 'bind-failed', errCode: 'EACCES' }
      ],
      [
        { outcome: 'failed', errCode: 'EACCES', retried: true },
        { kind: 'error', cause: 'bind-failed', errCode: 'EACCES' }
      ]
    ]
    for (const [attempt, decision] of rows) {
      expect(decideBind(attempt), JSON.stringify(attempt)).toEqual(decision)
    }
  })
})
