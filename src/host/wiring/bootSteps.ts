// The Host's boot steps in the order of 16 §8.2 (ADR-015 item 3). Each step is built by the issue
// named beside it; until then it is a placeholder that does nothing and reports `skipped` with its
// owner, which runBoot logs. A later issue replaces its placeholder in place, keeping the order
// (this file is a serialized hot spot, 22 §5).
//
// `ports` are the platform adapters and kernel ports the composition root built; the steps that
// replace the placeholders use them.
import { endpointFor, type EndpointError } from '@dwarfai/contracts'
import type { AppPaths } from '../kernel/ports/appPaths'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { ProcessControl } from '../kernel/ports/processControl'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { bindEndpoint, EndpointBindError, type BoundEndpoint } from '../transport/endpoint/server'
import type { BootStep, BootStepName } from './boot'
import { decideBind } from './singleInstance'

export interface BootPorts {
  paths: AppPaths
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  fs: FileSystem
  processControl: ProcessControl
  log: DiagnosticsLog
  /** The UI endpoint step 1 binds (createUiEndpoint in production). */
  endpoint: UiEndpoint
}

/** The Host's UI endpoint as the boot sees it. */
export interface UiEndpoint {
  /** Binds it: `already-running` when a running Host holds it (ADR-002 D3); throws on an error. */
  bind(): Promise<'bound' | 'already-running'>
  /** Ends its connections, stops listening and removes the socket file. */
  close(): Promise<void>
}

/** A step not built yet: it does nothing and names the issue that builds it. */
function placeholder(name: BootStepName, owner: string): BootStep {
  return { name, run: () => Promise.resolve({ kind: 'skipped', owner }) }
}

export function createBootSteps(ports: BootPorts): readonly BootStep[] {
  return [
    // 1. Bind the UI endpoint; the bind is the single-instance mutex (decideBind, ADR-002 D3).
    {
      name: 'bind-endpoint',
      run: async () =>
        (await ports.endpoint.bind()) === 'bound'
          ? { kind: 'done' }
          : { kind: 'refused', refusal: 'ALREADY_RUNNING' }
    },
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

export interface UiEndpointDeps {
  /** The platform's endpoint facts (host/platform/endpoint/nodeEndpointEnv.ts). */
  facts: EndpointFacts
  log: DiagnosticsLog
  scheduler: Scheduler
}

/** The `code` of each endpoint rule refusal, as the boot logs it (FM-037: "fails fast, logged"). */
const ENDPOINT_ERROR_CODES: Readonly<Record<EndpointError['kind'], string>> = {
  'host-data-dir-invalid': 'ENDPOINT_HOST_DATA_DIR_INVALID',
  'user-sid-missing': 'ENDPOINT_USER_SID_MISSING',
  'home-missing': 'ENDPOINT_HOME_MISSING',
  'socket-path-too-long': 'ENDPOINT_SOCKET_PATH_TOO_LONG'
}

/**
 * The production UI endpoint: the platform's facts, the one ADR-002 D2 rule shared with the UI,
 * and the transport's server with the ADR-002 D3 decision. Once bound it stays bound, and its
 * listener is what keeps the Host's event loop alive after `ready` (ADR-002 D1, D7: the Host
 * never exits on its own). It is closed by the clean-exit path (later: ISSUE-028).
 */
export function createUiEndpoint(deps: UiEndpointDeps): UiEndpoint {
  let bound: BoundEndpoint | null = null
  return {
    async bind() {
      const facts = await deps.facts()
      if (!facts.ok) throw new EndpointBindError('ENDPOINT_FACTS_UNREADABLE', facts.cause)
      const endpoint = endpointFor(facts.value)
      if (!endpoint.ok) throw new EndpointBindError(ENDPOINT_ERROR_CODES[endpoint.error.kind])
      const outcome = await bindEndpoint(endpoint.value, {
        log: deps.log,
        scheduler: deps.scheduler,
        decide: decideBind,
        // Asking a live endpoint for `hello` needs the frame codec (later: ISSUE-023). Until then
        // a live endpoint counts as not answering: a second Host fails its boot (FM-008) instead
        // of exiting ALREADY_RUNNING, and nothing of the running Host is touched.
        probeExisting: () => Promise.resolve('no-hello')
      })
      if (outcome.kind === 'already-running') return 'already-running'
      bound = outcome.endpoint
      return 'bound'
    },
    async close() {
      await bound?.close()
      bound = null
    }
  }
}
