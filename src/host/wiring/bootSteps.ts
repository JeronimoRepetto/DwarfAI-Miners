// The Host's boot steps in the order of 16 §8.2 (ADR-015 item 3). Each step is built by the issue
// named beside it; until then it is a placeholder that does nothing and reports `skipped` with its
// owner, which runBoot logs. A later issue replaces its placeholder in place, keeping the order
// (this file is a serialized hot spot, 22 §5).
//
// `ports` are the platform adapters and kernel ports the composition root built; no placeholder
// uses them yet, the steps that replace them do.
import type { AppPaths } from '../kernel/ports/appPaths'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { ProcessControl } from '../kernel/ports/processControl'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { BootStep, BootStepName } from './boot'

export interface BootPorts {
  paths: AppPaths
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  fs: FileSystem
  processControl: ProcessControl
  log: DiagnosticsLog
}

/** A step not built yet: it does nothing and names the issue that builds it. */
function placeholder(name: BootStepName, owner: string): BootStep {
  return { name, run: () => Promise.resolve({ kind: 'skipped', owner }) }
}

export function createBootSteps(_ports: BootPorts): readonly BootStep[] {
  return [
    // 1. Bind the UI endpoint; the bind is the single-instance mutex (decideBind, ADR-002 D3).
    placeholder('bind-endpoint', 'ISSUE-022'),
    // 2. Open the DB and migrate, reporting `migrating` (ADR-005).
    placeholder('open-db-and-migrate', 'ISSUE-039'),
    // 3. Resume an unfinished Reset saga, before commands and observation (ADR-023).
    placeholder('resume-reset-saga', 'ISSUE-212'),
    // 4. Construct the modules, wire bridges and event routes (05 §4); the first module wired is
    //    mines, the others follow in their own wiring issues.
    placeholder('construct-modules', 'ISSUE-093'),
    // 5. launching.recoverAfterHostStart(): reconcile, verify, classify, report, cleanup.
    placeholder('recover-sessions', 'ISSUE-173'),
    // 6. The MCP endpoint (DelegationServer.listen) and the hook ingress.
    placeholder('start-endpoints', 'ISSUE-209'),
    // 7. observation.catchUp(), then start().
    placeholder('start-observation', 'ISSUE-095'),
    // 8. hello answers `ready` (the state holder of transport).
    placeholder('answer-ready', 'ISSUE-028')
  ]
}
