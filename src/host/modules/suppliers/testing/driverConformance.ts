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
import type {
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  InstalledProvider,
  ProviderDriver
} from '../ports/providerDriver'
import { bind, compareEvents, differences, type Bindings, type Json } from './expected'
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
        const launched = launchRequest(step, options, run.launches.length)
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
          clock.advance(ready - 1)
          await settle()
          if (launch.state !== 'pending') {
            run.failures.push(`launch settled ${ready - 1} ms after spawn, before readiness`)
          }
          clock.advance(1)
          await settle()
        }
        if (launch.state === 'resolved') bindSession(launch.value as DriverSession)
        await settle()
        break
      }
      case 'advance':
        clock.advance(step.ms)
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
  options: ConformanceOptions,
  index: number
): DriverLaunchRequest {
  const launchId = step.launchId ?? `launch-${index + 1}`
  return {
    launchId: launchId as DriverLaunchRequest['launchId'],
    install: options.install,
    cwd: '/work/mine' as DriverLaunchRequest['cwd'],
    prompt: step.prompt ?? 'first prompt',
    permissionMode: null,
    delegation: null,
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
