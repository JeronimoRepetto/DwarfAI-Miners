// L4 conformance of the Antigravity `ndjson` driver (15 §4.8, §6; 17 §1.4, §2.3), development
// builds only (ADR-009 D6). The fixture set is `fixtures/antigravity/ndjson/1.1.26-synthetic/`:
// the re-homed, sanitized agy 1.1.26 held-stream lines plus hand-written cases, with a real
// recording pending (owner waiver 2026-10-18; its `meta.json` says which part is which). Every
// `*.expected.json` is written by hand from the contract. Then the driver's own cases (ISSUE-156
// "Tests to write FIRST" item 2) and its security negatives.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord, PermissionModeSpec } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type {
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  InstalledProvider,
  SessionRef
} from '../../../ports/providerDriver'
import {
  CANARY_TOKEN,
  LOGIN_ENV,
  driverConformance,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory
} from '../../../testing/driverConformance'
import { bind, compareEvents, differences, sourceKeysOf } from '../../../testing/expected'
import { readFixtureSet, type FixtureCase, type FixtureVariant } from '../../../testing/fixtureSet'
import { FixtureTransport } from '../../../testing/fixtureTransport'
import { RecordingSpawn, type SpawnScript } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS, publicLaunchOf } from '../../catalog/profiles'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import {
  AntigravityNdjsonDriver,
  type AntigravityNdjsonDriverDeps
} from './AntigravityNdjsonDriver'
import { buildArgv } from './argv'
import { capabilitiesFromHelp } from './capabilities'

const FIXTURES = fileURLToPath(
  new URL('../../../../../../../fixtures/antigravity/ndjson/1.1.26-synthetic/', import.meta.url)
)
const fixtures = readFixtureSet(FIXTURES)

const ANTIGRAVITY = CATALOG_RECORDS.find(
  (record) => record.profile.id === 'antigravity'
) as CatalogRecord

const INSTALL: InstalledProvider = {
  providerId: ANTIGRAVITY.profile.id,
  binaryPath: '/home/j/.local/bin/agy',
  version: '1.1.26',
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** The argv of every launch: stream-json in and out, nothing else (15 §4.8). */
const LAUNCH_ARGV = ['--input-format', 'stream-json', '--output-format', 'stream-json']
/** The print-mode flags, which take the prompt as their value (15 §4.8): never passed. */
const PRINT_FLAGS = ['-p', '--print', '--prompt', '-i', '--prompt-interactive']

type ResumeContext = NonNullable<AntigravityNdjsonDriverDeps['resumeContext']>

function factoryWith(resumeContext?: ResumeContext): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('agy', { path: INSTALL.binaryPath, version: '1.1.26' })
    return new AntigravityNdjsonDriver({
      record: ANTIGRAVITY,
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: rig.processControl,
      clock: rig.clock,
      scheduler: rig.scheduler,
      loginEnv: rig.loginEnv,
      home: '/home/j',
      platform: 'linux',
      redact: (text) => text,
      ...(resumeContext === undefined ? {} : { resumeContext })
    })
  }
}

const NO_ASK =
  'Antigravity answers no permission and no question through this driver (15 §4.8 "Ask / answer: none"; row A1 permission and question none)'

const OPTIONS: ConformanceOptions = {
  ceiling: ANTIGRAVITY.ceiling,
  install: INSTALL,
  cases: {
    'C-06': { inapplicable: NO_ASK },
    'C-07': { inapplicable: NO_ASK },
    'C-08': { inapplicable: 'interrupt is false (15 §3 row A1, U→no): the stream has no cancel' },
    'C-09': { inapplicable: NO_ASK },
    'C-10': { inapplicable: NO_ASK },
    'C-11': { inapplicable: NO_ASK },
    'C-12': { inapplicable: 'answeredElsewhere is false (15 §3 row A1)' },
    'C-13': { inapplicable: NO_ASK },
    'C-14': { inapplicable: NO_ASK },
    'C-15': { inapplicable: NO_ASK },
    'C-17': { inapplicable: 'adopt is false: a stdio driver re-attaches nothing (15 §3 row A1)' },
    'C-21': {
      inapplicable: 'usage fidelity is 0 (15 §3 row A1, U→0 until SP-10 records stream-json usage)'
    },
    'C-22': {
      inapplicable:
        'SP-10 (Antigravity part) records no deny policy, so no policy-only mode is offered (15 §2.8)'
    },
    'C-26': { inapplicable: 'the prompt-tool probe gate is the stream-json driver’s (ADR-009 D4)' },
    'C-27': { inapplicable: 'the Antigravity profile has no answer-channel gate' }
  }
}

driverConformance('AntigravityNdjsonDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- helpers ----------

function fixture(name: string): FixtureCase {
  const found = fixtures.cases.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no fixture ${name}`)
  return found
}

function variantOf(name: string): FixtureVariant {
  const variant = fixture(name).variants[0]
  if (variant === undefined) throw new Error(`no ${name} variant`)
  return variant
}

/** Every variant of a fixture run against its expected file; failures as lines. */
async function againstExpected(name: string, factory = factoryWith()): Promise<string[]> {
  const own = fixture(name)
  const out: string[] = []
  for (const variant of own.variants) {
    const run = await runScript(factory, own.expected.script, { variant }, OPTIONS)
    const why = [
      ...run.failures,
      ...(run.sessionEvents.length < 2
        ? compareEvents(run.events, own.expected.events ?? [], run.bindings)
        : []),
      ...(own.expected.outcomes ?? []).flatMap((want, index) =>
        want === null ? [] : differences(run.outcomes[index], bind(want, run.bindings), `#${index}`)
      ),
      ...differences(run.sent, bind(own.expected.sent ?? [], run.bindings), 'sent')
    ]
    out.push(...why.map((line) => `${variant.label}: ${line}`))
  }
  return out
}

/** A hand-driven rig: the driver over a recording spawn, with the fake clock in reach. */
function rig(decide: (spec: { args: readonly string[] }) => SpawnScript) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const spawn = new RecordingSpawn({ clock, scheduler, decide })
  const driver = factoryWith()({ clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV })
  return { clock, scheduler, spawn, driver: driver as AntigravityNdjsonDriver }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

async function advance(clock: FakeClock, scheduler: FakeScheduler, ms: number): Promise<void> {
  await settle()
  const target = clock.now() + ms
  for (let step = 0; step < 10_000; step++) {
    const due = scheduler.nextDueAt()
    if (due === null || due > target) break
    clock.advance(Math.max(0, due - clock.now()))
    await settle()
  }
  clock.advance(target - clock.now())
  await settle()
}

function request(over: Partial<DriverLaunchRequest> = {}): DriverLaunchRequest {
  return {
    launchId: 'launch-1' as DriverLaunchRequest['launchId'],
    install: INSTALL,
    cwd: '/work/mine' as DriverLaunchRequest['cwd'],
    prompt: 'first prompt',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:conformance:launch-1:1',
    onSpawned: async () => {},
    ...over
  }
}

/** A transport over `lines`, each line held until the driver sent `gate` frames. */
function transport(lines: readonly string[], gate = 1): SpawnScript {
  return {
    kind: 'fixture',
    transport: new FixtureTransport({
      received: lines.map((line) => `${line}\n`).join(''),
      format: 'jsonl',
      gates: lines.map(() => gate)
    })
  }
}

const CONVERSATION = '88888888-8888-4888-8888-888888888888'
const INIT = JSON.stringify({ event: 'init', conversation_id: CONVERSATION, init: {} })

type Tracked = { state: 'pending' | 'resolved' | 'rejected'; value?: unknown }
function track<T>(promise: Promise<T>): Tracked {
  const tracked: Tracked = { state: 'pending' }
  promise.then(
    (value) => Object.assign(tracked, { state: 'resolved', value }),
    (error: unknown) => Object.assign(tracked, { state: 'rejected', value: error })
  )
  return tracked
}

// ---------- the driver's own cases (ISSUE-156 "Tests to write FIRST" item 2) ----------

describe('AntigravityNdjsonDriver', () => {
  it('[C-05] the prompt and every turn go on stdin and -p never appears in the argv', async () => {
    expect(await againstExpected('c-05-send-turn')).toEqual([])
    const run = await runScript(
      factoryWith(),
      fixture('c-05-send-turn').expected.script,
      { variant: variantOf('c-05-send-turn') },
      OPTIONS
    )
    expect(run.spawn.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([
      [INSTALL.binaryPath, ...LAUNCH_ARGV]
    ])
    const argv = run.spawn.spawns.flatMap((spawn) => spawn.args)
    for (const flag of PRINT_FLAGS) expect(argv).not.toContain(flag)
    expect(argv.some((arg) => arg.includes('first prompt') || arg.includes('say ping'))).toBe(false)
    expect(run.sent).toEqual([
      { event: 'user', message: { content: 'first prompt' } },
      { event: 'user', message: { content: 'say ping' } }
    ])
  })

  it('[C-22, SP-10] a policy-only launch has permission none and no deny flag until SP-10 records one', async () => {
    // 15 §2.8 row Antigravity: UNVERIFIED (SP-10 Antigravity part not run, spike-results/SP-10.md).
    expect(ANTIGRAVITY.modes).toBeUndefined()
    expect(publicLaunchOf(ANTIGRAVITY.ceiling, ANTIGRAVITY.modes)).toBe('gated')
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch', readyAfterMs: 3000 }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(run.session?.capabilities.permission).toBe('none')
    expect(run.session?.capabilities.question).toBe('none')
    expect(run.spawn.spawns[0]?.args).toEqual(LAUNCH_ARGV)

    // A request that names a policy-only mode anyway is refused before any spawn (fail closed).
    const policyOnly: PermissionModeSpec = {
      id: 'deny-by-default',
      label: 'deny',
      needs: 'policy-only',
      providerArgs: { argv: ['--mode', 'plan'], disableQuestionTools: true }
    }
    const { driver, spawn } = rig(() => transport([INIT]))
    const refused = track(driver.launch(request({ permissionMode: policyOnly })))
    await settle()
    expect(refused).toMatchObject({ state: 'rejected', value: { cause: 'could-not-start' } })
    expect(spawn.spawns).toEqual([])
  })

  it('[C-19] replaying the held-stream fixture twice yields identical sourceKeys', async () => {
    const keys = async (): Promise<string[]> => {
      const run = await runScript(
        factoryWith(),
        fixture('c-05-send-turn').expected.script,
        { variant: variantOf('c-05-send-turn') },
        OPTIONS
      )
      return sourceKeysOf(run.events)
    }
    const first = await keys()
    expect(first.length).toBeGreaterThan(0)
    expect(await keys()).toEqual(first)
  })

  it('[C-16] resume launches agy with the launch argv plus --conversation and the recorded conversation id', async () => {
    const run = await runScript(
      factoryWith(),
      fixture('c-16-resume').expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    expect(run.failures).toEqual([])
    const recorded = '66666666-6666-4666-8666-666666666666'
    expect(run.spawn.spawns.map((spawn) => spawn.args)).toEqual([
      LAUNCH_ARGV,
      [...LAUNCH_ARGV, '--conversation', recorded]
    ])
    expect(run.session?.ref.providerSessionId).toBe(recorded)
    expect(run.session?.ref.previousProviderSessionId).toBeUndefined()
    // A resume writes nothing: the only frames are the launch prompt and the next turn.
    expect(run.sent).toEqual([
      { event: 'user', message: { content: 'first prompt' } },
      { event: 'user', message: { content: 'say two' } }
    ])

    // The model and effort of the launch are part of "the same argv".
    const { clock, scheduler, spawn, driver } = rig(() => transport([INIT]))
    const launched = track(driver.launch(request({ model: 'model-a', effort: 'high' })))
    await advance(clock, scheduler, 3000)
    expect(launched.state).toBe('resolved')
    const session = launched.value as DriverSession
    void session.close('end-thread')
    spawn.fake.exit(session.ref.pid as number)
    await settle()
    const resumed = track(driver.resume(session.ref))
    await advance(clock, scheduler, 3000)
    expect(resumed).toMatchObject({ state: 'resolved' })
    const tuning = ['--model', 'model-a', '--effort', 'high']
    expect(spawn.spawns.map((s) => s.args)).toEqual([
      [...LAUNCH_ARGV, ...tuning],
      [...LAUNCH_ARGV, ...tuning, '--conversation', CONVERSATION]
    ])
  })

  it('[ADR-008] a launch or resume argv never contains --print, -p or an auto-approve flag', async () => {
    const run = await runScript(
      factoryWith(),
      fixture('c-16-resume').expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    expect(run.spawn.spawns).toHaveLength(2)
    for (const spawn of run.spawn.spawns) {
      for (const flag of PRINT_FLAGS) expect(spawn.args).not.toContain(flag)
      for (const flag of FORBIDDEN_FLAGS) {
        expect(spawn.args.some((arg) => arg.toLowerCase().includes(flag.toLowerCase()))).toBe(false)
      }
    }
    // A value that is itself a flag never reaches the argv (it would be read as one).
    for (const value of ['-p', '--print', FORBIDDEN_FLAGS[0] as string, 'a\nb', '']) {
      expect(() => buildArgv({ model: value })).toThrow(HostInvariantError)
      expect(() => buildArgv({ effort: value })).toThrow(HostInvariantError)
      expect(() => buildArgv({ conversationId: value })).toThrow(HostInvariantError)
    }
  })

  it('[C-23, INV-59] the agy child gets the childEnv allowlist and DWARFAI_SPAWN, never a credential, token or Host variable', async () => {
    const run = await runScript(
      factoryWith(),
      fixture('c-16-resume').expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    for (const spawn of run.spawn.spawns) {
      expect(spawn.env).toEqual({
        PATH: LOGIN_ENV.PATH,
        HOME: LOGIN_ENV.HOME,
        LANG: LOGIN_ENV.LANG,
        DWARFAI_SPAWN: 'v1:conformance:launch-1:1'
      })
      expect(JSON.stringify(spawn)).not.toContain(CANARY_TOKEN)
    }
    // The person's own credential and override variables stay in the login environment
    // (ADR-008 item 2: never read, copied or forwarded; 15 §2.4: DWARFAI_AGY_PATH is the
    // resolver's only).
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    const spawn = new RecordingSpawn({ clock, scheduler, decide: () => transport([INIT]) })
    const driver = factoryWith()({
      clock,
      scheduler,
      processControl: spawn,
      loginEnv: {
        PATH: '/usr/bin',
        HOME: '/home/j',
        DWARFAI_AGY_PATH: '/home/j/tools/agy',
        GOOGLE_APPLICATION_CREDENTIALS: '/home/j/.config/gcloud/creds.json',
        GEMINI_API_KEY: 'never-forwarded',
        ANTIGRAVITY_TOKEN: 'never-forwarded'
      }
    })
    void driver.launch(request())
    await settle()
    expect(spawn.spawns[0]?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/j',
      DWARFAI_SPAWN: 'v1:conformance:launch-1:1'
    })
    expect(spawn.spawns[0]?.args).toEqual(LAUNCH_ARGV)
  })

  it('[C-01, ADR-020] a launch is ready only once init named the conversation, and a live agy that names none in 30 s is could-not-start', async () => {
    const late = JSON.stringify({ event: 'init', conversation_id: CONVERSATION })
    // The init arrives at 5 s: the launch resolves then, with that conversation as its id.
    const quiet = new FixtureTransport({ received: '', format: 'jsonl' })
    const first = rig(() => ({ kind: 'fixture', transport: quiet }))
    const pending = track(first.driver.launch(request()))
    await advance(first.clock, first.scheduler, 3000)
    expect(pending.state).toBe('pending')
    await advance(first.clock, first.scheduler, 2000)
    expect(pending.state).toBe('pending')
    quiet.stdout.write(`${late}\n`)
    await settle()
    expect(pending.state).toBe('resolved')
    expect((pending.value as DriverSession).ref.providerSessionId).toBe(CONVERSATION)

    // No init by HANDSHAKE_TIMEOUT_MS: could-not-start, stdin closed; the kill is ADR-014's.
    const second = rig(() => ({
      kind: 'fixture',
      transport: new FixtureTransport({ received: '', format: 'jsonl', stderr: 'y'.repeat(900) })
    }))
    const silent = track(second.driver.launch(request()))
    await advance(second.clock, second.scheduler, 30_000)
    expect(silent.state).toBe('rejected')
    const failure = silent.value as { cause: string; toolOutputTail?: string }
    expect(failure.cause).toBe('could-not-start')
    expect((failure.toolOutputTail ?? '').length).toBeLessThanOrEqual(400)
    expect(second.spawn.killTreeCalls).toBe(0)
  })

  it('[C-16] resume refuses a session that is live in this Host, one it knows nothing of, and a launch that named no conversation', async () => {
    const live = rig(() => transport([INIT]))
    const launched = track(live.driver.launch(request()))
    await advance(live.clock, live.scheduler, 3000)
    const session = launched.value as DriverSession
    const again = track(live.driver.resume(session.ref))
    await settle()
    expect(again).toMatchObject({ state: 'rejected', value: { reason: 'resume-error' } })

    const unknown: SessionRef = {
      providerId: ANTIGRAVITY.profile.id,
      providerSessionId: CONVERSATION
    }
    const fresh = rig(() => transport([INIT]))
    const stranger = track(fresh.driver.resume(unknown))
    await settle()
    expect(stranger).toMatchObject({ state: 'rejected', value: { reason: 'resume-error' } })

    // An agy that ends after the 3 s window before naming a conversation is an ended session
    // (ADR-020 D4), with nothing agy could resume.
    const dead = rig(() => ({ kind: 'exit', afterMs: 3000, code: 1, stderr: 'not logged in' }))
    const ended = track(dead.driver.launch(request()))
    await advance(dead.clock, dead.scheduler, 3001)
    expect(ended.state).toBe('resolved')
    const events: DriverEvent[] = []
    for await (const event of (ended.value as DriverSession).events()) events.push(event)
    expect(events.at(-1)).toEqual({ t: 'exited', code: 1 })
    const nothing = track(dead.driver.resume((ended.value as DriverSession).ref))
    await settle()
    expect(nothing).toMatchObject({ state: 'rejected', value: { reason: 'stale-ref' } })
    expect(dead.spawn.spawns).toHaveLength(1)
  })
})

// ---------- the probe (15 §2.3; ADR-009 D4) ----------

/**
 * `agy --help` as agy 1.4.2 prints it (Windows, 2026-10-18), with the one auto-approve option
 * line left out: ADR-008 Verification keeps that flag's literal out of src/host.
 */
const HELP_1_4_2 = [
  'Usage of agy.exe:',
  '  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
  '  --agent                         Agent for the current CLI session',
  '  -c                              Short alias for --continue',
  '  --continue                      Continue the most recent conversation',
  '  --conversation                  Resume a previous conversation by ID',
  '  --disable-slash-commands        Disable slash command and skill expansion in print mode',
  '  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)',
  '  -i                              Short alias for --prompt-interactive',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)',
  '  --json-schema                   Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)',
  '  --log-file                      Override CLI log file path',
  '  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)',
  '  --model                         Model for the current CLI session',
  '  --new-project                   Create a new project for this session',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  '  -p                              Short alias for --print',
  '  --print                         Run a single prompt non-interactively and print the response',
  '  --print-timeout                 Optional time limit for print mode; 0 waits until the turn completes (default 0s)',
  '  --project                       Project ID or project name for the current CLI session',
  '  --prompt                        Alias for --print',
  '  --prompt-interactive            Run an initial prompt interactively and continue the session',
  '  --remote-control                Create a remote connection for the CLI session on start up',
  '  --sandbox                       Run in a sandbox with terminal restrictions enabled',
  ''
].join('\n')

describe('the AntigravityNdjsonDriver probe', () => {
  it('[C-25, ADR-009] agy --help with stream-json in and out opens launch, --conversation opens resume cli-flag, and an unread help is fail-closed', async () => {
    expect(capabilitiesFromHelp(HELP_1_4_2)).toMatchObject({ launch: true, resume: 'cli-flag' })
    const noResume = HELP_1_4_2.replace(/^ {2}--conversation .*$/m, '')
    expect(capabilitiesFromHelp(noResume)).toMatchObject({ launch: true, resume: 'none' })
    const textOnly = HELP_1_4_2.replace('(text, stream-json)', '(text)')
    expect(capabilitiesFromHelp(textOnly)).toMatchObject({ launch: false })
    expect(capabilitiesFromHelp(null)).toMatchObject({ launch: false, resume: 'none' })

    // Through the driver: `agy --help` with an argv array, never a session.
    const { clock, scheduler, spawn, driver } = rig(() => ({
      kind: 'exit',
      afterMs: 0,
      code: 0,
      stdout: HELP_1_4_2
    }))
    const probed = track(driver.probe(INSTALL))
    await advance(clock, scheduler, 10)
    expect(spawn.spawns.map((s) => s.args)).toEqual([['--help']])
    expect(probed.state).toBe('resolved')
    expect(probed.value).toMatchObject({
      launch: true,
      resume: 'cli-flag',
      permission: 'none',
      interrupt: false,
      turnEnd: 'none',
      earlyFailure: 'exit-only',
      usage: { fidelity: 0, rateLimits: false }
    })
  })
})

// ADDED for ISSUE-188 (the step-3e E2E stub, ADR-029 row 8, #1360): the one resolver may answer a Windows script entry.
describe('the AntigravityNdjsonDriver on a Windows script entry', () => {
  it('[C-02, ADR-029] on Windows an agy that resolves to a script entry is probed and launched by the person node with the entry as its first argument, never through a shell', async () => {
    // A Windows `agy.cmd` shim resolves to its quoted script entry, which the OS cannot start by itself (spawn
    // EFTYPE) and R17 forbids running through a shell. agy's own install is an `agy.exe`, started as it is.
    const entry = String.raw`C:\Users\j\AppData\Local\agy\bin\agy.mjs`
    const node = String.raw`C:\Program Files\nodejs\node.exe`
    const windowsFactory =
      (withNode: boolean): DriverFactory =>
      (rig) => {
        const resolver = new FakeInstallResolver()
        resolver.install('agy', { path: entry, version: '1.1.26' })
        if (withNode) resolver.install('node', { path: node })
        return new AntigravityNdjsonDriver({
          record: ANTIGRAVITY,
          detection: createInstallDetection({
            resolver,
            fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
            scheduler: rig.scheduler
          }),
          processControl: rig.processControl,
          clock: rig.clock,
          scheduler: rig.scheduler,
          loginEnv: rig.loginEnv,
          home: String.raw`C:\Users\j`,
          platform: 'win32',
          redact: (text) => text
        })
      }
    const install = { ...INSTALL, binaryPath: entry }
    const options = { ...OPTIONS, install }
    const run = await runScript(
      windowsFactory(true),
      fixture('c-01-launch').expected.script,
      { variant: variantOf('c-01-launch') },
      options
    )
    expect(run.spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([
      [node, entry, ...LAUNCH_ARGV]
    ])
    // The help probe starts the same way.
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    const spawn = new RecordingSpawn({
      clock,
      scheduler,
      decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: HELP_1_4_2 })
    })
    const probing = track(
      windowsFactory(true)({ clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV }).probe(
        install
      )
    )
    await advance(clock, scheduler, 10)
    expect(probing.value).toMatchObject({ launch: true })
    expect(spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([[node, entry, '--help']])
    // No node the resolver can find: not installed, and nothing is spawned (no shell fallback).
    const noNode = await runScript(
      windowsFactory(false),
      fixture('c-01-launch').expected.script,
      { variant: variantOf('c-01-launch') },
      options
    )
    expect(noNode.outcomes[0]).toEqual({
      rejected: { cause: 'not-installed', detail: 'node, which runs Antigravity, is not installed' }
    })
    expect(noNode.spawn.spawns).toEqual([])
  })
})
