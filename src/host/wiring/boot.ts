// The Host boot (16 §8.2, ADR-015 item 3, 05 §2.3; 07 machine 12A): composition code, not a module.
//
// Before any step:
//   1. `host.start`;
//   2. refuse an elevated start, or one whose elevation cannot be read, with ELEVATED_REFUSED
//      (ADR-002 D6, S12.03) — before anything is bound;
//   3. record the Windows job status (ADR-002 D6, FM-012): `in-job` is degraded and still boots;
//   4. refuse to start without DWARFAI_HOST_DATA_DIR with NO_DATA_DIR (ADR-002 D2).
// Then the named steps run in the order given (bootSteps.ts keeps the 16 §8.2 order). The state
// reported to the HostStateSink follows 12A: `starting` once the endpoint step is done (S12.04),
// `migrating` while a step says so and back to `starting` when that step ends (S12.05), `ready`
// after the last step (S12.06) — so nothing a step does (classification included) runs after
// `ready`. A step that throws stops the boot: logged `error`, exit non-zero (FM-008; the UI sees
// `spawn-failed`). A bind step that finds a running Host ends the boot with ALREADY_RUNNING
// (S12.02).
//
// No step and nothing here arms a timer to end the Host: it never exits on its own (ADR-002 D7,
// OQ-63; AMENDMENT-5). `exit` is called only for a refusal or a failed boot.
import type { HelloOk } from '@dwarfai/contracts'
import type { Result } from '../kernel/domain/values'
import type { AppPaths } from '../kernel/ports/appPaths'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { EnvAppPathsRefusal } from '../platform/paths/EnvAppPaths'
import type { PrivilegeCheck, PrivilegeReport } from '../platform/process/privilege'
import type { HostRuntime } from '../platform/process/runtimeFacts'
import { BOOT_FAILED_EXIT_CODE, EXIT_CODES, type HostRefusal } from './exitCodes'

/** The steps of 16 §8.2, in their order. */
export const BOOT_STEP_NAMES = [
  'bind-endpoint', // 1. bind the UI endpoint: the single-instance mutex (ADR-002 D3)
  'open-db-and-migrate', // 2. open the DB and migrate (ADR-005)
  'resume-reset-saga', // 3. resume an unfinished Reset saga (ADR-023)
  'construct-modules', // 4. construct modules, wire bridges and event routes (05 §4)
  'recover-sessions', // 5. launching.recoverAfterHostStart()
  'start-endpoints', // 6. MCP endpoint and hook ingress
  'start-observation', // 7. observation.catchUp() then start()
  'answer-ready' // 8. answer hello with ready
] as const

export type BootStepName = (typeof BOOT_STEP_NAMES)[number]

/**
 * The Host's lifecycle state and job status, as `hello.ok` and `host.state` carry them. The boot
 * reports `starting`, `migrating` and `ready` only; `upgrade-pending` is the upgrade handshake's
 * (S12.13, transport/lifecycle/drain.ts).
 */
export interface HostStateReport {
  state: HelloOk['state']
  jobStatus: HelloOk['jobStatus']
}

/** Where the boot reports each lifecycle change (transport/lifecycle/hostState.ts). */
export interface HostStateSink {
  report(report: HostStateReport): void
}

/** What a running step may tell the boot. */
export interface BootStepContext {
  /** A migration started (S12.05); the boot returns to `starting` when the step ends. */
  reportMigrating(): void
}

export type BootStepResult =
  | { kind: 'done' }
  /** A placeholder: the step is built by `owner`, a later issue. */
  | { kind: 'skipped'; owner: string }
  /** The endpoint is held by a running Host that answered `hello` (S12.02). */
  | { kind: 'refused'; refusal: 'ALREADY_RUNNING' }

export interface BootStep {
  readonly name: BootStepName
  run(context: BootStepContext): Promise<BootStepResult>
}

export interface BootDeps {
  log: DiagnosticsLog
  clock: Clock
  state: HostStateSink
  /** The Host's elevation and job facts (host/platform/process/privilege.ts). */
  privilege: PrivilegeCheck
  /** `EnvAppPaths.create` of the Host's own process: the data directory or why there is none. */
  paths: Result<AppPaths, EnvAppPathsRefusal>
  runtime: HostRuntime
  /** Ends the Host with `code`; called once, only for a refusal or a failed boot. */
  exit(code: number): void
}

export type BootOutcome =
  | { kind: 'ready' }
  | { kind: 'refused'; refusal: HostRefusal }
  | { kind: 'failed'; step: BootStepName }

const SUBSYSTEM = 'host'

/**
 * Runs the boot. `createSteps` gets the data directory once it is known to exist, so no step is
 * built for a Host that refuses to start.
 */
export async function runBoot(
  createSteps: (paths: AppPaths) => readonly BootStep[],
  deps: BootDeps
): Promise<BootOutcome> {
  const startedAt = deps.clock.now()
  const record = (entry: Omit<DiagnosticEntry, 'subsystem'>): void =>
    deps.log.record({ ...entry, subsystem: SUBSYSTEM })
  const refuse = (refusal: HostRefusal): BootOutcome => {
    deps.exit(EXIT_CODES[refusal])
    return { kind: 'refused', refusal }
  }

  record({ level: 'info', event: 'host.start', outcome: 'ok', msg: startMessage(deps.runtime) })

  const privilege = await deps.privilege()
  if (!privilege.elevated.ok) {
    // Fail closed: an elevated Host would run agents elevated (ADR-002 D6).
    record({
      level: 'error',
      event: 'host.elevated-refused',
      causeClass: 'unreadable',
      msg: `elevation could not be read, ${privilege.elevated.cause}`
    })
    return refuse('ELEVATED_REFUSED')
  }
  if (privilege.elevated.value) {
    record({ level: 'error', event: 'host.elevated-refused' })
    return refuse('ELEVATED_REFUSED')
  }

  const jobStatus = jobStatusOf(privilege.inJob)
  record(jobStatusEntry(jobStatus, privilege.inJob))

  if (!deps.paths.ok) {
    record({ level: 'error', event: 'host.no-data-dir', causeClass: deps.paths.error })
    return refuse('NO_DATA_DIR')
  }

  const report = (state: HostStateReport['state']): void => deps.state.report({ state, jobStatus })
  for (const step of createSteps(deps.paths.value)) {
    const stepStartedAt = deps.clock.now()
    const migration: { since: number | null } = { since: null }
    const context: BootStepContext = {
      reportMigrating: () => {
        if (migration.since !== null) return
        migration.since = deps.clock.now()
        report('migrating')
      }
    }

    let result: BootStepResult
    try {
      result = await step.run(context)
    } catch (error) {
      record({
        level: 'error',
        event: 'host.boot.step',
        causeClass: step.name,
        outcome: 'failed',
        errCode: errorCode(error),
        durationMs: deps.clock.now() - stepStartedAt,
        msg: `step ${step.name} failed`,
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
      })
      deps.exit(BOOT_FAILED_EXIT_CODE)
      return { kind: 'failed', step: step.name }
    }

    if (result.kind === 'refused') {
      record({ level: 'info', event: 'host.already-running' })
      return refuse(result.refusal)
    }
    record({
      level: 'info',
      event: 'host.boot.step',
      // The step is the record's class, so the ADR-026 item 6 fold keeps one record per step.
      causeClass: step.name,
      outcome: result.kind === 'done' ? 'ok' : 'skipped',
      durationMs: deps.clock.now() - stepStartedAt,
      msg:
        result.kind === 'done'
          ? `step ${step.name} done`
          : `step ${step.name} skipped until ${result.owner}`
    })
    if (migration.since !== null) {
      record({
        level: 'info',
        event: 'host.migrating',
        durationMs: deps.clock.now() - migration.since
      })
      report('starting')
    } else if (step.name === 'bind-endpoint') {
      report('starting')
    }
  }

  report('ready')
  record({ level: 'info', event: 'host.ready', durationMs: deps.clock.now() - startedAt })
  return { kind: 'ready' }
}

/**
 * ADR-002 D6 from the Host's own `IsProcessInJob`: outside every job → `none`, inside one →
 * `in-job` (degraded), off Windows → `n/a`. An answer that could not be read counts as `in-job`:
 * the person is told sessions may die with a job rather than told nothing. `breakaway-ok` is not
 * produced here: `IsProcessInJob` alone cannot tell it.
 */
function jobStatusOf(inJob: PrivilegeReport['inJob']): HelloOk['jobStatus'] {
  if (inJob === 'not-applicable') return 'n/a'
  if (!inJob.ok) return 'in-job'
  return inJob.value ? 'in-job' : 'none'
}

function jobStatusEntry(
  jobStatus: HelloOk['jobStatus'],
  inJob: PrivilegeReport['inJob']
): Omit<DiagnosticEntry, 'subsystem'> {
  if (jobStatus !== 'in-job') {
    return {
      level: 'info',
      event: 'host.job-status',
      outcome: 'ok',
      msg: jobStatus === 'n/a' ? 'no job objects on this OS' : 'outside every job'
    }
  }
  if (inJob !== 'not-applicable' && !inJob.ok) {
    return {
      level: 'warn',
      event: 'host.job-status',
      outcome: 'degraded',
      causeClass: 'unreadable',
      msg: `job membership could not be read, ${inJob.cause}`
    }
  }
  return { level: 'warn', event: 'host.job-status', outcome: 'degraded', msg: 'inside a job' }
}

function startMessage(runtime: HostRuntime): string {
  const electron = runtime.electron === undefined ? '' : ` electron ${runtime.electron}`
  return `boot sequence started, ${runtime.os} ${runtime.arch} node ${runtime.node}${electron}`
}

/** ADR-026 item 5: a thrown error is reduced to its code, else its class name. */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}
