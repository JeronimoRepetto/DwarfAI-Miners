// The Host's boot steps in the order of 16 §8.2 (ADR-015 item 3). Each step is built by the issue
// named beside it; until then it is a placeholder that does nothing and reports `skipped` with its
// owner, which runBoot logs. A later issue replaces its placeholder in place, keeping the order
// (this file is a serialized hot spot, 22 §5).
//
// `ports` are the platform adapters and kernel ports the composition root built; the steps that
// replace the placeholders use them.
import { join } from 'node:path'
import { endpointFor, type EndpointError, type HostFrameName } from '@dwarfai/contracts'
import type { AppPaths } from '../kernel/ports/appPaths'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { ProcessControl } from '../kernel/ports/processControl'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { UI_TOKEN_FILE, UiToken } from '../transport/auth/uiToken'
import { collectCapabilities } from '../transport/capabilities'
import { acceptConnection } from '../transport/connection'
import type { ConnectionRegistry } from '../transport/connectionRegistry'
import type { Dispatcher } from '../transport/dispatcher'
import { bindEndpoint, EndpointBindError, type BoundEndpoint } from '../transport/endpoint/server'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import type { HostIdentity } from '../transport/hello'
import { createHelloProbe } from '../transport/helloProbe'
import { errorCode, type BootStep, type BootStepName, type HostStateReport } from './boot'
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
    // 8. hello answers `ready`: the boot reports `ready` into the lifecycle state holder
    //    (transport/lifecycle/hostState.ts) once this last step is done (S12.06), which answers
    //    every later `hello.ok` with it and sends `host.state` to the `ui` connections. Nothing is
    //    left to run here.
    { name: 'answer-ready', run: () => Promise.resolve({ kind: 'done' }) }
  ]
}

export interface UiEndpointDeps {
  /** The platform's endpoint facts (host/platform/endpoint/nodeEndpointEnv.ts). */
  facts: EndpointFacts
  log: DiagnosticsLog
  scheduler: Scheduler
  clock: Clock
  ids: IdGenerator
  /** This Host build, for `hello.ok` and the probe's own `hello`. */
  identity: HostIdentity
  /** This Host process's pid, for the probe's `hello.client`. */
  pid: number
  /** This boot's epoch (mintBootEpoch). */
  epoch: string
  /** The lifecycle state the boot reports (HostStateHolder). */
  state: () => HostStateReport
  /** The seam-B method registry every authenticated request goes through. */
  dispatcher: Dispatcher
  /** Where each authenticated connection is attached, so the Host frames of its role reach it. */
  connections: ConnectionRegistry
  /** The frames this Host publishes, advertised in `hello.ok.capabilities` (14 §1.3). */
  frames: readonly HostFrameName[]
  /**
   * Creates a Windows endpoint's pipe owner-only (ADR-003 item 2): the native helper of
   * host/platform/endpoint/win-pipe. Never used for a Unix socket.
   */
  ownerOnlyPipe: ListenOwnerOnlyPipe
}

/**
 * The boot epoch (ADR-003 HelloOk.epoch; 06 `HostEpoch`): minted once per Host start, so it
 * changes on every start and tells a hot reconnect from a Host restart (ADR-003 items 6, 8).
 */
export function mintBootEpoch(ids: IdGenerator): string {
  return ids.uuidv7()
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
 * never exits on its own). It is closed only by the clean exit (transport/lifecycle/cleanExit.ts).
 *
 * Every accepted connection goes to the auth layer (ADR-003 items 3–6, 12). This boot's uiToken
 * is written to `<hostDataDir>/run/ui.token` only once the bind succeeded, so a Host that finds
 * the endpoint in use never touches the running Host's token: it reads that token for the
 * ADR-002 D3 hello probe instead, and exits ALREADY_RUNNING when the running Host answers.
 * Until the token is written no hello can authenticate (nobody can hold the new token yet).
 */
export function createUiEndpoint(deps: UiEndpointDeps): UiEndpoint {
  let bound: BoundEndpoint | null = null
  return {
    async bind() {
      const facts = await deps.facts()
      if (!facts.ok) throw new EndpointBindError('ENDPOINT_FACTS_UNREADABLE', facts.cause)
      const endpoint = endpointFor(facts.value)
      if (!endpoint.ok) throw new EndpointBindError(ENDPOINT_ERROR_CODES[endpoint.error.kind])
      // ADR-003 item 3 (AMENDMENT-10): the token lives in <hostDataDir>/run on every OS, which on
      // Linux with XDG_RUNTIME_DIR is not the socket's folder.
      const runDir = join(facts.value.hostDataDir, 'run')
      const token = new UiToken()
      const outcome = await bindEndpoint(endpoint.value, {
        log: deps.log,
        scheduler: deps.scheduler,
        decide: decideBind,
        probeExisting: createHelloProbe({
          tokenFile: join(runDir, UI_TOKEN_FILE),
          scheduler: deps.scheduler,
          protocolVersion: deps.identity.protocolVersion,
          client: {
            appVersion: deps.identity.hostVersion,
            buildId: deps.identity.buildId,
            pid: deps.pid
          }
        }),
        accept: (connection) =>
          acceptConnection(connection, {
            token,
            ids: deps.ids,
            identity: deps.identity,
            epoch: deps.epoch,
            state: deps.state,
            capabilities: () =>
              collectCapabilities({ methods: deps.dispatcher.methods(), frames: deps.frames }),
            scheduler: deps.scheduler,
            clock: deps.clock,
            log: deps.log,
            dispatcher: deps.dispatcher,
            connections: deps.connections
          }),
        ownerOnlyPipe: deps.ownerOnlyPipe
      })
      if (outcome.kind === 'already-running') return 'already-running'
      try {
        await token.issue(runDir)
      } catch (error) {
        // No UI could ever attach: the bind step fails and the endpoint is released.
        await outcome.endpoint.close()
        throw new EndpointBindError('ENDPOINT_TOKEN_UNWRITABLE', errorCode(error))
      }
      bound = outcome.endpoint
      return 'bound'
    },
    async close() {
      await bound?.close()
      bound = null
    }
  }
}
