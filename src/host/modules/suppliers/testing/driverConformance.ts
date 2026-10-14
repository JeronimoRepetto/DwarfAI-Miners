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
import type { ProviderCapabilities } from '../domain/capabilities'
import { combineLowest, merge, type NegotiatedCapabilities } from '../domain/mergeCapabilities'
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
  /** The catalog ceiling of the driver's provider (ADR-009 D1). */
  readonly ceiling: ProviderCapabilities
  /** The install every launch names (ADR-008 item 1: the only executable it may spawn). */
  readonly install: InstalledProvider
  /** Cases the driver's capabilities make inapplicable, each with its reason. */
  readonly cases?: Partial<Record<CaseId, { readonly inapplicable: string }>>
  /** CH-04 for a driver with no fixture transport: drop its transport before an exit. */
  readonly injectTransportLoss?: (session: DriverSession) => void
  /** The driver's `HANDSHAKE_TIMEOUT_MS` when it is configured away from 15 §0's 30 000. */
  readonly handshakeTimeoutMs?: number
  /** The provider's policy-only permission mode (ADR-011 item 1), for C-22. */
  readonly policyOnlyMode?: PermissionModeSpec
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
}

/** What one scripted run of a fixture variant produced. */
export interface Run {
  readonly events: DriverEvent[]
  /** Per script step: what its call resolved (`{ pending: true }` when it never settled). */
  readonly outcomes: unknown[]
  /** `events.length`, the clock and the steps still pending, when each step started. */
  readonly eventsAtStep: number[]
  readonly clockAtStep: number[]
  readonly pendingAtStep: number[][]
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
    const transport = new FixtureTransport({
      received: variant?.received ?? '',
      format: variant?.format ?? 'jsonl',
      ...(variant?.gates === undefined ? {} : { gates: variant.gates }),
      ...(plan.chunking === undefined ? {} : { chunking: plan.chunking }),
      ...(variant?.streams.stderr === undefined ? {} : { stderr: variant.streams.stderr })
    })
    transports.push(transport)
    return { kind: 'fixture', transport }
  }
  const spawn = new RecordingSpawn({
    clock,
    scheduler,
    decide: (spec) => (plan.spawn === undefined ? fixture() : plan.spawn(spec, fixture))
  })
  const driver = factory({ clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV })
  const run: Run = {
    events: [],
    outcomes: [],
    eventsAtStep: [],
    clockAtStep: [],
    pendingAtStep: [],
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
    run.bindings.session = session.ref.providerSessionId
    void (async () => {
      for await (const event of session.events()) run.events.push(event)
    })()
  }

  for (const [index, step] of script.entries()) {
    run.eventsAtStep.push(run.events.length)
    run.clockAtStep.push(clock.now())
    run.pendingAtStep.push(tracked.flatMap((entry, at) => (entry?.state === 'pending' ? [at] : [])))
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
  const mechanism = options.ceiling.mcpInjection
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

/** The differences between a run and its fixture's expected events, outcomes and frames. */
function againstExpected(run: Run, fixture: FixtureCase): string[] {
  const expected = fixture.expected
  const bindings: Bindings = run.bindings
  const out = [...run.failures, ...compareEvents(run.events, expected.events ?? [], bindings)]
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

/** C-18 (15 §1.3 `events()`, CH-04): a transport EOF is `error{transport-lost}` then `exited` once. */
async function transportLoss(context: CaseContext): Promise<string[]> {
  const extra: ScriptStep[] = [
    { do: 'transportLost' },
    { do: 'sendTurn', messageId: 'after-loss', text: 'are you there' }
  ]
  return overLaunch(context, extra, {}, (run, first) => {
    const out: string[] = []
    const events = run.events.slice(run.eventsAtStep[first])
    const exited = events.filter((event) => event.t === 'exited').length
    if (exited !== 1) out.push(`exited ${exited} times after the transport loss, not once`)
    if (events.at(-1)?.t !== 'exited') out.push('exited is not the last event')
    const before = events.at(-2)
    if (before?.t !== 'error' || before.cause.kind !== 'transport-lost') {
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
  const script: ScriptStep[] = [LAUNCH, { do: 'advance', ms: timeout }]
  out.push(...(await overScript(context, script, hung, verdict('a handshake timeout'))))
  return out
}

/** C-04 (15 §1.3 launch errors, ADR-020 D4): an exit before readiness inside 3 s is exited-at-once. */
async function exitsAtOnce(context: CaseContext): Promise<string[]> {
  const out: string[] = []
  for (const at of [EARLY_FAILURE_WINDOW_MS - 1, EARLY_FAILURE_WINDOW_MS]) {
    const plan = {
      spawn: (): SpawnScript => ({ kind: 'exit', afterMs: at, code: 1, stderr: 'fatal' })
    }
    const script: ScriptStep[] = [LAUNCH, { do: 'advance', ms: EARLY_FAILURE_WINDOW_MS + 1 }]
    out.push(
      ...(await overScript(context, script, plan, (run) => {
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
  const delegated = context.options.ceiling.mcpInjection !== 'none'
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
  const want = merge(context.options.ceiling, combineLowest(protocol, probe))
  const actual = run.session.capabilities
  return (Object.keys(want) as (keyof ProviderCapabilities)[]).flatMap((field) =>
    JSON.stringify(actual[field]) === JSON.stringify(want[field])
      ? []
      : [
          `capability ${field} is ${JSON.stringify(actual[field])}, the merge gives ${JSON.stringify(want[field])}`
        ]
  )
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

const CASES: Partial<Record<CaseId, CaseDefinition>> = {
  'C-05': {
    title:
      'one prompt yields its echo with echoOf, activity, turn.ended once and status working then idle',
    check: checkSendTurn
  },
  'C-15': {
    title: 'an answer the provider never acknowledges is channel-unavailable at 30 s',
    check: checkHandover,
    plan: { hangBeforeAnswers: true }
  },
  'C-18': {
    title: 'a transport EOF yields error transport-lost then exited once',
    harness: transportLoss
  },
  'C-02': {
    title: "a spawn ENOENT is not-installed and no process starts but the person's install",
    harness: notInstalled
  },
  'C-03': {
    title:
      'a spawn refusal, a refused shim or a handshake timeout is could-not-start with an output tail of at most 400 characters',
    harness: couldNotStart
  },
  'C-04': {
    title: 'an exit 2 999 ms after spawn is exited-at-once and an exit at 3 000 ms is not',
    harness: exitsAtOnce
  },
  'C-23': {
    title:
      'no credential value or delegation token is in any captured argv, env or frame, and DWARFAI_SPAWN is in the provider child env',
    harness: negativeSecrets
  },
  'C-24': {
    title: 'no forbidden auto-approve flag or option appears in any launch',
    harness: forbiddenFlags
  },
  'C-29': {
    title: 'onSpawned is called exactly once after spawn and before launch resolves',
    harness: identityReport
  },
  'C-08': {
    title:
      'interrupt ends the open turn interrupted with cancelledFromApp and resolves the open asks cancelled',
    check: checkInterrupt
  },
  'C-14': {
    title: 'a protocol error reply to an answer is refused channel-rejected',
    check: checkRejected
  },
  'C-19': {
    title: 'every fixture replayed twice, in every variant, yields identical sourceKeys',
    harness: idempotentParse
  },
  'C-25': {
    title:
      'capabilities are the ADR-009 D2 merge of the ceiling with the protocol and probe sources, never above the lower one (C-25b)',
    check: checkMerge
  }
}

/** Runs one case against a driver and returns its verdict. */
export async function runCase(
  id: CaseId,
  factory: DriverFactory,
  fixtures: FixtureSet,
  options: ConformanceOptions
): Promise<CaseVerdict> {
  const definition = CASES[id]
  if (definition === undefined) return { ok: false, failures: [`${id} is not defined`] }
  const context: CaseContext = { factory, fixtures, options }
  if (definition.harness !== undefined) {
    const failures = await definition.harness(context)
    return { ok: failures.length === 0, failures }
  }
  const own = fixtures.cases.filter((fixture) => fixture.expected.case === id)
  const failures: string[] = []
  if (own.length === 0)
    failures.push(`${id} has no fixture in ${fixtures.provider}/${fixtures.driver}`)
  for (const fixture of own) {
    for (const { variant, chunking, label } of replays(fixture)) {
      const plan: RunPlan = { ...definition.plan, variant, chunking }
      const run = await runScript(factory, fixture.expected.script, plan, options)
      const why = [
        ...againstExpected(run, fixture),
        ...(definition.check?.(run, fixture, context) ?? [])
      ]
      failures.push(...why.map((line) => `${fixture.name} (${label}): ${line}`))
    }
  }
  return { ok: failures.length === 0, failures }
}

/** The case's test title, `[C-nn] <15 §6 Expected column in plain words>`. */
export function caseTitle(id: CaseId): string {
  return `[${id}] ${CASES[id]?.title ?? 'undefined case'}`
}

/** Registers one test per case; each fails with the verdict's reasons. */
export function driverConformance(
  name: string,
  factory: DriverFactory,
  fixtures: FixtureSet,
  options: ConformanceOptions
): void {
  describe(name, () => {
    for (const id of Object.keys(CASES) as CaseId[]) {
      it(caseTitle(id), async () => {
        const verdict = await runCase(id, factory, fixtures, options)
        expect(verdict.failures).toEqual([])
      })
    }
  })
}
