// driverConformance (15 §6, 17 §1.4; ADR-009 D3 Verification): one suite, C-01…C-29 (C-25b under
// C-25), run against every ProviderDriver over a fixture transport and a recording spawn, with a
// FakeClock and a FakeScheduler (no real timer, no network, no real CLI; 17 §5.3). A driver issue
// calls `driverConformance(name, factory, fixtureSet, options)` with its own fixture set; no driver
// is offered until its run is green. A case the driver's capabilities make inapplicable is declared
// in `options.cases` and then asserted at its fail-closed value, never skipped (17 §5.4).
//
// `runCase` / `runConformance` return verdicts instead of throwing, so the harness's own tests can
// show that a broken driver fails exactly the case it violates.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { AnswerOutcome } from '../../../kernel/domain/sharedContracts'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../kernel/ports/processControl'
import {
  ceilingOf,
  type CapabilityCeiling,
  type ProviderCapabilities
} from '../domain/capabilities'
import type { IntegrationState } from '../../../kernel/domain/values'
import {
  combineLowest,
  merge,
  negotiatedFor,
  type NegotiatedCapabilities
} from '../domain/mergeCapabilities'
import type { PermissionModeSpec } from '../domain/profile'
import type {
  DelegationInjection,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  InstalledProvider,
  ProviderDriver
} from '../ports/providerDriver'
import {
  bind,
  compareEvents,
  differences,
  sourceKeysOf,
  type Bindings,
  type Json
} from './expected'
import type { FixtureCase, FixtureSet, FixtureVariant, ScriptStep } from './fixtureSet'
import { FixtureTransport, type Chunking } from './fixtureTransport'
import { RecordingSpawn, type SpawnScript } from './recordingSpawn'

/** The doubles one run hands the driver factory. */
export interface ConformanceRig {
  readonly clock: FakeClock
  readonly scheduler: FakeScheduler
  /** The recording spawn: drivers spawn through it (15 §4, AMENDMENT-10 A10-09). */
  readonly processControl: RecordingSpawn
  /** The person's login environment the driver builds `childEnv(spawnTag)` from (15 §4). */
  readonly loginEnv: Readonly<Record<string, string>>
}

export type DriverFactory = (rig: ConformanceRig) => ProviderDriver

export type CaseId =
  | 'C-01'
  | 'C-02'
  | 'C-03'
  | 'C-04'
  | 'C-05'
  | 'C-06'
  | 'C-07'
  | 'C-08'
  | 'C-09'
  | 'C-10'
  | 'C-11'
  | 'C-12'
  | 'C-13'
  | 'C-14'
  | 'C-15'
  | 'C-16'
  | 'C-17'
  | 'C-18'
  | 'C-19'
  | 'C-20'
  | 'C-21'
  | 'C-22'
  | 'C-23'
  | 'C-24'
  | 'C-25'
  | 'C-26'
  | 'C-27'
  | 'C-28'
  | 'C-29'

export interface ConformanceOptions {
  /**
   * The catalog ceiling of the driver's provider (ADR-009 D1; its unordered enums are sets,
   * AMENDMENT-18), or, for a driver with no catalog record ("Other…", INV-43) or a harness test
   * driver, its own single row, which stands as a ceiling allowing exactly its values.
   */
  readonly ceiling: CapabilityCeiling | ProviderCapabilities
  /** The install every launch names (ADR-008 item 1: the only executable it may spawn). */
  readonly install: InstalledProvider
  /** Cases the driver's capabilities make inapplicable, each with its reason. */
  readonly cases?: Partial<Record<CaseId, { readonly inapplicable: string }>>
  /**
   * A case whose recordings were made with other doubles than the run's (the recording Host's
   * minted ids, so a resume over a recorded process keeps the recorded session id) runs over its
   * own factory; every other case uses the run's.
   */
  readonly caseFactories?: Partial<Record<CaseId, DriverFactory>>
  /** CH-04 for a driver with no fixture transport: drop its transport before an exit. */
  readonly injectTransportLoss?: (session: DriverSession) => void
  /** The driver's `HANDSHAKE_TIMEOUT_MS` when it is configured away from 15 §0's 30 000. */
  readonly handshakeTimeoutMs?: number
  /** The provider's policy-only permission mode (ADR-011 item 1), for C-22. */
  readonly policyOnlyMode?: PermissionModeSpec
}

/** The options' ceiling as a `CapabilityCeiling`: a single row is lifted with `ceilingOf`. */
function ceilingFrom(options: ConformanceOptions): CapabilityCeiling {
  const ceiling = options.ceiling
  return Array.isArray(ceiling.resume)
    ? (ceiling as CapabilityCeiling)
    : ceilingOf(ceiling as ProviderCapabilities)
}

export interface CaseVerdict {
  readonly ok: boolean
  readonly failures: readonly string[]
}

// ---------- one scripted run ----------

/** ADR-010 item 8: the hand-over the broker grants an answer before `channel-unavailable`. */
export const HANDOVER_MS = 30_000

/**
 * The person's login environment as the rig plants it (15 §4 `childEnv`): the variables a child
 * may receive, plus canaries no child may ever receive (INV-59, C-23).
 */
export const CANARY_TOKEN = 'conformance-canary-delegation-token'
export const LOGIN_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/j',
  LANG: 'en_US.UTF-8',
  DWARFAI_DELEGATION_TOKEN: CANARY_TOKEN,
  DWARFAI_MCP_CREDENTIAL_FILE: '/home/j/.dwarfai/run/mcp/launch.cred',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: '--inspect'
})

type Tracked = {
  state: 'pending' | 'resolved' | 'rejected'
  value?: unknown
}

/** How the harness drives one run beyond the script itself. */
export interface RunPlan {
  /** The fixture variant the transport replays (`null`: no recorded bytes). */
  readonly variant: FixtureVariant | null
  /** How the transport cuts the recorded lines into chunks (default: as recorded). */
  readonly chunking?: Chunking
  /** What each spawn does; by default it gets a fixture transport over `variant`. */
  readonly spawn?: (spec: SpawnSpec, fixture: () => SpawnScript) => SpawnScript
  /** CH-05: the transport hangs before every answer step. */
  readonly hangBeforeAnswers?: boolean
  /** Every launch of the run is a gated delegation launch (C-23). */
  readonly delegation?: boolean
  /** C-26: each spawn is a CLI that prints the fixture (its help output) and exits 0. */
  readonly helpOutput?: boolean
}

/** What one scripted run of a fixture variant produced. */
export interface Run {
  readonly events: DriverEvent[]
  /** The same events per session, in binding order (a launch, then each resumed or adopted one). */
  readonly sessionEvents: DriverEvent[][]
  /** Per script step: what its call resolved (`{ pending: true }` when it never settled). */
  readonly outcomes: unknown[]
  /** `events.length`, the clock and the steps still pending, when each step started. */
  readonly eventsAtStep: number[]
  readonly clockAtStep: number[]
  readonly pendingAtStep: number[][]
  /** How many frames the driver had sent when each step started. */
  readonly sentAtStep: number[]
  /** Every frame the driver sent through a fixture transport. */
  readonly sent: Json[]
  readonly failures: string[]
  readonly spawn: RecordingSpawn
  /** Every launch request, with the identities its `onSpawned` received. */
  readonly launches: { request: DriverLaunchRequest; spawned: ProcessIdentity[] }[]
  readonly transports: FixtureTransport[]
  readonly options: ConformanceOptions
  session: DriverSession | null
  driver: ProviderDriver
  bindings: Record<string, string>
}

/** Lets every pending continuation run; no timer is involved (the clock is fake). */
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

/**
 * Moves the fake clock `ms` forward one due task at a time, letting continuations run at each
 * task's own instant, so a driver that reads the clock after an awaited event sees that instant.
 */
async function advance(clock: FakeClock, scheduler: FakeScheduler, ms: number): Promise<void> {
  const target = clock.now() + ms
  // Bounded: a task that keeps rescheduling itself at the same instant cannot hang the run.
  for (let step = 0; step < 10_000; step++) {
    const due = scheduler.nextDueAt()
    if (due === null || due > target) break
    clock.advance(Math.max(0, due - clock.now()))
    await settle()
  }
  clock.advance(target - clock.now())
}

function track<T>(promise: Promise<T>): Tracked {
  const tracked: Tracked = { state: 'pending' }
  promise.then(
    (value) => Object.assign(tracked, { state: 'resolved', value }),
    (error: unknown) => Object.assign(tracked, { state: 'rejected', value: error })
  )
  return tracked
}

function outcomeOf(step: ScriptStep, tracked: Tracked | null): unknown {
  if (tracked === null) return null
  if (tracked.state === 'pending') return { pending: true }
  if (tracked.state === 'rejected') return { rejected: plain(tracked.value) }
  return step.do === 'launch' ? { resolved: true } : plain(tracked.value)
}

/** A JSON-shaped copy (drops `undefined` fields, as an expected file cannot hold them). */
function plain(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown)
}

function parsedFrame(frame: string): Json {
  try {
    return JSON.parse(frame) as Json
  } catch {
    return frame
  }
}

/** Runs one fixture variant's script against a fresh driver and fresh doubles. */
export async function runScript(
  factory: DriverFactory,
  script: readonly ScriptStep[],
  plan: RunPlan,
  options: ConformanceOptions
): Promise<Run> {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const transports: FixtureTransport[] = []
  const fixture = (): SpawnScript => {
    const variant = plan.variant
    // A multi-process recording serves its N-th process to the N-th spawn (C-16: launch, resume).
    const part = variant?.processes?.[transports.length]
    const received = part?.received ?? (variant?.processes === undefined ? variant?.received : '')
    const gates = part?.gates ?? (variant?.processes === undefined ? variant?.gates : undefined)
    const transport = new FixtureTransport({
      received: received ?? '',
      format: variant?.format ?? 'jsonl',
      ...(gates === undefined ? {} : { gates }),
      ...(plan.chunking === undefined ? {} : { chunking: plan.chunking }),
      ...(variant?.streams.stderr === undefined ? {} : { stderr: variant.streams.stderr })
    })
    transports.push(transport)
    return { kind: 'fixture', transport }
  }
  const spawn = new RecordingSpawn({
    clock,
    scheduler,
    decide: (spec) => {
      if (plan.spawn !== undefined) return plan.spawn(spec, fixture)
      if (plan.helpOutput === true) {
        return { kind: 'exit', afterMs: 0, code: 0, stdout: plan.variant?.received ?? '' }
      }
      return fixture()
    }
  })
  const driver = factory({ clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV })
  const run: Run = {
    events: [],
    sessionEvents: [],
    outcomes: [],
    eventsAtStep: [],
    clockAtStep: [],
    pendingAtStep: [],
    sentAtStep: [],
    sent: [],
    failures: [],
    spawn,
    launches: [],
    transports,
    options,
    session: null,
    driver,
    bindings: {}
  }
  const tracked: (Tracked | null)[] = []

  const bindSession = (session: DriverSession): void => {
    run.session = session
    // `{session}` names the first session's id: a resume that keeps it matches it, and C-16
    // reads it as the id a new one must name in `previousProviderSessionId`.
    run.bindings.session ??= session.ref.providerSessionId
    const own: DriverEvent[] = []
    run.sessionEvents.push(own)
    void (async () => {
      for await (const event of session.events()) {
        run.events.push(event)
        own.push(event)
      }
    })()
  }

  for (const [index, step] of script.entries()) {
    run.eventsAtStep.push(run.events.length)
    run.clockAtStep.push(clock.now())
    run.pendingAtStep.push(tracked.flatMap((entry, at) => (entry?.state === 'pending' ? [at] : [])))
    run.sentAtStep.push(transports.reduce((count, transport) => count + transport.sent.length, 0))
    const session = run.session
    switch (step.do) {
      case 'launch': {
        const launched = launchRequest(step, plan, options, run.launches.length)
        const trace = { request: launched, spawned: [] as ProcessIdentity[] }
        run.launches.push(trace)
        const pending = driver.launch({
          ...launched,
          onSpawned: async (identity) => {
            spawn.log.push(`onSpawned ${identity.pid}`)
            trace.spawned.push({ ...identity })
          }
        })
        void pending.then(
          () => spawn.log.push('launch-resolved'),
          () => spawn.log.push('launch-rejected')
        )
        const launch = track(pending)
        tracked.push(launch)
        await settle()
        const ready = step.readyAfterMs ?? 0
        if (ready > 0) {
          await advance(clock, scheduler, ready - 1)
          await settle()
          if (launch.state !== 'pending') {
            run.failures.push(`launch settled ${ready - 1} ms after spawn, before readiness`)
          }
          await advance(clock, scheduler, 1)
          await settle()
        }
        if (launch.state === 'resolved') bindSession(launch.value as DriverSession)
        await settle()
        break
      }
      case 'advance':
        await advance(clock, scheduler, step.ms)
        tracked.push(null)
        await settle()
        break
      case 'probe':
        tracked.push(track(driver.probe(options.install)))
        await settle()
        break
      case 'resume':
      case 'adopt': {
        // ADR-015: the live session is gone (a survivor is ended first); the driver re-opens its ref.
        const reopen = step.do === 'resume' ? driver.resume : driver.adopt
        if (session === null || reopen === undefined) {
          run.failures.push(`step #${index} (${step.do}): no session or no ${step.do}() to call`)
          tracked.push(null)
          break
        }
        const pending = reopen.call(driver, session.ref)
        tracked.push(track(pending))
        // Bound whenever it resolves: an exit-only driver's resume waits out the 3 s early-failure
        // window (ADR-020 D4), so it resolves during a later `advance` step.
        void pending.then(
          (reopened) => {
            if (reopened !== null) bindSession(reopened)
          },
          () => undefined
        )
        await settle()
        break
      }
      default: {
        if (session === null) {
          run.failures.push(`step #${index} (${step.do}) needs a launched session`)
          tracked.push(null)
          break
        }
        const answer = step.do === 'answerPermission' || step.do === 'answerQuestion'
        if (answer && plan.hangBeforeAnswers === true) {
          for (const transport of transports) transport.hang()
        }
        tracked.push(call(step, session, run, scheduler))
        await settle()
      }
    }
  }
  await settle()
  script.forEach((step, index) => run.outcomes.push(outcomeOf(step, tracked[index] ?? null)))
  for (const transport of transports) run.sent.push(...transport.sent.map(parsedFrame))
  return run
}

function launchRequest(
  step: Extract<ScriptStep, { do: 'launch' }>,
  plan: RunPlan,
  options: ConformanceOptions,
  index: number
): DriverLaunchRequest {
  const launchId = step.launchId ?? `launch-${index + 1}`
  // The ceiling's first injecting mechanism (its preferred driver's), if it allows one.
  const mechanism = ceilingFrom(options).mcpInjection.find((value) => value !== 'none') ?? 'none'
  const delegation: DelegationInjection | null =
    (step.delegation === true || plan.delegation === true) && mechanism !== 'none'
      ? {
          mechanism,
          relay: { program: '/opt/dwarfai/host/dwarfai', args: ['dwarfai-mcp-relay'] },
          credentialFilePath: `/home/j/.dwarfai/run/mcp/${launchId}.cred`
        }
      : null
  return {
    launchId: launchId as DriverLaunchRequest['launchId'],
    install: options.install,
    cwd: '/work/mine' as DriverLaunchRequest['cwd'],
    prompt: step.prompt ?? 'first prompt',
    permissionMode: step.permissionMode === 'policy-only' ? (options.policyOnlyMode ?? null) : null,
    delegation,
    spawnTag: `v1:conformance:${launchId}:1`,
    onSpawned: async () => {}
  }
}

/**
 * An answer as the broker sees it (ADR-010 item 8): the driver's outcome, or `channel-unavailable`
 * when the driver has not settled it within the 30 s hand-over on the FakeScheduler.
 */
function handedOver(
  answer: Promise<AnswerOutcome>,
  scheduler: FakeScheduler
): Promise<AnswerOutcome> {
  return new Promise((resolve, reject) => {
    const timer = scheduler.after(HANDOVER_MS, () =>
      resolve({ kind: 'refused', reason: 'channel-unavailable' })
    )
    answer.then(
      (outcome) => {
        timer.cancel()
        resolve(outcome)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      }
    )
  })
}

function call(
  step: ScriptStep,
  session: DriverSession,
  run: Run,
  scheduler: FakeScheduler
): Tracked | null {
  switch (step.do) {
    case 'sendTurn':
      return track(
        session.sendTurn({
          messageId: step.messageId as Parameters<DriverSession['sendTurn']>[0]['messageId'],
          kind: 'message',
          text: step.text,
          attachments: []
        })
      )
    case 'interrupt':
      return track(session.interrupt())
    case 'answerPermission':
      return track(
        handedOver(
          session.answerPermission({
            providerRequestId: step.providerRequestId,
            decision: step.decision
          }),
          scheduler
        )
      )
    case 'answerQuestion':
      return track(
        handedOver(
          session.answerQuestion(
            step.decline === true
              ? { providerRequestId: step.providerRequestId, decline: true }
              : { providerRequestId: step.providerRequestId, answers: [...(step.answers ?? [])] }
          ),
          scheduler
        )
      )
    case 'close':
      return track(session.close(step.mode))
    case 'transportLost':
      if (run.transports.length > 0) {
        for (const transport of run.transports) transport.eof()
      } else if (run.options.injectTransportLoss !== undefined) {
        run.options.injectTransportLoss(session)
      } else {
        run.failures.push('no fixture transport and no injectTransportLoss to drop the transport')
      }
      return null
    default:
      return null
  }
}

/**
 * A run of one session is compared as one stream. A run of several (a launch, then a resume:
 * C-16) is compared session by session, since each session's stream ends with its own `exited`
 * (15 §1.4): the expected events are cut after each `exited`, in order.
 */
function eventsAgainst(run: Run, expected: readonly Json[], bindings: Bindings): string[] {
  if (run.sessionEvents.length < 2) return compareEvents(run.events, expected, bindings)
  const parts: Json[][] = [[]]
  for (const event of expected) {
    ;(parts.at(-1) as Json[]).push(event)
    if ((event as { t?: unknown }).t === 'exited') parts.push([])
  }
  return run.sessionEvents.flatMap((events, index) =>
    compareEvents(events, parts[index] ?? [], bindings).map((line) => `session #${index}: ${line}`)
  )
}

/** The differences between a run and its fixture's expected events, outcomes and frames. */
function againstExpected(run: Run, fixture: FixtureCase): string[] {
  const expected = fixture.expected
  const bindings: Bindings = run.bindings
  const out = [...run.failures, ...eventsAgainst(run, expected.events ?? [], bindings)]
  ;(expected.outcomes ?? []).forEach((want, index) => {
    if (want === null) return
    const why = differences(run.outcomes[index], bind(want, bindings), `outcome #${index}`)
    out.push(...why)
  })
  out.push(...differences(run.sent, bind(expected.sent ?? [], bindings), 'sent'))
  return out
}

// ---------- the cases ----------

interface CaseContext {
  readonly factory: DriverFactory
  readonly fixtures: FixtureSet
  readonly options: ConformanceOptions
}

interface CaseDefinition {
  readonly title: string
  /** Contract checks on one run of one of the case's fixtures, beyond the expected file. */
  readonly check?: (run: Run, fixture: FixtureCase, context: CaseContext) => string[]
  /** How the harness drives each run of the case's fixtures. */
  readonly plan?: Omit<RunPlan, 'variant'>
  /** A harness-driven case: no fixture of its own; it drives the C-01 launch fixture itself. */
  readonly harness?: (context: CaseContext) => Promise<string[]>
  /**
   * When the driver declares the case inapplicable: the fail-closed value its capabilities must
   * then show (TC-144-04). A case without it applies to every driver and cannot be declared.
   */
  readonly failClosed?: (context: CaseContext) => Promise<string[]>
}

// ---------- fail-closed assertions for declared inapplicable cases ----------

/** The effective capabilities of the driver's C-01 launch, or why there are none. */
async function launchedCapabilities(
  context: CaseContext
): Promise<{ capabilities: ProviderCapabilities | null; spawned: string[]; failures: string[] }> {
  const launch = context.fixtures.cases.find((fixture) => fixture.expected.case === 'C-01')
  const variant = launch?.variants[0]
  if (launch === undefined || variant === undefined) {
    return { capabilities: null, spawned: [], failures: ['no C-01 launch fixture to launch with'] }
  }
  const run = await runScript(context.factory, launch.expected.script, { variant }, context.options)
  return {
    capabilities: run.session?.capabilities ?? null,
    spawned: run.spawn.spawns.map((spawn) => spawn.executable),
    failures: run.failures
  }
}

/** Declared inapplicable when the driver spawns nothing: it must then spawn nothing at all. */
async function spawnsNothing(context: CaseContext): Promise<string[]> {
  const { spawned, failures } = await launchedCapabilities(context)
  return [...failures, ...spawned.map((executable) => `the driver spawned ${executable}`)]
}

/** Declared inapplicable by a capability: the effective value must be the fail-closed one. */
function capabilityIs(
  field: keyof ProviderCapabilities,
  closed: (value: ProviderCapabilities[keyof ProviderCapabilities]) => boolean
): (context: CaseContext) => Promise<string[]> {
  return async (context) => {
    const { capabilities, failures } = await launchedCapabilities(context)
    if (capabilities === null)
      return [...failures, 'no launched session to read the capabilities from']
    const value = capabilities[field]
    return closed(value) ? failures : [...failures, `${field} is ${JSON.stringify(value)}`]
  }
}

/** No ask channel: the capability is closed and an answer for any id is refused ask-closed. */
function askChannelClosed(
  kinds: readonly ('permission' | 'question')[]
): (context: CaseContext) => Promise<string[]> {
  return async (context) => {
    const out: string[] = []
    for (const kind of kinds) {
      out.push(
        ...(await capabilityIs(
          kind,
          (value) => value !== 'interactive' && value !== 'form' && value !== 'options'
        )(context))
      )
    }
    const answers: ScriptStep[] = [
      { do: 'answerPermission', providerRequestId: 'conformance-unknown', decision: 'allow' },
      { do: 'answerQuestion', providerRequestId: 'conformance-unknown', decline: true }
    ]
    out.push(
      ...(await overLaunch(context, answers, {}, (run, first) =>
        [first, first + 1].flatMap((index) =>
          differences(run.outcomes[index], { kind: 'refused', reason: 'ask-closed' }).length === 0
            ? []
            : [`an answer for a request never opened gave ${JSON.stringify(run.outcomes[index])}`]
        )
      ))
    )
    return out
  }
}

/**
 * Every replay of a fixture: each variant as recorded, and the recorded JSONL also split in the
 * middle of every line and coalesced into the fewest chunks (a driver must reassemble lines).
 */
function replays(
  fixture: FixtureCase
): { variant: FixtureVariant; chunking: Chunking; label: string }[] {
  return fixture.variants.flatMap((variant) => {
    const chunkings: Chunking[] =
      variant.format === 'jsonl' && variant.label === 'as-recorded'
        ? ['as-recorded', 'split', 'coalesced']
        : ['as-recorded']
    return chunkings.map((chunking) => ({
      variant,
      chunking,
      label: chunking === 'as-recorded' ? variant.label : `${variant.label}, ${chunking}`
    }))
  })
}

/**
 * Runs every variant of the C-01 launch fixture with `extra` steps after its script, and checks
 * each run with `check` (which gets the index of the first extra step).
 */
async function overLaunch(
  context: CaseContext,
  extra: readonly ScriptStep[],
  plan: Omit<RunPlan, 'variant'>,
  check: (run: Run, first: number) => string[]
): Promise<string[]> {
  const launches = context.fixtures.cases.filter((fixture) => fixture.expected.case === 'C-01')
  if (launches.length === 0) return ['the fixture set has no C-01 launch fixture to drive']
  const out: string[] = []
  for (const fixture of launches) {
    for (const { variant, chunking, label } of replays(fixture)) {
      const script = [...fixture.expected.script, ...extra]
      const full: RunPlan = { ...plan, variant, chunking }
      const run = await runScript(context.factory, script, full, context.options)
      const why = [...run.failures, ...check(run, fixture.expected.script.length)]
      out.push(...why.map((line) => `${fixture.name} (${label}): ${line}`))
    }
  }
  return out
}

/**
 * Whether the driver has no handshake: readiness is the spawn plus the 3 s early-failure window
 * (`earlyFailure: 'exit-only'`, ADR-020 D4; 15 §3 rows A1, H1 and every `U→exit-only` row).
 */
function exitOnly(context: CaseContext): boolean {
  return !ceilingFrom(context.options).earlyFailure.includes('handshake')
}

/**
 * C-18 (15 §1.3 `events()`, CH-04): a transport EOF is `error{transport-lost}` then `exited` once.
 * The fixture transport's EOF is followed at once by the process exit. For a protocol driver that
 * still loses its transport before any goodbye; for an exit-only driver (a raw stdio program,
 * `stdio-raw`), its output closing with its exit is its normal end, so it reports only `exited`
 * (ISSUE-157 foreman decision 3: a normal "Other…" exit never toasts transport-lost). Its
 * output closing with no exit observed is the driver's own test.
 */
async function transportLoss(context: CaseContext): Promise<string[]> {
  const extra: ScriptStep[] = [
    { do: 'transportLost' },
    { do: 'sendTurn', messageId: 'after-loss', text: 'are you there' }
  ]
  const normalEnd = exitOnly(context)
  return overLaunch(context, extra, {}, (run, first) => {
    const out: string[] = []
    const events = run.events.slice(run.eventsAtStep[first])
    const exited = events.filter((event) => event.t === 'exited').length
    if (exited !== 1) out.push(`exited ${exited} times after the transport loss, not once`)
    if (events.at(-1)?.t !== 'exited') out.push('exited is not the last event')
    const lost = events.filter((e) => e.t === 'error' && e.cause.kind === 'transport-lost')
    const before = events.at(-2)
    if (normalEnd) {
      if (lost.length > 0) {
        out.push('an exit-only driver reported transport-lost for an EOF with its exit')
      }
    } else if (before?.t !== 'error' || before.cause.kind !== 'transport-lost') {
      out.push('no error transport-lost right before exited')
    }
    const send = run.outcomes[first + 1] as { rejected?: { kind?: string } } | null
    if (send?.rejected?.kind !== 'session-closed') {
      out.push(`sendTurn after the loss gave ${JSON.stringify(send)}, not rejected session-closed`)
    }
    return out
  })
}

/** 15 §0: `HANDSHAKE_TIMEOUT_MS` (30 000, configurable) and `EARLY_FAILURE_WINDOW_MS` (3 000). */
export const HANDSHAKE_TIMEOUT_MS = 30_000
export const EARLY_FAILURE_WINDOW_MS = 3_000
/** ADR-020 D1, D6: the output tail a launch failure carries, at most. */
const TAIL_LIMIT = 400

/** Runs `script` once with `plan` (no recorded bytes unless the plan's spawn gives some). */
async function overScript(
  context: CaseContext,
  script: readonly ScriptStep[],
  plan: Omit<RunPlan, 'variant'>,
  check: (run: Run) => string[]
): Promise<string[]> {
  const run = await runScript(context.factory, script, { ...plan, variant: null }, context.options)
  return [...run.failures, ...check(run)]
}

/** The `cause` and `toolOutputTail` a launch step rejected with, or why it did not reject. */
function launchFailure(
  run: Run,
  index: number
): { cause?: string; toolOutputTail?: string } | string {
  const outcome = run.outcomes[index] as {
    rejected?: { cause?: string; toolOutputTail?: string }
  } | null
  if (outcome?.rejected === undefined)
    return `launch gave ${JSON.stringify(outcome)}, not a rejection`
  return outcome.rejected
}

/** A spawn case needs a spawn to inspect; a driver that spawns nothing declares the case. */
function needsSpawn(run: Run, id: CaseId): string[] {
  return run.spawn.spawns.length > 0
    ? []
    : [`${id} found no spawn to inspect; a driver that spawns nothing declares ${id} inapplicable`]
}

const LAUNCH: ScriptStep = { do: 'launch' }

/** C-02 (ADR-008 item 1 and Verification): ENOENT is not-installed; only the install is spawned. */
async function notInstalled(context: CaseContext): Promise<string[]> {
  const enoent = await overScript(
    context,
    [LAUNCH],
    { spawn: () => ({ kind: 'fail', code: 'ENOENT' }) },
    (run) => {
      const failure = launchFailure(run, 0)
      if (typeof failure === 'string') return [`spawn ENOENT: ${failure}`]
      return failure.cause === 'not-installed'
        ? []
        : [`spawn ENOENT gave ${failure.cause}, not not-installed`]
    }
  )
  const own = await overLaunch(context, [], {}, (run) => {
    const binary = context.options.install.binaryPath
    return [
      ...needsSpawn(run, 'C-02'),
      ...run.spawn.spawns
        .filter((spawn) => spawn.executable !== binary)
        .map((spawn) => `spawned ${spawn.executable}, not the person's install ${binary}`)
    ]
  })
  return [...enoent, ...own]
}

/** C-03 (ADR-020 D4, D6): spawn refusals and a handshake timeout are could-not-start, tail ≤ 400. */
async function couldNotStart(context: CaseContext): Promise<string[]> {
  const timeout = context.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const verdict =
    (label: string) =>
    (run: Run): string[] => {
      const failure = launchFailure(run, 0)
      if (typeof failure === 'string') return [`${label}: ${failure}`]
      const out: string[] = []
      if (failure.cause !== 'could-not-start')
        out.push(`${label} gave ${failure.cause}, not could-not-start`)
      const tail = failure.toolOutputTail
      if (tail !== undefined && tail.length > TAIL_LIMIT) {
        out.push(
          `${label} carried an output tail of ${tail.length} characters, more than ${TAIL_LIMIT}`
        )
      }
      return out
    }
  const out: string[] = []
  for (const code of ['EACCES', 'EPERM', 'EINVAL'] as const) {
    const label = code === 'EINVAL' ? 'spawn EINVAL (a refused shim)' : `spawn ${code}`
    const plan = { spawn: (): SpawnScript => ({ kind: 'fail', code }) }
    out.push(...(await overScript(context, [LAUNCH], plan, verdict(label))))
  }
  const hung = {
    spawn: (): SpawnScript => ({
      kind: 'fixture',
      transport: new FixtureTransport({ received: '', format: 'jsonl', stderr: 'x'.repeat(1000) })
    })
  }
  // An exit-only driver has no handshake to time out: a silent, live process is ready at 3 s.
  if (exitOnly(context)) return out
  const script: ScriptStep[] = [LAUNCH, { do: 'advance', ms: timeout }]
  out.push(...(await overScript(context, script, hung, verdict('a handshake timeout'))))
  return out
}

/**
 * C-04 (15 §1.3 launch errors, ADR-020 D4): an exit before readiness inside 3 s is exited-at-once.
 * At 3 000 ms a handshake driver that never got ready is could-not-start; an exit-only driver is
 * ready at `t0 + 3 s`, so its launch has succeeded (15 §6 C-04 "exited-at-once / success").
 */
async function exitsAtOnce(context: CaseContext): Promise<string[]> {
  const out: string[] = []
  for (const at of [EARLY_FAILURE_WINDOW_MS - 1, EARLY_FAILURE_WINDOW_MS]) {
    const plan = {
      spawn: (): SpawnScript => ({ kind: 'exit', afterMs: at, code: 1, stderr: 'fatal' })
    }
    const script: ScriptStep[] = [LAUNCH, { do: 'advance', ms: EARLY_FAILURE_WINDOW_MS + 1 }]
    out.push(
      ...(await overScript(context, script, plan, (run) => {
        if (at === EARLY_FAILURE_WINDOW_MS && exitOnly(context)) {
          return differences(run.outcomes[0], { resolved: true }).length === 0
            ? []
            : [`exit at ${at} ms gave ${JSON.stringify(run.outcomes[0])}, not a launched session`]
        }
        const failure = launchFailure(run, 0)
        if (typeof failure === 'string') return [`exit at ${at} ms: ${failure}`]
        const want = at < EARLY_FAILURE_WINDOW_MS ? 'exited-at-once' : 'could-not-start'
        return failure.cause === want ? [] : [`exit at ${at} ms gave ${failure.cause}, not ${want}`]
      }))
    )
  }
  return out
}

/** Variables no provider child may receive (15 §4 `childEnv`; ADR-013 item 2, R5B-14; INV-59). */
const FORBIDDEN_CHILD_ENV = [
  'DWARFAI_DELEGATION_TOKEN',
  'DWARFAI_MCP_CREDENTIAL_FILE',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS'
]

/** C-23 (INV-59, ADR-013 item 2, ADR-017 item 3): no secret in any argv, env or frame. */
async function negativeSecrets(context: CaseContext): Promise<string[]> {
  // A driver that can inject the delegation MCP entry is checked on a gated delegation launch.
  const delegated = ceilingFrom(context.options).mcpInjection.some((value) => value !== 'none')
  return overLaunch(context, [], { delegation: delegated }, (run) => {
    const out = [...needsSpawn(run, 'C-23')]
    const spawnTag = run.launches[0]?.request.spawnTag
    for (const spawn of run.spawn.spawns) {
      for (const arg of spawn.args) {
        if (arg.includes(CANARY_TOKEN))
          out.push(`the delegation token is in the argv of ${spawn.executable}`)
      }
      for (const [name, value] of Object.entries(spawn.env)) {
        if (value.includes(CANARY_TOKEN))
          out.push(`the delegation token is in env ${name} of ${spawn.executable}`)
        const internal =
          name.startsWith('ELECTRON_') || (name.startsWith('DWARFAI_') && name !== 'DWARFAI_SPAWN')
        if (FORBIDDEN_CHILD_ENV.includes(name) || internal) {
          out.push(`env ${name} reached ${spawn.executable} (15 §4 childEnv is an allowlist)`)
        }
      }
      if (spawn.env.DWARFAI_SPAWN !== spawnTag) {
        out.push(
          `DWARFAI_SPAWN of ${spawn.executable} is ${String(spawn.env.DWARFAI_SPAWN)}, not ${String(spawnTag)}`
        )
      }
    }
    for (const frame of run.sent) {
      if (JSON.stringify(frame).includes(CANARY_TOKEN))
        out.push('the delegation token is in a sent frame')
    }
    return out
  })
}

/**
 * ADR-008 item 3: the flags and options that bypass the person's permission decisions. This
 * harness is the test that asserts their absence (ADR-008 Verification, static test).
 */
const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  'yoloMode',
  'acceptForSession',
  'allow_always',
  'reject_always'
]

/** C-24 (ADR-008 item 3): no forbidden flag or option in any argv, env or frame of a launch. */
async function forbiddenFlags(context: CaseContext): Promise<string[]> {
  return overLaunch(context, [], {}, (run) => {
    const out = [...needsSpawn(run, 'C-24')]
    const texts = [
      ...run.spawn.spawns.flatMap((spawn) => [...spawn.args, ...Object.values(spawn.env)]),
      ...run.sent.map((frame) => JSON.stringify(frame))
    ]
    for (const flag of FORBIDDEN_FLAGS) {
      if (texts.some((text) => text.includes(flag)))
        out.push(`the forbidden ${flag} appears in a launch`)
    }
    return out
  })
}

/** C-29 (15 §1.3 launch, §4 End / kill; R5A-24): onSpawned once, after spawn, before resolution. */
async function identityReport(context: CaseContext): Promise<string[]> {
  return overLaunch(context, [], {}, (run) => {
    const out: string[] = []
    const log = run.spawn.log
    const resolved = log.indexOf('launch-resolved')
    if (resolved === -1) return ['launch did not resolve']
    const before = log.slice(0, resolved).filter((mark) => mark.startsWith('onSpawned '))
    if (before.length !== 1)
      out.push(`onSpawned was called ${before.length} times before launch resolved`)
    const reported = log.filter((mark) => mark.startsWith('onSpawned ')).length
    if (reported > 1) out.push(`onSpawned was called ${reported} times`)
    const identity = run.launches[0]?.spawned[0]
    if (identity === undefined) return out
    const spawnMark = log.findIndex((mark) => mark.startsWith('spawn '))
    if (spawnMark !== -1) {
      if (spawnMark > log.indexOf(`onSpawned ${identity.pid}`))
        out.push('onSpawned came before the spawn')
      if (log[spawnMark] !== `spawn ${identity.pid}`)
        out.push('onSpawned reported another pid than the spawned root')
      if (run.spawn.isRunning(identity.pid) !== 'running')
        out.push(`the reported pid ${identity.pid} is not live`)
    } else if (
      !(Number.isInteger(identity.pid) && identity.pid > 0) ||
      !Number.isFinite(identity.processStartTimeMs) ||
      identity.bootId === ''
    ) {
      out.push(`onSpawned reported no live identity: ${JSON.stringify(identity)}`)
    }
    return out
  })
}

/**
 * C-19 (HO-37, ADR-006, 15 §1.5): every fixture replayed twice, and in every variant, yields the
 * same `sourceKey`s, so a second ingest adds zero rows.
 */
async function idempotentParse(context: CaseContext): Promise<string[]> {
  const out: string[] = []
  const harnessDriven = new Set(
    (Object.keys(CASES) as CaseId[]).filter((id) => CASES[id]?.harness !== undefined)
  )
  for (const fixture of context.fixtures.cases) {
    if (harnessDriven.has(fixture.expected.case as CaseId)) continue
    const plan = CASES[fixture.expected.case as CaseId]?.plan ?? {}
    const keysOf = async (variant: FixtureVariant): Promise<string[]> => {
      const run = await runScript(
        context.factory,
        fixture.expected.script,
        { ...plan, variant },
        context.options
      )
      return sourceKeysOf(run.events)
    }
    const [recorded, ...others] = fixture.variants
    if (recorded === undefined) continue
    const first = await keysOf(recorded)
    const again = await keysOf(recorded)
    if (JSON.stringify(first) !== JSON.stringify(again)) {
      const added = again.filter((key) => !first.includes(key))
      out.push(
        `${fixture.name}: sourceKeys differ on replay; the second replay adds ${JSON.stringify(added)}`
      )
    }
    for (const variant of others) {
      const keys = await keysOf(variant)
      if (JSON.stringify(keys) !== JSON.stringify(first)) {
        out.push(`${fixture.name} (${variant.label}): sourceKeys differ from the recorded variant`)
      }
    }
  }
  return out
}

/**
 * C-08 (15 §1.3 interrupt, ADR-021): after an interrupt, the open turn ends `interrupted` with
 * `cancelledFromApp`, and every ask still open resolves `cancelled`.
 */
function checkInterrupt(run: Run, fixture: FixtureCase): string[] {
  const out: string[] = []
  fixture.expected.script.forEach((step, index) => {
    if (step.do !== 'interrupt') return
    const at = run.eventsAtStep[index] as number
    const before = run.events.slice(0, at)
    const after = run.events.slice(at)
    const ended = new Set(before.flatMap((e) => (e.t === 'turn.ended' ? [e.end.turnKey] : [])))
    const turnOpen =
      before.some((e) => e.t === 'status' && e.value === 'working') &&
      before.filter((e) => e.t === 'status' && e.value === 'working').length > ended.size
    if (turnOpen) {
      const interrupted = after.filter(
        (e) => e.t === 'turn.ended' && e.end.kind === 'interrupted' && e.end.cancelledFromApp
      )
      if (interrupted.length !== 1) {
        out.push(
          `interrupt #${index}: ${interrupted.length} turn.ended interrupted with cancelledFromApp, not one`
        )
      }
    }
    const resolved = new Set(
      before.flatMap((e) => (e.t === 'ask.resolved' ? [e.providerRequestId] : []))
    )
    for (const event of before) {
      if (event.t !== 'ask.opened' || resolved.has(event.ask.providerRequestId)) continue
      const id = event.ask.providerRequestId
      if (
        !after.some(
          (e) => e.t === 'ask.resolved' && e.providerRequestId === id && e.by === 'cancelled'
        )
      ) {
        out.push(`interrupt #${index}: ask ${id} open at the interrupt is not resolved cancelled`)
      }
    }
  })
  return out
}

/** C-14 (ADR-010 item 5): a protocol error reply to an answer is `refused{channel-rejected}`. */
function checkRejected(run: Run, fixture: FixtureCase): string[] {
  return fixture.expected.script.flatMap((step, index) => {
    if (step.do !== 'answerPermission' && step.do !== 'answerQuestion') return []
    const outcome = run.outcomes[index]
    return differences(outcome, { kind: 'refused', reason: 'channel-rejected' }).length === 0
      ? []
      : [`answer #${index} gave ${JSON.stringify(outcome)}, not refused channel-rejected`]
  })
}

/**
 * C-25 / C-25b (ADR-009 D2, 15 §2.1): the session's effective capabilities equal the merge of the
 * ceiling with the protocol and probe sources combined field by field, so no field is above the
 * lower source and differing unordered values give the fail-closed value.
 */
function checkMerge(run: Run, fixture: FixtureCase, context: CaseContext): string[] {
  if (run.session === null) return ['no session to read the effective capabilities from']
  const probeStep = fixture.expected.script.findIndex((step) => step.do === 'probe')
  if (probeStep === -1) return ['the C-25 fixture has no probe step']
  const probe = run.outcomes[probeStep] as NegotiatedCapabilities
  const protocol = (fixture.expected.negotiated?.protocol ?? {}) as NegotiatedCapabilities
  const want = merge(ceilingFrom(context.options), combineLowest(protocol, probe))
  const actual = run.session.capabilities
  return (Object.keys(want) as (keyof ProviderCapabilities)[]).flatMap((field) =>
    JSON.stringify(actual[field]) === JSON.stringify(want[field])
      ? []
      : [
          `capability ${field} is ${JSON.stringify(actual[field])}, the merge gives ${JSON.stringify(want[field])}`
        ]
  )
}

/** The answer steps of a script, with their index. */
function answerSteps(fixture: FixtureCase): number[] {
  return fixture.expected.script.flatMap((step, index) =>
    step.do === 'answerPermission' || step.do === 'answerQuestion' ? [index] : []
  )
}

/** C-01 (15 §1.3 launch, ADR-009 D3): the launch resolves after readiness and binds the ref. */
function checkLaunch(run: Run, fixture: FixtureCase): string[] {
  const out: string[] = []
  fixture.expected.script.forEach((step, index) => {
    if (step.do !== 'launch') return
    const outcome = run.outcomes[index]
    if (differences(outcome, { resolved: true }).length > 0) {
      out.push(`launch #${index} gave ${JSON.stringify(outcome)}, not a session`)
    }
  })
  const ref = run.session?.ref
  if (ref === undefined) return [...out, 'no SessionRef was bound']
  if (ref.providerId !== run.driver.profile.id) {
    out.push(`the ref names provider ${ref.providerId}, not ${run.driver.profile.id}`)
  }
  if (ref.providerSessionId === '') out.push('the ref has no providerSessionId')
  return out
}

/** C-06 / C-07 (15 §2.7): an Allow or a Deny the provider took is `accepted`; a Deny keeps the turn. */
function checkDecision(decision: 'allow' | 'deny'): (run: Run, fixture: FixtureCase) => string[] {
  return (run, fixture) =>
    fixture.expected.script.flatMap((step, index) => {
      if (step.do !== 'answerPermission' || step.decision !== decision) return []
      const out: string[] = []
      if (differences(run.outcomes[index], { kind: 'accepted' }).length > 0) {
        out.push(`${decision} #${index} gave ${JSON.stringify(run.outcomes[index])}, not accepted`)
      }
      const after = run.events.slice(run.eventsAtStep[index])
      if (
        decision === 'deny' &&
        after.some((e) => e.t === 'turn.ended' && e.end.kind === 'interrupted')
      ) {
        out.push(`deny #${index} interrupted the turn; a Deny continues it (15 §2.7)`)
      }
      return out
    })
}

/** C-10 (OQ-42 B, ADR-010 item 3): an option set without `allow_once` reports `hasAllowOnce: false`. */
function checkNoAllowOnce(run: Run): string[] {
  return run.events.some(
    (e) => e.t === 'ask.opened' && e.ask.kind === 'permission' && !e.ask.options.hasAllowOnce
  )
    ? []
    : ['no ask.opened reports hasAllowOnce false']
}

/** C-12 (15 §1.4 ask.resolved): resolved elsewhere, and a later answer for it is ask-closed. */
function checkElsewhere(run: Run, fixture: FixtureCase): string[] {
  const elsewhere = run.events.flatMap((e) =>
    e.t === 'ask.resolved' && e.by === 'elsewhere' ? [e.providerRequestId] : []
  )
  if (elsewhere.length === 0) return ['no ask.resolved elsewhere']
  return answerSteps(fixture).flatMap((index) => {
    const step = fixture.expected.script[index] as { providerRequestId: string }
    const resolvedBefore = run.events
      .slice(0, run.eventsAtStep[index])
      .some((e) => e.t === 'ask.resolved' && e.providerRequestId === step.providerRequestId)
    if (!resolvedBefore) return []
    return differences(run.outcomes[index], { kind: 'refused', reason: 'ask-closed' }).length === 0
      ? []
      : [`an answer after ask.resolved elsewhere gave ${JSON.stringify(run.outcomes[index])}`]
  })
}

/** C-13 (ADR-010 item 5): a stale answer is ask-closed and sends nothing to the provider. */
function checkStale(run: Run, fixture: FixtureCase): string[] {
  const script = fixture.expected.script
  return answerSteps(fixture).flatMap((index) => {
    const out: string[] = []
    if (differences(run.outcomes[index], { kind: 'refused', reason: 'ask-closed' }).length > 0) {
      out.push(
        `stale answer #${index} gave ${JSON.stringify(run.outcomes[index])}, not refused ask-closed`
      )
    }
    const before = run.sentAtStep[index] as number
    const after =
      index + 1 < script.length ? (run.sentAtStep[index + 1] as number) : run.sent.length
    if (after !== before)
      out.push(`stale answer #${index} sent ${after - before} frames to the provider`)
    return out
  })
}

/** C-16 (15 §1.3 resume, ADR-015 item 7, ADR-006 item 1): same or new id; replay adds no key. */
function checkResume(run: Run, fixture: FixtureCase): string[] {
  const at = fixture.expected.script.findIndex((step) => step.do === 'resume')
  if (at === -1) return ['the C-16 fixture has no resume step']
  const before = run.launches.length > 0 ? run.bindings : {}
  const previous = (before as Record<string, string>).session
  const ref = run.session?.ref
  const out: string[] = []
  if (ref === undefined) return ['resume bound no session']
  if (ref.providerSessionId !== previous && ref.previousProviderSessionId !== previous) {
    out.push(
      `resume minted ${ref.providerSessionId} without previousProviderSessionId ${String(previous)}`
    )
  }
  // The replay is what the resumed session reports before the script acts on it again: up to the
  // first step after the resume that is not a clock advance (a later turn's keys are new).
  const steps = fixture.expected.script
  const next = steps.findIndex((step, index) => index > at && step.do !== 'advance')
  const known = new Set(sourceKeysOf(run.events.slice(0, run.eventsAtStep[at])))
  const replayed = run.events
    .slice(run.eventsAtStep[at], next === -1 ? undefined : run.eventsAtStep[next])
    .filter((e) => e.t === 'message')
  for (const key of sourceKeysOf(replayed)) {
    if (!known.has(key)) out.push(`the resume replay adds a new key ${key}`)
  }
  return out
}

/** C-17 (15 §1.3 adopt, ADR-010 item 11): pending asks are re-listed with the same id. */
function checkAdopt(run: Run, fixture: FixtureCase): string[] {
  const at = fixture.expected.script.findIndex((step) => step.do === 'adopt')
  if (at === -1) return ['the C-17 fixture has no adopt step']
  const opened = (events: readonly DriverEvent[]): string[] =>
    events.flatMap((e) => (e.t === 'ask.opened' ? [e.ask.providerRequestId] : []))
  const before = new Set(opened(run.events.slice(0, run.eventsAtStep[at])))
  return opened(run.events.slice(run.eventsAtStep[at]))
    .filter((id) => !before.has(id))
    .map((id) => `adopt re-listed ${id}, which was never pending before`)
}

const TURN_END_KINDS = new Set(['concluded', 'capped', 'errored', 'interrupted'])

/** C-20 (ADR-021 items 1, 5): every end maps to a kind; reliable needs `turnEnd`; errored has detail. */
function checkTurnEnds(run: Run, _fixture: FixtureCase, context: CaseContext): string[] {
  const reliable = run.session?.capabilities.turnEnd === 'reliable'
  void context
  return run.events.flatMap((e) => {
    if (e.t !== 'turn.ended') return []
    const out: string[] = []
    if (!TURN_END_KINDS.has(e.end.kind))
      out.push(`turn.ended kind ${e.end.kind} is not an ADR-021 kind`)
    if (e.end.reliability === 'reliable' && !reliable)
      out.push('turn.ended is reliable while turnEnd is none')
    if (e.end.kind === 'errored' && (e.end.detail ?? '') === '')
      out.push('turn.ended errored carries no detail')
    return out
  })
}

/** C-21 (ADR-006 items 4, 6): one sealed observation per unitKey, at the session's fidelity. */
function checkUsage(run: Run): string[] {
  const sealed = new Map<string, number>()
  const fidelity = run.session?.capabilities.usage.fidelity ?? 0
  const out: string[] = []
  for (const e of run.events) {
    if (e.t !== 'usage') continue
    if (e.observation.sealed)
      sealed.set(e.observation.unitKey, (sealed.get(e.observation.unitKey) ?? 0) + 1)
    if (e.observation.fidelity > fidelity)
      out.push(`usage ${e.observation.unitKey} claims fidelity above ${fidelity}`)
  }
  for (const [unit, count] of sealed)
    if (count > 1) out.push(`usage unit ${unit} is sealed ${count} times`)
  if (!run.events.some((e) => e.t === 'usage')) out.push('the usage fixture yields no usage')
  return out
}

/** C-22 (ADR-011 item 2, Verification): a policy-only launch carries the deny policy's argv. */
function checkPolicyOnly(run: Run, _fixture: FixtureCase, context: CaseContext): string[] {
  const mode = context.options.policyOnlyMode
  if (mode === undefined) return ['no policyOnlyMode in the options to launch with']
  const args = run.spawn.spawns.flatMap((spawn) => spawn.args)
  return (mode.providerArgs.argv ?? [])
    .filter((arg) => !args.includes(arg))
    .map((arg) => `the policy-only launch lacks ${arg}`)
}

/** C-26 (ADR-009 D4, SP-08): help output without the prompt-tool flag gives `launch: false`. */
function checkProbeGate(run: Run, fixture: FixtureCase): string[] {
  return fixture.expected.script.flatMap((step, index) => {
    if (step.do !== 'probe') return []
    const probed = run.outcomes[index] as { launch?: boolean } | null
    return probed?.launch === false
      ? []
      : [`probe #${index} gave launch ${String(probed?.launch)}, not false`]
  })
}

/** C-27 (ADR-011 item 7, 15 §2.1): the gate off / on-unverified / on-verified → none / none / merge. */
async function integrationGate(context: CaseContext): Promise<string[]> {
  const run = await runScript(
    context.factory,
    [{ do: 'probe' }],
    { variant: null },
    context.options
  )
  const probe = run.outcomes[0] as NegotiatedCapabilities
  const ceiling = ceilingFrom(context.options)
  const open = merge(ceiling, combineLowest(probe)).permission
  const want: Record<IntegrationState, ProviderCapabilities['permission']> = {
    off: 'none',
    'on-unverified': 'none',
    'on-verified': open
  }
  return (Object.keys(want) as IntegrationState[]).flatMap((state) => {
    const got = merge(ceiling, negotiatedFor([probe], state)).permission
    return got === want[state] ? [] : [`gate ${state} gives permission ${got}, not ${want[state]}`]
  })
}

/** C-28 (15 §1.3 close, ADR-014): a CloseOutcome per mode; a second close is closed; no signal. */
function checkClose(run: Run, fixture: FixtureCase): string[] {
  const out: string[] = []
  let ended = false
  fixture.expected.script.forEach((step, index) => {
    if (step.do !== 'close') return
    const outcome = run.outcomes[index] as { kind?: string; reason?: string } | null
    const valid =
      outcome?.kind === 'closed' ||
      (outcome?.kind === 'failed' &&
        ['protocol-error', 'unsupported', 'timeout'].includes(outcome.reason ?? ''))
    if (!valid) out.push(`close #${index} gave ${JSON.stringify(outcome)}, not a CloseOutcome`)
    if (step.mode === 'end-thread' && ended && outcome?.kind !== 'closed') {
      out.push(`a second close #${index} gave ${JSON.stringify(outcome)}, not closed`)
    }
    if (step.mode === 'end-thread' && outcome?.kind === 'closed') ended = true
  })
  if (run.spawn.killTreeCalls > 0 || run.spawn.fake.signals.length > 0) {
    out.push("the driver signalled a process; the kill is ADR-014's, never the driver's")
  }
  return out
}

/** C-15 (ADR-010 item 8, CH-05): an unacknowledged answer is `channel-unavailable` at 30 s. */
function checkHandover(run: Run, fixture: FixtureCase): string[] {
  const out: string[] = []
  const script = fixture.expected.script
  script.forEach((step, index) => {
    if (step.do !== 'answerPermission' && step.do !== 'answerQuestion') return
    const start = run.clockAtStep[index] as number
    let reached = false
    for (let later = index + 1; later < script.length; later++) {
      const elapsed = (run.clockAtStep[later] as number) - start
      if (elapsed >= HANDOVER_MS) reached = true
      else if (!(run.pendingAtStep[later] ?? []).includes(index)) {
        out.push(`answer #${index} settled before ${elapsed + 1} ms, inside the 30 s hand-over`)
        return
      }
    }
    if (!reached && script.at(-1)?.do === 'advance') {
      const last = script.length - 1
      reached =
        (run.clockAtStep[last] as number) + (script[last] as { ms: number }).ms - start >=
        HANDOVER_MS
    }
    if (!reached) out.push(`the script never reaches 30 s after answer #${index}`)
    const outcome = run.outcomes[index]
    if (differences(outcome, { kind: 'refused', reason: 'channel-unavailable' }).length > 0) {
      out.push(
        `answer #${index} gave ${JSON.stringify(outcome)}, not refused channel-unavailable at 30 s`
      )
    }
  })
  return out
}

/** C-05 (15 §1.3 sendTurn, §1.4): the echo, one turn.ended per turn, working then idle. */
function checkSendTurn(run: Run, fixture: FixtureCase): string[] {
  const out: string[] = []
  fixture.expected.script.forEach((step, index) => {
    if (step.do !== 'sendTurn') return
    const receipt = run.outcomes[index] as { correlation?: string } | null
    const after = run.events.slice(run.eventsAtStep[index])
    if (typeof receipt?.correlation !== 'string' || receipt.correlation === '') {
      out.push(`sendTurn #${index} resolved no echo correlation`)
    } else if (!after.some((e) => e.t === 'message' && e.record.echoOf === receipt.correlation)) {
      out.push(`sendTurn #${index}: no message echoes its correlation ${receipt.correlation}`)
    }
    const first = after.find((e) => e.t === 'status')
    if (first?.t !== 'status' || first.value !== 'working') {
      out.push(`sendTurn #${index}: the turn did not start with status working`)
    }
    const ended = after.findIndex((e) => e.t === 'turn.ended')
    if (ended === -1) out.push(`sendTurn #${index}: no turn.ended`)
    else {
      const next = after.slice(ended + 1).find((e) => e.t === 'status')
      if (next?.t !== 'status' || next.value !== 'idle') {
        out.push(`sendTurn #${index}: no status idle after its turn.ended`)
      }
    }
  })
  return out
}

const noPermissionAsk = askChannelClosed(['permission'])
const noQuestionAsk = askChannelClosed(['question'])
const noAsk = askChannelClosed(['permission', 'question'])

/** The 29 cases of 15 §6 (C-25b runs under C-25); each title is its Expected column in plain words. */
const CASES: Record<CaseId, CaseDefinition> = {
  'C-01': {
    title: 'launch resolves only after readiness and binds the ref',
    check: checkLaunch,
    failClosed: capabilityIs('launch', (value) => value === false)
  },
  'C-02': {
    title: "a spawn ENOENT is not-installed and no process starts but the person's install",
    harness: notInstalled,
    failClosed: spawnsNothing
  },
  'C-03': {
    title:
      'a spawn refusal, a refused shim or a handshake timeout is could-not-start with an output tail of at most 400 characters',
    harness: couldNotStart,
    failClosed: spawnsNothing
  },
  'C-04': {
    title: 'an exit 2 999 ms after spawn is exited-at-once and an exit at 3 000 ms is not',
    harness: exitsAtOnce,
    failClosed: spawnsNothing
  },
  'C-05': {
    title:
      'one prompt yields its echo with echoOf, activity, turn.ended once and status working then idle',
    check: checkSendTurn,
    failClosed: capabilityIs('sendTurn', (value) => value === false)
  },
  'C-06': {
    title: 'Allow answers allow_once, never allow_always, and is accepted',
    check: checkDecision('allow'),
    failClosed: noPermissionAsk
  },
  'C-07': {
    title: 'Deny answers reject_once or decline, is accepted, and the turn continues',
    check: checkDecision('deny'),
    failClosed: noPermissionAsk
  },
  'C-08': {
    title:
      'interrupt ends the open turn interrupted with cancelledFromApp and resolves the open asks cancelled',
    check: checkInterrupt,
    failClosed: capabilityIs('interrupt', (value) => value === false)
  },
  'C-09': {
    title:
      'question answers map per 15 §2.7, a decline sends the provider decline and an empty answers array is not a decline',
    failClosed: noQuestionAsk
  },
  'C-10': {
    title: 'an option set without allow_once opens the ask with hasAllowOnce false',
    check: checkNoAllowOnce,
    failClosed: noPermissionAsk
  },
  'C-11': {
    title:
      'an unknown or malformed request is answered with a protocol error or Deny and opens no ask',
    failClosed: noAsk
  },
  'C-12': {
    title: 'an ask answered elsewhere resolves elsewhere and a later answer is refused ask-closed',
    check: checkElsewhere,
    failClosed: capabilityIs('answeredElsewhere', (value) => value === false)
  },
  'C-13': {
    title: 'a stale answer is refused ask-closed and nothing is sent to the provider',
    check: checkStale,
    failClosed: noAsk
  },
  'C-14': {
    title: 'a protocol error reply to an answer is refused channel-rejected',
    check: checkRejected,
    failClosed: noAsk
  },
  'C-15': {
    title: 'an answer the provider never acknowledges is channel-unavailable at 30 s',
    check: checkHandover,
    plan: { hangBeforeAnswers: true },
    failClosed: noAsk
  },
  'C-16': {
    title:
      'resume keeps the id or names previousProviderSessionId, and replayed messages add no new key',
    check: checkResume,
    failClosed: capabilityIs('resume', (value) => value === 'none')
  },
  'C-17': {
    title:
      'adopt re-lists pending asks with the same providerRequestId, or is null when the session is gone',
    check: checkAdopt,
    failClosed: capabilityIs('adopt', (value) => value === false)
  },
  'C-18': {
    title: 'a transport EOF yields error transport-lost then exited once',
    harness: transportLoss
  },
  'C-19': {
    title: 'every fixture replayed twice, in every variant, yields identical sourceKeys',
    harness: idempotentParse
  },
  'C-20': {
    title:
      'every provider turn-end value maps to an ADR-021 kind, and an unknown one is errored with detail',
    check: checkTurnEnds,
    failClosed: capabilityIs('turnEnd', (value) => value === 'none')
  },
  'C-21': {
    title: 'usage yields one sealed observation per unitKey',
    check: checkUsage,
    failClosed: capabilityIs('usage', (value) => (value as { fidelity: number }).fidelity === 0)
  },
  'C-22': {
    title: 'a policy-only launch carries the deny policy and the question-tool removal',
    check: checkPolicyOnly,
    failClosed: async (context) =>
      context.options.policyOnlyMode === undefined
        ? []
        : ['a policy-only mode is offered (options.policyOnlyMode)']
  },
  'C-23': {
    title:
      'no credential value or delegation token is in any captured argv, env or frame, and DWARFAI_SPAWN is in the provider child env',
    harness: negativeSecrets,
    failClosed: spawnsNothing
  },
  'C-24': {
    title: 'no forbidden auto-approve flag or option appears in any launch',
    harness: forbiddenFlags,
    failClosed: spawnsNothing
  },
  'C-25': {
    title:
      'capabilities are the ADR-009 D2 merge of the ceiling with the protocol and probe sources, never above the lower one (C-25b)',
    check: checkMerge
  },
  'C-26': {
    title: 'help output without --permission-prompt-tool makes stream-json launch false',
    check: checkProbeGate,
    plan: { helpOutput: true },
    failClosed: async (context) => {
      const run = await runScript(context.factory, [], { variant: null }, context.options)
      return run.driver.transport === 'stream-json' ? ['the driver is a stream-json driver'] : []
    }
  },
  'C-27': {
    title:
      'the integration gate off, on-unverified and on-verified gives permission none, none and the merged value',
    harness: integrationGate,
    failClosed: async (context) => {
      const run = await runScript(context.factory, [], { variant: null }, context.options)
      const gate = run.driver.profile.answerChannelGate
      return gate === undefined ? [] : [`the profile is gated by ${gate}`]
    }
  },
  'C-28': {
    title:
      'close resolves its CloseOutcome, a second close is closed, and the driver signals no process',
    check: checkClose
  },
  'C-29': {
    title: 'onSpawned is called exactly once after spawn and before launch resolves',
    harness: identityReport
  }
}

/** Every case id, C-01 … C-29, in order. */
export const CASE_IDS: readonly CaseId[] = Object.keys(CASES).sort() as CaseId[]

/** Runs one case against a driver and returns its verdict. */
export async function runCase(
  id: CaseId,
  factory: DriverFactory,
  fixtures: FixtureSet,
  options: ConformanceOptions
): Promise<CaseVerdict> {
  const definition = CASES[id]
  const caseFactory = options.caseFactories?.[id] ?? factory
  const context: CaseContext = { factory: caseFactory, fixtures, options }
  const verdict = (failures: readonly string[]): CaseVerdict => ({
    ok: failures.length === 0,
    failures
  })
  const declared = options.cases?.[id]
  if (declared !== undefined) {
    // TC-144-04: a declared case is asserted at its fail-closed value, never skipped.
    if (definition.failClosed === undefined) {
      return verdict([`${id} applies to every driver; it cannot be declared inapplicable`])
    }
    const why = await definition.failClosed(context)
    return verdict(
      why.map((line) => `${id} is declared inapplicable (${declared.inapplicable}) but ${line}`)
    )
  }
  if (definition.harness !== undefined) return verdict(await definition.harness(context))
  const own = fixtures.cases.filter((fixture) => fixture.expected.case === id)
  const failures: string[] = []
  if (own.length === 0) {
    failures.push(
      `${id} has no fixture in ${fixtures.provider}/${fixtures.driver} and is not declared inapplicable`
    )
  }
  for (const fixture of own) {
    for (const { variant, chunking, label } of replays(fixture)) {
      const plan: RunPlan = { ...definition.plan, variant, chunking }
      const run = await runScript(caseFactory, fixture.expected.script, plan, options)
      const why = [
        ...againstExpected(run, fixture),
        ...(definition.check?.(run, fixture, context) ?? [])
      ]
      failures.push(...why.map((line) => `${fixture.name} (${label}): ${line}`))
    }
  }
  return verdict(failures)
}

/** The case's test title, `[C-nn] <15 §6 Expected column in plain words>`. */
export function caseTitle(id: CaseId): string {
  return `[${id}] ${CASES[id].title}`
}

/** Registers one test per case, C-01 … C-29; each fails with the verdict's reasons. */
export function driverConformance(
  name: string,
  factory: DriverFactory,
  fixtures: FixtureSet,
  options: ConformanceOptions
): void {
  describe(name, () => {
    for (const id of CASE_IDS) {
      it(caseTitle(id), async () => {
        const verdict = await runCase(id, factory, fixtures, options)
        expect(verdict.failures).toEqual([])
      })
    }
  })
}
