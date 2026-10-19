// The one way the Host writes (16 §2.2, §3 `TransactionRunner`): `work` runs synchronously inside
// `BEGIN IMMEDIATE … COMMIT` and is rolled back when it throws; a call made while a transaction is
// open joins it (no savepoint); a `work` that returns a promise is a programming error
// (`HostInvariantError`, thrown before anything is committed).
export interface TransactionRunner {
  inTransaction<T>(work: () => T): T // node:sqlite is synchronous
}
