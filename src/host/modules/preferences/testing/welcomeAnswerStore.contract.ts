// The WelcomeAnswerStore conformance suite (16 §4.12 row `WelcomeAnswerStore`; 09 D-25; 17 §1.3):
// run on the in-memory double and on the SQLite adapter over the template database (schema v1).
// `answeredAt` is null on a fresh database (the first-run step is due, 07 S41.01); `setAnsweredAt`
// stores the instant (S41.05) and the same instant twice is one value; the store joins the
// caller's transaction, so a rollback leaves it unanswered; a cleared answer (the Reset `db` step,
// S41.07) reads null again. Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { Instant } from '../../../kernel/domain/values'
import type { WelcomeAnswerStore } from '../ports/welcomeAnswerStore'

export interface WelcomeAnswerStoreSubject {
  store: WelcomeAnswerStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** What the Reset `db` step does to the answer (S13.01 → S41.07). */
  clearAsReset(): void
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0: Instant = 1_750_000_000_000
const T1: Instant = T0 + 60_000

export function runWelcomeAnswerStoreContract(
  makeSubject: () => WelcomeAnswerStoreSubject | Promise<WelcomeAnswerStoreSubject>
): void {
  describe('WelcomeAnswerStore contract', () => {
    let subject: WelcomeAnswerStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<WelcomeAnswerStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    it('[S41.01, S41.05] a fresh store is unanswered, and setAnsweredAt stores the instant; the same instant twice is one value', async () => {
      const s = await setUp()
      expect(s.store.answeredAt()).toBeNull()

      s.inTransaction(() => s.store.setAnsweredAt(T0))
      expect(s.store.answeredAt()).toBe(T0)

      s.inTransaction(() => s.store.setAnsweredAt(T0))
      expect(s.store.answeredAt()).toBe(T0)

      s.inTransaction(() => s.store.setAnsweredAt(T1))
      expect(s.store.answeredAt()).toBe(T1)
    })

    it('[S41.05] a rolled-back caller transaction keeps the answer it found', async () => {
      const s = await setUp()
      s.inTransaction(() => s.store.setAnsweredAt(T0))
      expect(() =>
        s.inTransaction(() => {
          s.store.setAnsweredAt(T1)
          throw new CallerFailure('the caller failed after the answer')
        })
      ).toThrow(CallerFailure)
      expect(s.store.answeredAt()).toBe(T0)
    })

    it('[US-SET-012.AC05, S41.07] after the Reset db step cleared it the step reads unanswered again', async () => {
      const s = await setUp()
      s.inTransaction(() => s.store.setAnsweredAt(T0))
      expect(s.store.answeredAt()).toBe(T0)
      s.clearAsReset()
      expect(s.store.answeredAt()).toBeNull()
    })
  })
}
