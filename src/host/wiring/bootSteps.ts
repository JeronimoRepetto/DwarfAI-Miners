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
import { HelloThrottle } from '../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../transport/auth/uiToken'
import { collectCapabilities } from '../transport/capabilities'
import { acceptConnection } from '../transport/connection'
import type { ConnectionRegistry } from '../transport/connectionRegistry'
import type { Dispatcher } from '../transport/dispatcher'
import { bindEndpoint, EndpointBindError, type BoundEndpoint } from '../transport/endpoint/server'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import type { HostIdentity } from '../transport/hello'
import { createHelloProbe } from '../transport/helloProbe'
import { deferUntilPublished } from '../transport/runFiles/hostIdentityFile'
import { errorCode, type BootStep, type BootStepName, type HostStateReport } from './boot'
import type { HostDatabase } from './hostDatabase'
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
  /** The Host database step 2 opens (createHostDatabase, hostDatabase.ts). */
  database: Pick<HostDatabase, 'open'>
  /**
   * Step 3: the Reset saga's boot resume (preferences `resumeOnBoot`, 07 S13.08). The composition
   * root passes it (ISSUE-226): it wires the preferences module (preferencesWiring.ts) and resumes
   * an unfinished saga, before module construction (step 4) and before any command is accepted
   * (`ready`). Without it the step is a placeholder.
   */
  resumeResetSaga?: () => Promise<unknown>
  /**
   * Step 3, right after the saga resume: the boot re-verification of every config write a crash
   * left between Tx A and Tx B (`verified_at IS NULL`; 16 §7.3, 07 S14.08, S14.11, 13 FM-020). The
   * composition root passes the config writer's settlement (ISSUE-323). It runs before the modules
   * are constructed (step 4), so suppliers' integration gate and the first-run evaluation (step 8)
   * read the settled state, and before any command is accepted (`ready`). A failure is logged and
   * never fails the boot (the Host never exits on its own, ADR-002 D1, D7): the rows stay for the
   * next boot, and their integration stays as stored (`off`, since Tx B never ran).
   */
  reverifyConfigWrites?: () => Promise<unknown>
  /**
   * Step 4: constructs the modules and wires their bridges and event routes (05 §4) over the
   * database step 2 opened. The composition root passes it; the modules join it one wiring issue
   * at a time (suppliers: ISSUE-159). Until it is passed the step is a placeholder.
   */
  constructModules?: () => void
  /**
   * Step 7: `observation.catchUp()` then `start()` (16 §8.2; ADR-015 item 3), after recovery's
   * classification (step 5) and before `ready` (step 8). `ready` does not wait for the catch-up
   * pass, which may go on after it (16 §4.3 `catchUp`). The composition root passes it
   * (wiring/routes/observation.ts `start`, null over a sink that stores nothing) since the batch
   * sink has its conversation half (ISSUE-108); without it the step is a placeholder.
   */
  startObservation?: () => void
  /**
   * After step 7, before `ready`: starts the modules' own background work over what step 4
   * constructed (the mines' boot walks and folder-check schedule: ISSUE-093). Without it nothing
   * is started.
   */
  startModules?: () => void
  /**
   * In step 8, before `ready`: the first-run consent step's boot evaluation (07 S41.01, S41.02,
   * S41.09; ISSUE-222), after the saga resume (step 3) and the modules (step 4), before any command
   * is accepted. The composition root passes `evaluateWelcomeAfterDetection`. Without it nothing is
   * evaluated.
   */
  evaluateWelcome?: () => Promise<void>
}

/**
 * The first-run step's boot evaluation, right after the start-up installed detection (07 S41.09:
 * "right after the installed detection, before S41.01/S41.02"; suppliersWiring.ts `bootDetection`).
 *
 * Fail closed. A failed detection evaluates nothing: the step keeps its not-evaluated state (not
 * due, nothing offered), so nothing is shown, written, reverted or answered, and
 * `welcome_answered_at` is untouched, so the next Host start evaluates again. That is S41.09's
 * outcome for "no tool known to be installed" (a skip, never an answer) and keeps OQ-17 / ADR-016
 * (nothing written and no old-app entry adopted without the person's click). A failed evaluation
 * (the legacy probe's I/O, say) ends the same way, logged, and never fails the boot: the Host never
 * exits on its own (ADR-002 D1, D7).
 */
export async function evaluateWelcomeAfterDetection(deps: {
  detection: Promise<'detected' | 'failed'>
  evaluate: () => Promise<unknown>
  log: DiagnosticsLog
}): Promise<void> {
  if ((await deps.detection) !== 'detected') return
  try {
    await deps.evaluate()
  } catch (error) {
    deps.log.record({
      level: 'error',
      event: 'uncaught',
      subsystem: 'preferences',
      errCode: errorCode(error)
    })
  }
}

/** Step 3's re-verification (BootPorts `reverifyConfigWrites`): a failure is logged, never thrown. */
async function reverifyConfigWritesLogged(
  reverify: (() => Promise<unknown>) | undefined,
  log: DiagnosticsLog
): Promise<void> {
  if (reverify === undefined) return
  try {
    await reverify()
  } catch (error) {
    log.record({
      level: 'error',
      event: 'uncaught',
      subsystem: 'preferences',
      errCode: errorCode(error)
    })
  }
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
  const {
    resumeResetSaga,
    reverifyConfigWrites,
    constructModules,
    startObservation,
    startModules,
    evaluateWelcome
  } = ports
  return [
    // 1. Bind the UI endpoint; the bind is the single-instance mutex (decideBind, ADR-002 D3).
    {
      name: 'bind-endpoint',
      run: async () =>
        (await ports.endpoint.bind()) === 'bound'
          ? { kind: 'done' }
          : { kind: 'refused', refusal: 'ALREADY_RUNNING' }
    },
    // 2. Open the DB and migrate, reporting `migrating` (ADR-005); then keep the Host epoch and
    //    its boot identity (09 §8.4). A refused open fails the boot (FM-008).
    {
      name: 'open-db-and-migrate',
      run: async (context) => {
        await ports.database.open(context)
        return { kind: 'done' }
      }
    },
    // 3. Resume an unfinished Reset saga, before commands and observation (ADR-023). A step that
    //    fails again is recorded by the saga and resumes at the next boot; the boot goes on.
    //    Commands are accepted only from `ready` (step 8). Then the boot re-verification of the
    //    config writes a crash left unverified (16 §7.3, 07 S14.11; ISSUE-323); the first-run
    //    evaluation runs in step 8 (ISSUE-222).
    resumeResetSaga === undefined
      ? placeholder('resume-reset-saga', 'ISSUE-226')
      : {
          name: 'resume-reset-saga',
          run: async () => {
            await resumeResetSaga()
            await reverifyConfigWritesLogged(reverifyConfigWrites, ports.log)
            return { kind: 'done' }
          }
        },
    // 4. Construct the modules, wire bridges and event routes (05 §4), over the database step 2
    //    opened; each module joins in its own wiring issue (suppliers: ISSUE-159, mines: ISSUE-093,
    //    crew: ISSUE-094, observation: ISSUE-095, attention: ISSUE-119). Every route that reads an
    //    observation event is subscribed here, before step 7's catch-up publishes the first one.
    //    Attention's tray notifier supervisor starts here too, after step 1's endpoint is
    //    listening, fed with the clients already attached and every later attach and detach.
    constructModules === undefined
      ? placeholder('construct-modules', 'ISSUE-093')
      : {
          name: 'construct-modules',
          run: () => {
            constructModules()
            return Promise.resolve({ kind: 'done' })
          }
        },
    // 5. launching.recoverAfterHostStart(): reconcile, verify, classify, report, cleanup.
    placeholder('recover-sessions', 'ISSUE-173'),
    // 6. The MCP endpoint (DelegationServer.listen) and the hook ingress.
    placeholder('start-endpoints', 'ISSUE-209'),
    // 7. observation.catchUp(), then start() (ISSUE-095). The catch-up pass of what providers
    //    wrote while no Host ran may go on after `ready` (16 §4.3 `catchUp`).
    startObservation === undefined
      ? placeholder('start-observation', 'ISSUE-108')
      : {
          name: 'start-observation',
          run: () => {
            startObservation()
            return Promise.resolve({ kind: 'done' })
          }
        },
    // 8. hello answers `ready`: the boot reports `ready` into the lifecycle state holder
    //    (transport/lifecycle/hostState.ts) once this last step is done (S12.06), which answers
    //    every later `hello.ok` with it and sends `host.state` to the `ui` connections. First, once
    //    step 7 is done, the first-run consent step is evaluated (`evaluateWelcome`, 07 S41.01:
    //    after the saga resume, before commands; it waits for the start-up installed detection,
    //    S41.09, which ran beside steps 5–7), then the modules' own background work starts
    //    (`startModules`).
    {
      name: 'answer-ready',
      run: async () => {
        await evaluateWelcome?.()
        startModules?.()
        return { kind: 'done' }
      }
    }
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
  /**
   * The snapshot sections this Host serves, advertised as `section:<name>` (14 §4.4): the
   * SectionRegistry's names, read at each hello so a section registered later is listed.
   */
  sections?: () => Iterable<string>
  /** Conditions advertised bare beside them: `db-read-only` (HostDatabase, ADR-005 item 5). */
  conditions?: () => Iterable<string>
  /** `run/host.identity` (HostIdentityFile), written right after the bind (ADR-002 D3). */
  identityFile: { publish(): Promise<unknown>; remove(): Promise<void> }
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
 * Right after the bind, before the token, the Host writes `run/host.identity` (ADR-002 D3), and
 * every connection accepted meanwhile is held unread until both files exist.
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
      // ADR-003 item 5: one failed-hello throttle for every connection of this endpoint.
      const throttle = new HelloThrottle(deps.clock)
      // ADR-002 D3: connections accepted after the bind wait until host.identity and the token exist.
      let runFiles: { resolve(): void; reject(error: unknown): void } | undefined
      const runFilesWritten = new Promise<void>(
        (resolve, reject) => (runFiles = { resolve, reject })
      )
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
        accept: deferUntilPublished(runFilesWritten, (connection) =>
          acceptConnection(connection, {
            token,
            ids: deps.ids,
            identity: deps.identity,
            epoch: deps.epoch,
            state: deps.state,
            capabilities: () =>
              collectCapabilities({
                methods: deps.dispatcher.methods(),
                frames: deps.frames,
                sections: deps.sections?.() ?? [],
                conditions: deps.conditions?.() ?? []
              }),
            scheduler: deps.scheduler,
            clock: deps.clock,
            log: deps.log,
            dispatcher: deps.dispatcher,
            connections: deps.connections,
            throttle
          })
        ),
        ownerOnlyPipe: deps.ownerOnlyPipe
      })
      if (outcome.kind === 'already-running') return 'already-running'
      let code = 'ENDPOINT_IDENTITY_UNWRITABLE'
      try {
        await deps.identityFile.publish()
        code = 'ENDPOINT_TOKEN_UNWRITABLE'
        await token.issue(runDir)
      } catch (error) {
        // No UI could ever attach: the bind step fails and the endpoint is released.
        runFiles?.reject(error)
        await deps.identityFile.remove().catch(() => undefined)
        await outcome.endpoint.close()
        throw new EndpointBindError(code, errorCode(error))
      }
      runFiles?.resolve()
      bound = outcome.endpoint
      return 'bound'
    },
    async close() {
      await bound?.close()
      bound = null
    }
  }
}
