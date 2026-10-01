// The Host kernel's public surface (05 §2.1): value types, the event envelope, the kernel driven
// ports, InProcessEventBus and the poll profiler. Never the fakes or the contract suites (R14).
export type { EventId, HostEpoch, Instant, Result } from './domain/values'
export type { DomainEvent } from './domain/domainEvent'
export { HostInvariantError } from './domain/errors'
export type { AppPaths } from './ports/appPaths'
export type { Clock } from './ports/clock'
export type { DomainEventBus } from './ports/domainEventBus'
export type { IdGenerator } from './ports/idGenerator'
export type {
  LifecycleDepartureCause,
  LifecycleFact,
  LifecycleFactLog,
  LifecycleFactType
} from './ports/lifecycleFactLog'
export type { Scheduler } from './ports/scheduler'
export type { TransactionScope } from './ports/transactionScope'
export {
  InProcessEventBus,
  type HandlerFailure,
  type InProcessEventBusDeps
} from './InProcessEventBus'
export {
  PollProfiler,
  formatPollSample,
  perfLoggingEnabled,
  type PollProfilerOptions,
  type PollSample
} from './perf/perf'
export type { DirEntry, FileStat, FileSystem, FsError, SizedDirEntry } from './ports/fileSystem'
export { SqliteInfrastructureError } from './domain/errors'
export type {
  SqliteDatabase,
  SqliteParam,
  SqliteReader,
  SqliteRow,
  SqliteRunResult
} from './ports/sqliteDatabase'
export type { TransactionRunner } from './ports/transactionRunner'
export type { DiagnosticEntry, DiagnosticsLog } from './ports/diagnosticsLog'
