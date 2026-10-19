// The WelcomeAnswerStore double (16 §4.12 `InMemory*`). Never imported by production code (R14).
//
// It keeps the SQLite adapter's rules, held equal by the shared runWelcomeAnswerStoreContract: null
// until answered, the last instant stored wins. It has no transaction of its own: a test's
// transaction rolls it back with `snapshot` / `restore`, and `restore(null)` is what the Reset `db`
// step does to the column (07 S41.07).
import type { Instant } from '../../../../kernel/domain/values'
import type { WelcomeAnswerStore } from '../welcomeAnswerStore'

export class InMemoryWelcomeAnswerStore implements WelcomeAnswerStore {
  private value: Instant | null = null

  answeredAt(): Instant | null {
    return this.value
  }

  setAnsweredAt(t: Instant): void {
    if (!Number.isInteger(t) || t < 0) throw new Error('an answer instant is >= 0 (09 app_meta)')
    this.value = t
  }

  snapshot(): Instant | null {
    return this.value
  }

  restore(value: Instant | null): void {
    this.value = value
  }
}
