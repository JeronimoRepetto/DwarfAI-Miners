// The probe the event bus uses for its in-transaction assertion (16 §2.3). Implemented by the
// SQLite transaction runner; until it exists the composition root passes an always-false scope.
export interface TransactionScope {
  isInTransaction(): boolean
}
