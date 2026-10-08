// Driven port (05 §3.12, 16 §4.12; AMENDMENT-10, OQ-78): the one reader and writer of
// `app_meta.welcome_answered_at` (09 D-25), the persisted part of the first-run consent step (07
// machine 41). `answeredAt()` is null until the step is answered; `setAnsweredAt` is called only by
// `answerWelcome` (later: ISSUE-223); the Reset `db` step clears the column with the epoch bump
// (SqliteResetJournal, ISSUE-212). Read and written inside the caller's transaction (16 §2.2).
import type { Instant } from '../../../kernel/domain/values'

// As 16 §4.12 writes it (names, members and comment; layout by prettier)
export interface WelcomeAnswerStore {
  answeredAt(): Instant | null
  setAnsweredAt(t: Instant): void
} // app_meta.welcome_answered_at (09 D-25), inside the caller's transaction; cleared by the Reset db step with the epoch bump (AMENDMENT-10, OQ-78)
