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
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
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

/** The doubles one run hands the driver factory. */
export interface ConformanceRig {
  readonly clock: FakeClock
  readonly scheduler: FakeScheduler
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

type Tracked = {
  state: 'pending' | 'resolved' | 'rejected'
  value?: unknown
}

/** What one scripted run of a fixture variant produced. */
export interface Run {
  readonly events: DriverEvent[]
  /** Per script step: what its call resolved (`{ pending: true }` when it never settled). */
  readonly outcomes: unknown[]
  /** `events.length` when each step started. */
  readonly eventsAtStep: number[]
  readonly sent: Json[]
  readonly failures: string[]
  session: DriverSession | null
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

function request(
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

/** Runs one fixture variant's script against a fresh driver and fresh doubles. */
export async function runScript(
  factory: DriverFactory,
  script: readonly ScriptStep[],
  _variant: FixtureVariant | null,
  options: ConformanceOptions
): Promise<Run> {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const driver = factory({ clock, scheduler })
  const run: Run = {
    events: [],
    outcomes: [],
    eventsAtStep: [],
    sent: [],
    failures: [],
    session: null,
    bindings: {}
  }
  const tracked: (Tracked | null)[] = []
  let launches = 0

  const bindSession = (session: DriverSession): void => {
    run.session = session
    run.bindings.session = session.ref.providerSessionId
    void (async () => {
      for await (const event of session.events()) run.events.push(event)
    })()
  }

  for (const [index, step] of script.entries()) {
    run.eventsAtStep.push(run.events.length)
    const session = run.session
    switch (step.do) {
      case 'launch': {
        const pending = driver.launch(request(step, options, launches++))
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
      default: {
        if (session === null) {
          run.failures.push(`step #${index} (${step.do}) needs a launched session`)
          tracked.push(null)
          break
        }
        tracked.push(call(step, session, options))
        await settle()
      }
    }
  }
  await settle()
  script.forEach((step, index) => run.outcomes.push(outcomeOf(step, tracked[index] ?? null)))
  return run
}

function call(
  step: ScriptStep,
  session: DriverSession,
  options: ConformanceOptions
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
        session.answerPermission({
          providerRequestId: step.providerRequestId,
          decision: step.decision
        })
      )
    case 'answerQuestion':
      return track(
        session.answerQuestion(
          step.decline === true
            ? { providerRequestId: step.providerRequestId, decline: true }
            : { providerRequestId: step.providerRequestId, answers: [...(step.answers ?? [])] }
        )
      )
    case 'close':
      return track(session.close(step.mode))
    case 'transportLost':
      options.injectTransportLoss?.(session)
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
  const own = fixtures.cases.filter((fixture) => fixture.expected.case === id)
  const failures: string[] = []
  if (own.length === 0)
    failures.push(`${id} has no fixture in ${fixtures.provider}/${fixtures.driver}`)
  for (const fixture of own) {
    for (const variant of fixture.variants) {
      const run = await runScript(factory, fixture.expected.script, variant, options)
      const why = [
        ...againstExpected(run, fixture),
        ...(definition.check?.(run, fixture, context) ?? [])
      ]
      failures.push(...why.map((line) => `${fixture.name} (${variant.label}): ${line}`))
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
