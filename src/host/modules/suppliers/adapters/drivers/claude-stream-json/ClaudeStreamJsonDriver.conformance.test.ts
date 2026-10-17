// L4 conformance of the Claude `stream-json` driver (15 §4.2, §6; 17 §1.4, §2.3): the harness run
// over the scrubbed maintainer recordings of `fixtures/claude/stream-json/2.1.x/` (ISSUE-321: SP-08,
// S-020-1, SP-10, SP-15 on Claude Code 2.1.301) plus the hand-written cases of
// `2.1.x-synthetic/` that no recording covers (its `meta.json` says which), then the driver's own
// cases of ISSUE-150. Every `*.expected.json` is written by hand from the contract.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch, ProviderId } from '../../../../../kernel/domain/values'
import type { IdGenerator } from '../../../../../kernel/ports/idGenerator'
import { createCapabilityProbing } from '../../../application/probe'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeDriverRegistry } from '../../../ports/fakes/FakeDriverRegistry'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import { InMemoryCapabilityRecordStore } from '../../../ports/fakes/InMemoryCapabilityRecordStore'
import type { DriverEvent, DriverSession, InstalledProvider } from '../../../ports/providerDriver'
import {
  CANARY_TOKEN,
  LOGIN_ENV,
  driverConformance,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory,
  type Run
} from '../../../testing/driverConformance'
import { bind, compareEvents, differences, type Json } from '../../../testing/expected'
import {
  readFixtureSet,
  type FixtureCase,
  type FixtureSet,
  type FixtureVariant
} from '../../../testing/fixtureSet'
import { FixtureTransport, splitLines } from '../../../testing/fixtureTransport'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { AUTO_APPROVE_PERMISSION_MODES, FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { buildArgv } from './argv'
import { capabilitiesFromHelp, SPIKE_RECORDS } from './capabilities'
import { ClaudeStreamJsonDriver } from './ClaudeStreamJsonDriver'
import type { McpConfigFiles } from './mcpConfigFile'
import type {
  PromptToolCall,
  PromptToolHandler,
  PromptToolRelay,
  PromptToolSessions
} from './promptTool'
import type { DelegationInjection } from '../../../ports/providerDriver'

const FIXTURE_ROOT = new URL('../../../../../../../fixtures/claude/stream-json/', import.meta.url)
const RECORDED = fileURLToPath(new URL('2.1.x/', FIXTURE_ROOT))
const SYNTHETIC = fileURLToPath(new URL('2.1.x-synthetic/', FIXTURE_ROOT))
const recorded = readFixtureSet(RECORDED)
const synthetic = readFixtureSet(SYNTHETIC)
/** One set for the harness: the recorded set's location and meta, with both folders' cases. */
const fixtures: FixtureSet = { ...recorded, cases: [...recorded.cases, ...synthetic.cases] }

const CLAUDE = CATALOG_RECORDS.find((record) => record.profile.id === 'claude') as CatalogRecord
const MCP_DIR = '/home/j/.dwarfai/run/mcp'
const SESSION = '00000000-0000-7000-8000-000000000001'
/** The scrubber's placeholder for the session id the Host assigned in each SP-15 recording. */
const RECORDED_SESSION = '00000000-0000-4000-8000-000000000001'

const INSTALL: InstalledProvider = {
  providerId: CLAUDE.profile.id,
  binaryPath: '/usr/local/bin/claude',
  version: '2.1.x',
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** The `--mcp-config` file store as a test sees it: what was written and what is left. */
class RecordingMcpConfigFiles implements McpConfigFiles {
  readonly written = new Map<string, string>()
  readonly removed: string[] = []

  async write(path: string, text: string): Promise<void> {
    if (this.written.has(path)) throw new Error(`${path} exists`)
    this.written.set(path, text)
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path)
  }
}

/**
 * Both halves of the prompt tool as a test drives them (AMENDMENT-21): the relay entry every
 * launch is issued (`fail`: none can be), and the handler each session registers, called as the
 * relay's `permission` tool would.
 */
class RecordingPromptTools implements PromptToolSessions, PromptToolRelay {
  readonly handlers = new Map<string, PromptToolHandler>()
  readonly issued: string[] = []
  fail = false

  register(launchId: string, handler: PromptToolHandler): () => void {
    this.handlers.set(launchId, handler)
    return () => {
      if (this.handlers.get(launchId) === handler) this.handlers.delete(launchId)
    }
  }

  async issue(launchId: string): Promise<DelegationInjection | null> {
    this.issued.push(launchId)
    if (this.fail) return null
    return {
      mechanism: 'ticket-file',
      relay: { program: '/opt/dwarfai/host/dwarfai', args: ['dwarfai-mcp-relay'] },
      credentialFilePath: `/home/j/.dwarfai/run/mcp/${launchId}.cred`
    }
  }

  /** The relay's `permission` call for `launchId`'s session. */
  ask(
    launchId: string,
    call: PromptToolCall,
    signal: AbortSignal = new AbortController().signal
  ): Promise<'allow' | 'deny'> {
    const handler = this.handlers.get(launchId)
    if (handler === undefined) throw new Error(`no session registered for ${launchId}`)
    return handler(call, signal)
  }
}

/** Ids as the Host minted them in a recording: `first` for the session, then the sequence. */
class RecordedIds implements IdGenerator {
  private readonly rest = new SequenceIdGenerator()
  private used = false

  constructor(private readonly first: string) {}

  uuidv7(): string {
    if (this.used) return this.rest.uuidv7()
    this.used = true
    return this.first
  }
}

function factoryWith(
  shared?: McpConfigFiles,
  ids?: () => IdGenerator,
  prompts?: RecordingPromptTools
): DriverFactory {
  return (rig: ConformanceRig) => {
    const files = shared ?? new RecordingMcpConfigFiles()
    const tools = prompts ?? new RecordingPromptTools()
    const resolver = new FakeInstallResolver()
    resolver.install('claude', { path: INSTALL.binaryPath, version: '2.1.x' })
    return new ClaudeStreamJsonDriver({
      record: CLAUDE,
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: rig.processControl,
      clock: rig.clock,
      scheduler: rig.scheduler,
      ids: ids?.() ?? new SequenceIdGenerator(),
      loginEnv: rig.loginEnv,
      home: '/home/j',
      platform: 'linux',
      mcpConfig: { dir: MCP_DIR, files },
      promptTool: { sessions: tools, relay: tools },
      redact: (text) => text
    })
  }
}

// AMENDMENT-21 (owner, 2026-10-17) serves the prompt tool, but its asks never cross the stdio
// transport these harness cases script: they arrive as calls of the relay's `permission` tool. The
// harness launch is unprobed, so its effective permission is the fail-closed none (only the probe
// opens interactive, SP-08), and the prompt-tool asks run as this driver's own C-06, C-07 and C-13
// cases ("permission prompt tool" below). A harness step that calls the prompt tool is a follow-up.
const NO_ASK =
  'the prompt-tool asks do not cross the stdio transport the harness scripts, and the unprobed harness launch keeps permission at its fail-closed none; they run as this driver’s own prompt-tool cases (AMENDMENT-21). Questions stay disabled with --disallowedTools AskUserQuestion (ADR-009 D4)'

const OPTIONS: ConformanceOptions = {
  ceiling: CLAUDE.ceiling,
  install: INSTALL,
  // AMENDMENT-18 (owner, 2026-10-16): the Claude ceiling allows C2's resume cli-flag, so C-16
  // applies. Its SP-15 recording kept the session id the Host assigned (RECORDED_SESSION).
  caseFactories: { 'C-16': factoryWith(undefined, () => new RecordedIds(RECORDED_SESSION)) },
  cases: {
    'C-06': { inapplicable: NO_ASK },
    'C-07': { inapplicable: NO_ASK },
    'C-08': {
      inapplicable: 'interrupt is false (15 §3 row C2, U→no; §4.2 "interrupt UNVERIFIED")'
    },
    'C-09': { inapplicable: NO_ASK },
    'C-10': { inapplicable: NO_ASK },
    'C-11': { inapplicable: NO_ASK },
    'C-12': { inapplicable: 'answeredElsewhere is false (15 §3 row C2)' },
    'C-13': { inapplicable: NO_ASK },
    'C-14': { inapplicable: NO_ASK },
    'C-15': { inapplicable: NO_ASK },
    'C-17': { inapplicable: 'adopt is false: a stdio driver re-attaches nothing (15 §3 row C2)' },
    'C-22': { inapplicable: 'no policy-only stream-json launch in v1 (15 §2.8, O-15-07)' },
    'C-27': { inapplicable: 'the Claude profile has no answer-channel gate' }
  }
}

driverConformance('ClaudeStreamJsonDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the driver's own cases (ISSUE-150 "Tests to write FIRST" item 2) ----------

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
      ...compareEvents(run.events, own.expected.events ?? [], run.bindings),
      ...(own.expected.outcomes ?? []).flatMap((want, index) =>
        want === null ? [] : differences(run.outcomes[index], bind(want, run.bindings), `#${index}`)
      ),
      ...differences(run.sent, bind(own.expected.sent ?? [], run.bindings), 'sent')
    ]
    out.push(...why.map((line) => `${variant.label}: ${line}`))
  }
  return out
}

async function launched(
  plan: { delegation?: boolean } = {},
  files = new RecordingMcpConfigFiles(),
  prompts = new RecordingPromptTools()
): Promise<{ run: Run; files: RecordingMcpConfigFiles }> {
  const run = await runScript(
    factoryWith(files, undefined, prompts),
    [{ do: 'launch' }, { do: 'transportLost' }],
    { variant: variantOf('s0201-readiness'), ...plan },
    OPTIONS
  )
  return { run, files }
}

/** The help of Claude Code 2.1.301 as recorded (SP-08): the flag is not an option line of its own. */
const HELP_2_1_301 = readFileSync(`${RECORDED}probe-help-without-prompt-tool.jsonl`, 'utf8')
/** A help without the flag anywhere (no recording has one; hand-written, C-26). */
const HELP_WITHOUT_FLAG = readFileSync(`${SYNTHETIC}c-26-help-without-prompt-tool.jsonl`, 'utf8')

/** The probe end to end: the capability probing service over this driver and one help output. */
async function probedLaunch(
  help: string
): Promise<{ launch: boolean | undefined; argv: string[][] }> {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const spawn = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: help })
  })
  const driver = factoryWith()({ clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV })
  const probing = createCapabilityProbing({
    registry: new FakeDriverRegistry([driver]),
    store: new InMemoryCapabilityRecordStore(),
    clock,
    scheduler,
    bus: { publish: () => {} },
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1' as HostEpoch
  })
  const refreshed = probing.refresh(CLAUDE.profile.id as ProviderId)
  for (let round = 0; round < 20; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    clock.advance(0)
  }
  await refreshed
  return {
    launch: probing.selected(CLAUDE.profile.id as ProviderId)?.launch,
    argv: spawn.spawns.map((s) => [s.executable, ...s.args])
  }
}

/** Lets pending continuations run (the clock is fake: no timer is involved). */
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

/**
 * The processes of a recording that holds several, one after another (SP-15: launch, resume,
 * fork): each one's stdout lines and gates, split by the `spawned` marks of the timing stream.
 * The bytes are counted on the as-recorded variant (as `gatesFromTiming` does) and the same line
 * ranges cut every variant.
 */
function processesOf(
  name: string,
  variant: FixtureVariant
): { received: string; gates: number[] }[] {
  const asRecorded = variantOf(name)
  const timing = splitLines(asRecorded.streams.timing ?? '')
  const steps: { bytes: number; sentBefore: number }[] = []
  let sent = 0
  for (const entry of timing) {
    const mark = JSON.parse(entry) as { event?: string; stream?: string; bytes?: number }
    if (mark.event === 'spawned') steps.push({ bytes: 0, sentBefore: sent })
    if (mark.stream === 'sent') sent += 1
    const step = steps.at(-1)
    if (mark.stream === 'received' && step !== undefined) step.bytes += mark.bytes ?? 0
  }
  const lfLines = splitLines(asRecorded.received.replaceAll('\r\n', '\n'))
  const lines = splitLines(variant.received)
  const gates = asRecorded.gates ?? []
  const out: { received: string; gates: number[] }[] = []
  let next = 0
  for (const step of steps) {
    const first = next
    let bytes = 0
    while (next < lfLines.length && bytes < step.bytes) {
      bytes += Buffer.byteLength(lfLines[next] as string)
      next += 1
    }
    out.push({
      received: lines.slice(first, next).join(''),
      gates: gates.slice(first, next).map((gate) => Math.max(0, gate - step.sentBefore))
    })
  }
  return out
}

/** One SP-15 run: launch over the first process, then resume over `resumedProcess`. */
async function resumedRun(
  variant: FixtureVariant,
  resumedProcess: number,
  prompts = new RecordingPromptTools()
): Promise<{
  /** Per session (the launched one, then the resumed one): its own events, in order. */
  events: [DriverEvent[], DriverEvent[]]
  outcomes: unknown[]
  sent: Json[]
  spawn: RecordingSpawn
  session: DriverSession
  resumed: DriverSession | null
}> {
  const parts = processesOf('sp15-resume', variant)
  const script = fixture('sp15-resume').expected.script
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const transports: FixtureTransport[] = []
  const order = [0, resumedProcess]
  const spawn = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => {
      const part = parts[order[transports.length] ?? -1]
      if (part === undefined) throw new Error('no recorded process left')
      const transport = new FixtureTransport({ ...part, format: 'jsonl' })
      transports.push(transport)
      return { kind: 'fixture', transport }
    }
  })
  const driver = factoryWith(
    undefined,
    () => new RecordedIds(RECORDED_SESSION),
    prompts
  )({
    clock,
    scheduler,
    processControl: spawn,
    loginEnv: LOGIN_ENV
  }) as ClaudeStreamJsonDriver
  const launchedEvents: DriverEvent[] = []
  const resumedEvents: DriverEvent[] = []
  const drain = (session: DriverSession, into: DriverEvent[]): void => {
    void (async () => {
      for await (const event of session.events()) into.push(event)
    })()
  }
  const launch = script[0] as { prompt: string }
  const session = await driver.launch({
    launchId: 'launch-1' as never,
    install: INSTALL,
    cwd: '/work/mine' as never,
    prompt: launch.prompt,
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:conformance:launch-1:1',
    onSpawned: async () => {}
  })
  drain(session, launchedEvents)
  await settle()
  transports[0]?.eof()
  await settle()
  let resumed: DriverSession | null = null
  void driver.resume(session.ref).then((value) => {
    resumed = value
  })
  await settle()
  clock.advance(2_999)
  await settle()
  const pendingAt2999 = resumed === null
  clock.advance(1)
  await settle()
  if (resumed === null) {
    return { events: [launchedEvents, []], outcomes: [], sent: [], spawn, session, resumed: null }
  }
  const ready = resumed as DriverSession
  drain(ready, resumedEvents)
  const turn = script[4] as { messageId: string; text: string }
  const receipt = await ready.sendTurn({
    messageId: turn.messageId as never,
    kind: 'message',
    text: turn.text,
    attachments: []
  })
  await settle()
  const sent = transports.flatMap((transport) => transport.sent.map((f) => JSON.parse(f) as Json))
  return {
    events: [launchedEvents, resumedEvents],
    outcomes: [{ resolved: true }, null, { pendingAt2999 }, null, receipt],
    sent,
    spawn,
    session,
    resumed: ready
  }
}

describe('ClaudeStreamJsonDriver', () => {
  it('[C-26, SP-08] help output without --permission-prompt-tool makes launch false and the driver is not offered', async () => {
    const probed = await probedLaunch(HELP_WITHOUT_FLAG)
    expect(probed.launch).toBe(false)
    // The probe ran the person's claude with --help, an argv array (15 §2.3), and nothing else.
    expect(probed.argv).toEqual([[INSTALL.binaryPath, '--help']])
    expect(capabilitiesFromHelp(HELP_WITHOUT_FLAG, SPIKE_RECORDS).launch).toBe(false)
    expect(capabilitiesFromHelp(null, SPIKE_RECORDS).launch).toBe(false)
    // --disallowedTools is the other half of the probe (15 §2.3 row 2).
    const noDisallow = HELP_2_1_301.split('\n')
      .filter((line) => !line.includes('--disallowedTools'))
      .join('\n')
    expect(capabilitiesFromHelp(noDisallow, SPIKE_RECORDS).launch).toBe(false)
    // A passed SP-08 record is needed too: the same help with SP-08 not passed stays closed.
    expect(capabilitiesFromHelp(HELP_2_1_301, { ...SPIKE_RECORDS, sp08: false }).launch).toBe(false)
  })

  it('[C-26, SP-08] the 2.1.301 help, which names --permission-prompt-tool only inside --permission-prompts, probes launch true', async () => {
    // SP-08 Decision: the flag is hidden from the option list but accepted and routing; the probe
    // must not rely on an option line of its own.
    expect(HELP_2_1_301).not.toMatch(/^ {2}--permission-prompt-tool\b/m)
    const probed = await probedLaunch(HELP_2_1_301)
    expect(probed.launch).toBe(true)
    // A --permission-prompts option that does not name the flag is not enough.
    const unnamed = HELP_2_1_301.replace(
      /"host" \(the SDK host or\s+--permission-prompt-tool\)/,
      '"host" (the SDK host)'
    )
    expect(unnamed).not.toContain('--permission-prompt-tool')
    expect(capabilitiesFromHelp(unnamed, SPIKE_RECORDS).launch).toBe(false)
    // A help that lists the flag as an option of its own still probes open.
    const listed = `${HELP_WITHOUT_FLAG}\n  --permission-prompt-tool <tool>  MCP tool that answers permission prompts\n  --disallowedTools <tools...>\n`
    expect(capabilitiesFromHelp(listed, SPIKE_RECORDS).launch).toBe(true)
    // A mention in another option's prose is not the flag being advertised.
    const prose = `${HELP_WITHOUT_FLAG}\n  --legacy-prompts <x>  Removed; it was replaced by --permission-prompt-tool\n`
    expect(capabilitiesFromHelp(prose, SPIKE_RECORDS).launch).toBe(false)
  })

  it('[C-23] the mcp-config file and the argv hold the credential file path and never the credential value', async () => {
    const { run, files } = await launched({ delegation: true })
    const config = `${MCP_DIR}/launch-1.mcp.json`
    expect([...files.written.keys()]).toEqual([config])
    const text = files.written.get(config) ?? ''
    expect(text).not.toContain(CANARY_TOKEN)
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        dwarfai: {
          command: '/opt/dwarfai/host/dwarfai',
          args: ['dwarfai-mcp-relay'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_MCP_CREDENTIAL_FILE: '/home/j/.dwarfai/run/mcp/launch-1.cred'
          }
        }
      }
    })
    const [claude] = run.spawn.spawns
    expect(claude?.args).toContain('--mcp-config')
    expect(claude?.args[claude.args.indexOf('--mcp-config') + 1]).toBe(config)
    expect(claude?.args.join(' ')).not.toContain(CANARY_TOKEN)
    expect(claude?.env.DWARFAI_SPAWN).toBe('v1:conformance:launch-1:1')
    expect(claude?.env).not.toHaveProperty('DWARFAI_MCP_CREDENTIAL_FILE')
    expect(claude?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(claude?.env).not.toHaveProperty('DWARFAI_DELEGATION_TOKEN')
    // The file lives only as long as the session: it is removed once the session exited.
    expect(files.removed).toEqual([config])
    // AMENDED by AMENDMENT-21 (owner, 2026-10-17; was: "Without a gated delegation there is no
    // file and no --mcp-config"): the relay also serves the permission prompt tool, so a launch
    // without a gated delegation carries the entry too, with the path only and no pre-approval.
    const plain = await launched()
    expect([...plain.files.written.keys()]).toEqual([config])
    expect(plain.files.written.get(config)).not.toContain(CANARY_TOKEN)
    expect(plain.run.spawn.spawns[0]?.args).toContain('--mcp-config')
    expect(plain.run.spawn.spawns[0]?.args.some((arg) => /^--allowed-?tools/i.test(arg))).toBe(
      false
    )
  })

  it('[C-24] no forbidden flag appears in any argv the driver builds, dangerously-skip-permissions included', async () => {
    const argvs = [
      buildArgv({ kind: 'launch', sessionId: SESSION, mcpConfigPath: null, policyArgv: [] }),
      buildArgv({
        kind: 'launch',
        sessionId: SESSION,
        model: 'sample-model',
        effort: 'high',
        mcpConfigPath: `${MCP_DIR}/launch-1.mcp.json`,
        policyArgv: []
      }),
      buildArgv({ kind: 'resume', sessionId: SESSION, mcpConfigPath: null, policyArgv: [] }),
      (await launched({ delegation: true })).run.spawn.spawns[0]?.args ?? []
    ]
    for (const argv of argvs) {
      for (const flag of FORBIDDEN_FLAGS) {
        expect(argv.join(' ').toLowerCase()).not.toContain(flag.toLowerCase())
      }
      // SP-08: `--permission-prompts host` is not covered by the record, so it is never passed.
      expect(argv).not.toContain('--permission-prompts')
    }
    // A permission mode that would carry one, alone or as a mode value, is refused before any
    // spawn (ADR-008 item 3). The flags come from the guard's own list: this file never spells one.
    for (const flag of FORBIDDEN_FLAGS) {
      for (const policyArgv of [[flag], ['--permission-mode', flag]]) {
        expect(() =>
          buildArgv({ kind: 'launch', sessionId: SESSION, mcpConfigPath: null, policyArgv })
        ).toThrow(/forbidden/)
      }
    }
  })

  it('[C-24] every launch and resume argv pins --permission-mode, so the person settings defaultMode never applies (AMENDMENT-19)', async () => {
    /** The values of every `--permission-mode` in `argv`, in order. */
    const modes = (argv: readonly string[]): string[] =>
      argv.flatMap((arg, index) => (arg === '--permission-mode' ? [argv[index + 1] ?? ''] : []))
    // The recorded spawns: a launch, and the launch then the resume of the SP-15 recording.
    const { run } = await launched()
    const resumed = await resumedRun(fixture('sp15-resume').variants[0] as FixtureVariant, 1)
    const recordedArgv = [
      run.spawn.spawns[0]?.args ?? [],
      ...resumed.spawn.spawns.map((spawn) => spawn.args)
    ]
    expect(resumed.spawn.spawns[1]?.args).toContain('--resume')
    for (const argv of recordedArgv) expect(modes(argv), argv.join(' ')).toEqual(['default'])
    for (const kind of ['launch', 'resume'] as const) {
      const built = buildArgv({ kind, sessionId: SESSION, mcpConfigPath: null, policyArgv: [] })
      expect(modes(built), kind).toEqual(['default'])
      // A DwarfAI permission mode that sets its own asking value: exactly one, the policy's.
      const plan = buildArgv({
        kind,
        sessionId: SESSION,
        mcpConfigPath: null,
        policyArgv: ['--permission-mode', 'plan']
      })
      expect(modes(plan), `${kind} with a policy mode`).toEqual(['plan'])
      expect(
        buildArgv({
          kind,
          sessionId: SESSION,
          mcpConfigPath: null,
          policyArgv: ['--permission-mode=plan']
        }).filter((arg) => arg.startsWith('--permission-mode')),
        `${kind} with a policy mode=`
      ).toEqual(['--permission-mode=plan'])
    }
    // A policy whose mode settles a tool use without asking is refused before any spawn, and so
    // is a policy that sets the mode twice.
    for (const mode of [...AUTO_APPROVE_PERMISSION_MODES, ...FORBIDDEN_FLAGS]) {
      for (const policyArgv of [['--permission-mode', mode], [`--permission-mode=${mode}`]]) {
        expect(
          () => buildArgv({ kind: 'launch', sessionId: SESSION, mcpConfigPath: null, policyArgv }),
          policyArgv.join(' ')
        ).toThrow(/forbidden/)
      }
    }
    expect(() =>
      buildArgv({
        kind: 'launch',
        sessionId: SESSION,
        mcpConfigPath: null,
        policyArgv: ['--permission-mode', 'plan', '--permission-mode', 'default']
      })
    ).toThrow(/one --permission-mode/)
  })

  it('[C-09, SP-08] with question none the question tool is disallowed in the argv', async () => {
    const { run } = await launched()
    const args = run.spawn.spawns[0]?.args ?? []
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      SESSION,
      // AMENDMENT-19: the permission mode is pinned, never the person's settings defaultMode.
      '--permission-mode',
      'default',
      '--permission-prompt-tool',
      'mcp__dwarfai__permission',
      '--disallowedTools',
      'AskUserQuestion',
      // AMENDED by AMENDMENT-21 (owner, 2026-10-17): every launch carries the relay entry that
      // serves the prompt tool (was: no --mcp-config without a gated delegation).
      '--mcp-config',
      `${MCP_DIR}/launch-1.mcp.json`
    ])
    expect(run.session?.capabilities.question).toBe('none')
    expect(run.session?.capabilities.permission).toBe('none')
    // The prompt never travels in argv (15 §1.2 DriverLaunchRequest.prompt).
    expect(args.join(' ')).not.toContain('Reply with the single word')
  })

  it('[C-16, SP-15] resume passes --resume with the stored session id and a new id sets previousProviderSessionId', async () => {
    const own = fixture('sp15-resume')
    for (const variant of own.variants) {
      const run = await resumedRun(variant, 1)
      expect(run.resumed, `${variant.label}: the resume resolved`).not.toBeNull()
      const bindings = { session: RECORDED_SESSION }
      // The expected events are the launched session's, up to its exited, then the resumed one's.
      const expected = own.expected.events ?? []
      const cut = expected.findIndex((event) => (event as { t?: string }).t === 'exited') + 1
      const why = [
        ...compareEvents(run.events[0], expected.slice(0, cut), bindings),
        ...compareEvents(run.events[1], expected.slice(cut), bindings),
        ...differences(run.outcomes[4], bind(own.expected.outcomes?.[4] ?? null, bindings), '#4'),
        ...differences(run.sent, bind(own.expected.sent ?? [], bindings), 'sent')
      ]
      expect(why.map((line) => `${variant.label}: ${line}`)).toEqual([])
      // Resume waits out the early-failure window: claude writes nothing before a stdin line, so
      // the resume is still pending at 2 999 ms and ready at 3 000 ms.
      expect(run.outcomes[2]).toEqual({ pendingAt2999: true })
      const args = run.spawn.spawns[1]?.args ?? []
      expect(args).toContain('--resume')
      expect(args[args.indexOf('--resume') + 1]).toBe(RECORDED_SESSION)
      expect(args).not.toContain('--session-id')
      expect(args).not.toContain('--fork-session')
      expect(run.resumed?.ref).toMatchObject({
        providerId: 'claude',
        providerSessionId: RECORDED_SESSION
      })
      expect(run.resumed?.ref.previousProviderSessionId).toBeUndefined()
    }

    // The fork part of the recording is a resume whose system/init names a new id (SP-15).
    const forked = await resumedRun(own.variants[0] as FixtureVariant, 2)
    expect(forked.resumed?.ref).toMatchObject({
      providerSessionId: '00000000-0000-4000-8000-00000000001d',
      previousProviderSessionId: RECORDED_SESSION
    })

    // A ref still live in this Host is never resumed beside itself (ADR-015: one writer).
    const live = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'resume' }],
      { variant: variantOf('s0201-readiness') },
      OPTIONS
    )
    expect(live.outcomes[1]).toEqual({
      rejected: { reason: 'resume-error', detail: expect.any(String) }
    })
  })

  it('[C-16, SP-15] a launched session keeps resume cli-flag through the Claude ceiling (AMENDMENT-18)', async () => {
    // AMENDMENT-18 (owner, 2026-10-16): the ceiling's resume set holds C2's cli-flag, so the merge
    // keeps what the driver negotiates instead of failing it closed to none.
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('s0201-readiness') },
      OPTIONS
    )
    expect(run.session?.capabilities.resume).toBe('cli-flag')
  })

  it('[S-020-1, C-16] a resume that gets an error result before system/init is a resume-error at once', async () => {
    const early = variantOf('s0201-early-exit')
    let spawned = 0
    const resumedTransport = new FixtureTransport({
      received: early.received,
      format: 'jsonl',
      stderr: early.streams.stderr ?? ''
    })
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'transportLost' }, { do: 'resume' }],
      {
        variant: variantOf('s0201-readiness'),
        spawn: (_spec, fixtureOf) => {
          if (spawned++ === 0) return fixtureOf()
          return { kind: 'fixture', transport: resumedTransport }
        }
      },
      OPTIONS
    )
    expect(run.outcomes[2]).toEqual({
      rejected: { reason: 'resume-error', detail: expect.any(String) }
    })
    // Nothing is written on a resume's stdin (15 §1.2), so the failure is the CLI's own.
    expect(resumedTransport.sent).toEqual([])
    expect(resumedTransport.stdin.writableEnded).toBe(true)
  })

  it('[S-020-1] the recorded readiness line makes earlyFailure handshake', async () => {
    const { run } = await launched()
    expect(run.session?.capabilities.earlyFailure).toBe('handshake')
    expect(capabilitiesFromHelp(HELP_2_1_301, SPIKE_RECORDS).earlyFailure).toBe('handshake')
    expect(
      capabilitiesFromHelp(HELP_2_1_301, { ...SPIKE_RECORDS, s0201: false }).earlyFailure
    ).toBe('exit-only')
    expect(SPIKE_RECORDS).toEqual({ sp08: true, s0201: true, sp15: true })
  })

  it('[S-020-1, C-01] the SessionStart hook lines are not readiness: launch waits for system/init', async () => {
    const hooks = splitLines(variantOf('s0201-readiness').received)
      .filter((line) => line.includes('"subtype":"hook_'))
      .join('')
    expect(hooks).not.toBe('')
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'advance', ms: 29_999 }, { do: 'advance', ms: 1 }],
      {
        variant: null,
        spawn: () => ({
          kind: 'fixture',
          transport: new FixtureTransport({ received: hooks, format: 'jsonl' })
        })
      },
      OPTIONS
    )
    expect(run.pendingAtStep[2]).toEqual([0])
    expect(run.outcomes[0]).toEqual({
      rejected: { cause: 'could-not-start', detail: 'handshake timeout' }
    })
  })

  it('[S-020-1, C-04] an error result before system/init rejects the launch at once as exited-at-once', async () => {
    expect(await againstExpected('s0201-early-exit')).toEqual([])
    const run = await runScript(
      factoryWith(),
      fixture('s0201-early-exit').expected.script,
      { variant: variantOf('s0201-early-exit') },
      OPTIONS
    )
    const rejected = (run.outcomes[0] as { rejected: { toolOutputTail?: string } }).rejected
    expect(rejected.toolOutputTail).toContain('No conversation found with session ID')
    // The process is told to end: its stdin is closed.
    expect(run.transports[0]?.stdin.writableEnded).toBe(true)
  })

  it('[C-19, SP-10] the recorded denied write reads as a failed tool step and a concluded turn; permission_denied and thinking_tokens add nothing', async () => {
    expect(await againstExpected('sp10-deny')).toEqual([])
    expect(await againstExpected('sp10-question')).toEqual([])
  })

  it('[C-05] a second turn written on stdin is echoed with echoOf and ends at its own result line', async () => {
    expect(await againstExpected('c-05-send-turn')).toEqual([])
  })

  it('[C-05, ADR-009] a subagent line is not the root session and yields no event of its own', async () => {
    expect(await againstExpected('subagent')).toEqual([])
  })

  it('[C-20, ADR-020] the CLI reporting it is not logged in is error auth-required, never a sixth launch cause', async () => {
    expect(await againstExpected('auth-error')).toEqual([])
  })

  it('[C-21, ADR-006] a rejected rate_limit_event is error rate-limited with its reset instant', async () => {
    expect(await againstExpected('rate-limit')).toEqual([])
  })

  it('[C-19, ADR-009] a malformed or unknown line is skipped as protocol drift, once per drift, and the session continues', async () => {
    expect(await againstExpected('protocol-drift')).toEqual([])
  })

  it('[C-05] a turn with attachments is refused as a channel error, never sent without them', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('s0201-readiness') },
      OPTIONS
    )
    const session = run.session as DriverSession
    await expect(
      session.sendTurn({
        messageId: 'm-1' as never,
        kind: 'message',
        text: 'look at this',
        attachments: [{ path: '/work/mine/a.png', name: 'a.png', bytes: 3 }]
      })
    ).rejects.toEqual({ kind: 'channel-error', reason: expect.any(String) })
    expect(run.transports[0]?.sent).toHaveLength(1)
  })
})

// ---------- the delegation entry (ISSUE-201 "Tests to write FIRST" item 1) ----------

/** The hand-written parts of `gated-delegation-launch.expected.json` that the harness does not read. */
interface GatedExpected {
  readonly launchArgv: readonly string[]
  readonly mcpConfigFile: { readonly path: string; readonly content: Json }
}

const GATED = 'gated-delegation-launch'
const gatedExpected = fixture(GATED).expected as unknown as GatedExpected
/** The two tools DwarfAI's relay serves, as Claude names them under the `dwarfai` entry. */
const JEV_TOOLS = 'mcp__dwarfai__delegate_subtask,mcp__dwarfai__subtask_result'

/** One run of the gated launch fixture per variant, each over its own file store. */
async function gatedRuns(
  extra: { do: 'transportLost' }[] = []
): Promise<{ label: string; run: Run; files: RecordingMcpConfigFiles; failures: string[] }[]> {
  const own = fixture(GATED)
  const out = []
  for (const variant of own.variants) {
    const files = new RecordingMcpConfigFiles()
    const run = await runScript(
      factoryWith(files),
      [...own.expected.script, ...extra],
      { variant },
      OPTIONS
    )
    const failures = [
      ...run.failures,
      ...compareEvents(run.events, own.expected.events ?? [], run.bindings),
      ...differences(run.outcomes[0], bind(own.expected.outcomes?.[0] ?? null, run.bindings), '#0'),
      ...differences(run.sent, bind(own.expected.sent ?? [], run.bindings), 'sent')
    ]
    out.push({ label: variant.label, run, files, failures })
  }
  return out
}

/** Every text a captured process or the mcp-config file holds: argv, env values, file contents. */
function capturedTexts(run: Run, files: RecordingMcpConfigFiles): string[] {
  return [
    ...run.spawn.spawns.flatMap((spawn) => [
      spawn.executable,
      ...spawn.args,
      ...Object.entries(spawn.env).flat()
    ]),
    ...files.written.values()
  ]
}

describe('ClaudeStreamJsonDriver delegation entry', () => {
  it('[C-23, INV-59, INV-83] a gated delegation launch puts no credential and no DWARFAI_DELEGATION_TOKEN string in any captured argv, env or the mcp-config file; the file holds only the relay command and the credential-file path', async () => {
    for (const { label, run, files, failures } of await gatedRuns()) {
      expect(failures, label).toEqual([])
      expect(
        run.spawn.spawns.map((spawn) => spawn.args),
        label
      ).toEqual([gatedExpected.launchArgv])
      expect([...files.written.keys()], label).toEqual([gatedExpected.mcpConfigFile.path])
      const text = files.written.get(gatedExpected.mcpConfigFile.path) ?? ''
      expect(JSON.parse(text), label).toEqual(gatedExpected.mcpConfigFile.content)
      for (const captured of capturedTexts(run, files)) {
        expect(captured, label).not.toContain(CANARY_TOKEN)
        expect(captured, label).not.toContain('DWARFAI_DELEGATION_TOKEN')
      }
    }
  })

  it("[C-23] DWARFAI_SPAWN is in the claude child's env and ELECTRON_RUN_AS_NODE and DWARFAI_MCP_CREDENTIAL_FILE are only in the relay entry's env", async () => {
    for (const { label, run, files } of await gatedRuns()) {
      const [claude, ...others] = run.spawn.spawns
      expect(others, label).toEqual([])
      expect(claude?.env.DWARFAI_SPAWN, label).toBe('v1:conformance:launch-1:1')
      for (const name of ['ELECTRON_RUN_AS_NODE', 'DWARFAI_MCP_CREDENTIAL_FILE']) {
        expect(claude?.env, `${label} ${name}`).not.toHaveProperty(name)
        expect(claude?.args.join(' '), `${label} ${name}`).not.toContain(name)
      }
      const config = JSON.parse(files.written.get(gatedExpected.mcpConfigFile.path) ?? '{}') as {
        mcpServers: Record<string, { env: Record<string, string> }>
      }
      expect(Object.keys(config.mcpServers), label).toEqual(['dwarfai'])
      expect(Object.keys(config.mcpServers.dwarfai?.env ?? {}).sort(), label).toEqual([
        'DWARFAI_MCP_CREDENTIAL_FILE',
        'ELECTRON_RUN_AS_NODE'
      ])
    }
  })

  it('[C-24] a launch without both gates has no Jev entry and no pre-approval, and no launch carries a forbidden flag', async () => {
    // Without both gates `issueFor` gives no entry (ADR-013 item 4): the request carries none.
    // AMENDED by AMENDMENT-21 (owner, 2026-10-17; was: no file and no --mcp-config): the launch
    // still carries the relay entry the prompt tool needs, but never the pre-approval.
    const ungated = await launched()
    const [plain] = ungated.run.spawn.spawns
    expect(ungated.files.written.size).toBe(1)
    expect(plain?.args).toContain('--mcp-config')
    expect(plain?.args.some((arg) => /^--allowed-?tools/i.test(arg))).toBe(false)
    expect(plain?.args.join(' ')).not.toMatch(/delegate_subtask|subtask_result/)
    // With both gates on, exactly the two DwarfAI tools are pre-approved, nothing else.
    const [first] = await gatedRuns()
    const args: readonly string[] = first?.run.spawn.spawns[0]?.args ?? []
    const allowed = args.flatMap((arg, index) =>
      /^--allowed-?tools/i.test(arg) ? [args[index + 1] ?? ''] : []
    )
    expect(allowed).toEqual([JEV_TOOLS])
    for (const argv of [plain?.args ?? [], args]) {
      for (const flag of FORBIDDEN_FLAGS) {
        expect(argv.join(' ').toLowerCase()).not.toContain(flag.toLowerCase())
      }
    }
    // A permission mode cannot smuggle the pre-approval into an ungated launch.
    expect(() =>
      buildArgv({
        kind: 'launch',
        sessionId: SESSION,
        mcpConfigPath: null,
        policyArgv: ['--allowedTools', JEV_TOOLS]
      })
    ).toThrow(/forbidden/)
  })

  it("[C-24, INV-81] a delegated worker's launch, which issueFor gives no delegation entry, has no Jev entry and no pre-approval", async () => {
    // Depth 1 (ADR-013 item 4): a worker's request carries `delegation: null`, like an ungated one.
    // AMENDED by AMENDMENT-21 (owner, 2026-10-17; was: no file and no --mcp-config): a worker's
    // launch carries the relay entry for its prompt tool; the pre-approval stays absent.
    const { run, files } = await launched({ delegation: false })
    expect(files.written.size).toBe(1)
    const args = run.spawn.spawns[0]?.args ?? []
    expect(args).toContain('--mcp-config')
    expect(args.some((arg) => /^--allowed-?tools/i.test(arg))).toBe(false)
    expect(args.join(' ')).not.toMatch(/delegate_subtask|subtask_result/)
  })

  it('[ADR-013] the --mcp-config file is deleted when the session ends', async () => {
    for (const { label, files } of await gatedRuns([{ do: 'transportLost' }])) {
      expect(files.removed, label).toEqual([gatedExpected.mcpConfigFile.path])
    }
    // A launch whose spawn fails after the file was written removes it too.
    const files = new RecordingMcpConfigFiles()
    const failed = await runScript(
      factoryWith(files),
      fixture(GATED).expected.script,
      { variant: null, spawn: () => ({ kind: 'fail', code: 'EACCES' }) },
      OPTIONS
    )
    expect(failed.outcomes[0]).toMatchObject({ rejected: { cause: 'could-not-start' } })
    expect([...files.written.keys()]).toEqual([gatedExpected.mcpConfigFile.path])
    expect(files.removed).toEqual([gatedExpected.mcpConfigFile.path])
  })
})

// ---------- the permission prompt tool (AMENDMENT-21, owner-approved 2026-10-17) ----------

/** A prompt as the relay's `permission` tool hands it over (the SP-08 call's shape). */
const PROMPT: PromptToolCall = {
  toolName: 'Write',
  input: { file_path: '/work/mine/marker.txt', content: 'marker' },
  toolUseId: 'toolu_01'
}

/** A live launched session over the readiness recording, and its prompt tools. */
async function livePrompted(prompts = new RecordingPromptTools()): Promise<{
  run: Run
  session: DriverSession
  prompts: RecordingPromptTools
}> {
  const run = await runScript(
    factoryWith(undefined, undefined, prompts),
    [{ do: 'launch' }],
    { variant: variantOf('s0201-readiness') },
    OPTIONS
  )
  if (run.session === null) throw new Error(`no session: ${JSON.stringify(run.outcomes)}`)
  return { run, session: run.session, prompts }
}

/** Tracks a promise's settlement without awaiting it. */
function watch<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const seen: { settled: boolean; value?: T } = { settled: false }
  void promise.then((value) => Object.assign(seen, { settled: true, value }))
  return seen
}

const asksOf = (run: Run): DriverEvent[] =>
  run.events.filter((event) => event.t === 'ask.opened' || event.t === 'ask.resolved')

describe('ClaudeStreamJsonDriver permission prompt tool (AMENDMENT-21)', () => {
  it('[C-23, ADR-013] a launch without the delegation gates still carries the relay --mcp-config entry: the credential file path only, and no pre-approval', async () => {
    const prompts = new RecordingPromptTools()
    const { run, files } = await launched({}, new RecordingMcpConfigFiles(), prompts)
    const config = `${MCP_DIR}/launch-1.mcp.json`

    expect(prompts.issued).toEqual(['launch-1'])
    expect([...files.written.keys()]).toEqual([config])
    expect(JSON.parse(files.written.get(config) ?? '{}')).toEqual({
      mcpServers: {
        dwarfai: {
          command: '/opt/dwarfai/host/dwarfai',
          args: ['dwarfai-mcp-relay'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_MCP_CREDENTIAL_FILE: '/home/j/.dwarfai/run/mcp/launch-1.cred'
          }
        }
      }
    })
    const args = run.spawn.spawns[0]?.args ?? []
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(config)
    expect(args.some((arg) => /^--allowed-?tools/i.test(arg))).toBe(false)
    for (const captured of capturedTexts(run, files)) expect(captured).not.toContain(CANARY_TOKEN)
    // A gated launch reuses its own entry: no second credential is issued.
    const gated = new RecordingPromptTools()
    await launched({ delegation: true }, new RecordingMcpConfigFiles(), gated)
    expect(gated.issued).toEqual([])
  })

  it('[C-24] the permission tool is never pre-approved: a gated launch allows exactly the two delegation tools, and no argv may name it', async () => {
    const [first] = await gatedRuns()
    const args: readonly string[] = first?.run.spawn.spawns[0]?.args ?? []
    const allowed = args.flatMap((arg, index) =>
      /^--allowed-?tools/i.test(arg) ? [args[index + 1] ?? ''] : []
    )
    expect(allowed).toEqual([JEV_TOOLS])
    expect(allowed.join(',')).not.toContain('mcp__dwarfai__permission')
    for (const delegationGateOn of [false, true]) {
      expect(() =>
        buildArgv({
          kind: 'launch',
          sessionId: SESSION,
          mcpConfigPath: `${MCP_DIR}/launch-1.mcp.json`,
          delegationGateOn,
          policyArgv: ['--allowedTools', 'mcp__dwarfai__permission']
        })
      ).toThrow(/forbidden/)
    }
  })

  it('[C-06, ADR-010] a prompt-tool call opens one driver ask for its tool use, and an Allow settles the call allow and is accepted', async () => {
    const { run, session, prompts } = await livePrompted()
    const sentBefore = run.transports[0]?.sent.length

    const call = watch(prompts.ask('launch-1', PROMPT))
    await settle()

    expect(asksOf(run)).toEqual([
      {
        t: 'ask.opened',
        ask: {
          kind: 'permission',
          providerRequestId: 'toolu_01',
          channel: 'driver',
          payload: { toolName: 'Write', requestText: '/work/mine/marker.txt' },
          options: { hasAllowOnce: true, hasRejectOnce: true }
        }
      }
    ])
    expect(call.settled).toBe(false)
    expect(
      await session.answerPermission({ providerRequestId: 'toolu_01', decision: 'allow' })
    ).toEqual({ kind: 'accepted' })
    await settle()
    expect(call).toEqual({ settled: true, value: 'allow' })
    // The answer goes back through the prompt tool, never on claude's stdin.
    expect(run.transports[0]?.sent.length).toBe(sentBefore)
  })

  it('[C-07, ADR-010] a Deny settles the call deny, is accepted and does not end the turn', async () => {
    const { run, session, prompts } = await livePrompted()
    const call = watch(prompts.ask('launch-1', PROMPT))
    await settle()
    const at = run.events.length

    expect(
      await session.answerPermission({ providerRequestId: 'toolu_01', decision: 'deny' })
    ).toEqual({ kind: 'accepted' })
    await settle()

    expect(call).toEqual({ settled: true, value: 'deny' })
    expect(run.events.slice(at).filter((event) => event.t === 'turn.ended')).toEqual([])
  })

  it('[C-13, ADR-010] the first answer wins: a second or stale answer is refused ask-closed and the call keeps the first', async () => {
    const { session, prompts } = await livePrompted()
    const call = watch(prompts.ask('launch-1', PROMPT))
    await settle()

    const first = session.answerPermission({ providerRequestId: 'toolu_01', decision: 'allow' })
    const second = session.answerPermission({ providerRequestId: 'toolu_01', decision: 'deny' })

    expect(await first).toEqual({ kind: 'accepted' })
    expect(await second).toEqual({ kind: 'refused', reason: 'ask-closed' })
    await settle()
    expect(call).toEqual({ settled: true, value: 'allow' })
    expect(
      await session.answerPermission({ providerRequestId: 'never-asked', decision: 'allow' })
    ).toEqual({ kind: 'refused', reason: 'ask-closed' })
  })

  it('[ADR-010] a cancelled call resolves its ask cancelled and denies; an answer after it is ask-closed', async () => {
    const { run, session, prompts } = await livePrompted()
    const abort = new AbortController()
    const call = watch(prompts.ask('launch-1', PROMPT, abort.signal))
    await settle()

    abort.abort()
    await settle()

    expect(call).toEqual({ settled: true, value: 'deny' })
    expect(asksOf(run).at(-1)).toEqual({
      t: 'ask.resolved',
      providerRequestId: 'toolu_01',
      by: 'cancelled'
    })
    expect(
      await session.answerPermission({ providerRequestId: 'toolu_01', decision: 'allow' })
    ).toEqual({ kind: 'refused', reason: 'ask-closed' })
    // A call already cancelled when it arrives opens no ask.
    const late = new AbortController()
    late.abort()
    expect(await prompts.ask('launch-1', { ...PROMPT, toolUseId: 'toolu_02' }, late.signal)).toBe(
      'deny'
    )
    expect(asksOf(run)).toHaveLength(2)
  })

  it('[ADR-010, ADR-013] the session ending with an ask open denies the call and unregisters its launch', async () => {
    const { run, session, prompts } = await livePrompted()
    expect([...prompts.handlers.keys()]).toEqual(['launch-1'])
    const call = watch(prompts.ask('launch-1', PROMPT))
    await settle()

    for (const transport of run.transports) transport.eof()
    await settle()

    expect(call).toEqual({ settled: true, value: 'deny' })
    expect(prompts.handlers.size).toBe(0)
    expect(
      await session.answerPermission({ providerRequestId: 'toolu_01', decision: 'allow' })
    ).toEqual({ kind: 'refused', reason: 'ask-closed' })
  })

  it('[ADR-013, C-02] a relay that cannot be issued fails the launch could-not-start before any spawn', async () => {
    const prompts = new RecordingPromptTools()
    prompts.fail = true
    const run = await runScript(
      factoryWith(undefined, undefined, prompts),
      [{ do: 'launch' }],
      { variant: variantOf('s0201-readiness') },
      OPTIONS
    )

    expect(run.outcomes[0]).toMatchObject({ rejected: { cause: 'could-not-start' } })
    expect(run.spawn.spawns).toEqual([])
    expect(prompts.handlers.size).toBe(0)
  })

  it('[C-16, ADR-013] a resume carries the relay entry again in a file of its own and takes its launch prompts', async () => {
    const prompts = new RecordingPromptTools()
    const resumed = await resumedRun(
      fixture('sp15-resume').variants[0] as FixtureVariant,
      1,
      prompts
    )
    const args = resumed.spawn.spawns[1]?.args ?? []

    expect(args[args.indexOf('--mcp-config') + 1]).toBe(`${MCP_DIR}/launch-1.resume-1.mcp.json`)
    expect(args.some((arg) => /^--allowed-?tools/i.test(arg))).toBe(false)
    expect(prompts.issued).toEqual(['launch-1'])
    expect([...prompts.handlers.keys()]).toEqual(['launch-1'])
    void prompts.ask('launch-1', PROMPT)
    await settle()
    expect(
      await resumed.resumed?.answerPermission({ providerRequestId: 'toolu_01', decision: 'deny' })
    ).toEqual({ kind: 'accepted' })
  })

  it('[SP-08, C-26] permission is interactive once the probe sees the prompt tool with SP-08 passed, and none otherwise', () => {
    expect(capabilitiesFromHelp(HELP_2_1_301, SPIKE_RECORDS).permission).toBe('interactive')
    expect(capabilitiesFromHelp(null, SPIKE_RECORDS).permission).toBe('none')
    expect(capabilitiesFromHelp(HELP_WITHOUT_FLAG, SPIKE_RECORDS).permission).toBe('none')
    expect(capabilitiesFromHelp(HELP_2_1_301, { ...SPIKE_RECORDS, sp08: false }).permission).toBe(
      'none'
    )
  })
})
