// The HelloProber contract (17 §1.3, 16 §2.8; ports.ts `HelloProber`, `HelloAnswer`; ADR-002 D4 item 1, ADR-003 item
// 5): one suite run by the double and by the real prober over an in-process connection (the real pipe or socket is
// the OS lane's, detach.os.test.ts). One attempt answers what the endpoint did: nothing listening is `unreachable`; a
// Host's `hello.ok` is `hello-ok` with its state and job status; a Host's protocol `error` frame is `refused` with
// its code; something that accepts the connection and sends no answer within the hello bound is `no-answer`.
import { describe, expect, it } from 'vitest'
import type { HelloOk, ProtocolErrorCode } from '@dwarfai/contracts'
import type { HelloProber } from '../ports'

/** What the endpoint does with one attempt. */
export type EndpointScript =
  | { kind: 'nothing-listens' }
  | { kind: 'hello-ok'; state: HelloOk['state']; jobStatus: HelloOk['jobStatus'] }
  | { kind: 'error-frame'; code: ProtocolErrorCode }
  | { kind: 'silent' }

export interface HelloProberSubject {
  probe: HelloProber
  /** Lets the hello bound pass while an attempt waits (the real prober's timer; nothing for the double). */
  passAnswerBound(): void
}

export function runHelloProberContract(
  name: string,
  make: (endpoint: EndpointScript) => HelloProberSubject
): void {
  describe(`${name} meets the HelloProber contract (ADR-002 D4)`, () => {
    it('[ADR-002] an endpoint where nothing listens is unreachable', async () => {
      const { probe } = make({ kind: 'nothing-listens' })

      expect(await probe()).toEqual({ kind: 'unreachable' })
    })

    it('[ADR-002, S12.05] a Host that answers hello.ok is hello-ok with its state and job status', async () => {
      const { probe } = make({ kind: 'hello-ok', state: 'migrating', jobStatus: 'in-job' })

      expect(await probe()).toEqual({ kind: 'hello-ok', state: 'migrating', jobStatus: 'in-job' })
    })

    it('[ADR-002, FM-009] a Host that answers a protocol error frame is refused with its code', async () => {
      const { probe } = make({ kind: 'error-frame', code: 'AUTH_FAILED' })

      expect(await probe()).toEqual({ kind: 'refused', code: 'AUTH_FAILED' })
    })

    it('[ADR-002, FM-009] an endpoint that accepts and never answers is no-answer once the hello bound passed', async () => {
      const subject = make({ kind: 'silent' })

      const attempt = subject.probe()
      await Promise.resolve()
      subject.passAnswerBound()

      expect(await attempt).toEqual({ kind: 'no-answer' })
    })
  })
}
