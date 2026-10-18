// L4 conformance of the Codex `app-server-rpc` driver (15 §4.4, §6; 17 §1.4, §2.3): the harness
// run over the scrubbed maintainer recording of `fixtures/codex/app-server-rpc/0.153.4/` (S-015-1
// run 3, Codex 0.153.4) plus the hand-written and assembled cases of `0.153.4-synthetic/` that no
// recording covers (its `meta.json` says which), then the driver's own cases of ISSUE-152. Every
// `*.expected.json` is written by hand from the contract.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch, ProviderId } from '../../../../../kernel/domain/values'
import { createCapabilityProbing } from '../../../application/probe'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeDriverRegistry } from '../../../ports/fakes/FakeDriverRegistry'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import { InMemoryCapabilityRecordStore } from '../../../ports/fakes/InMemoryCapabilityRecordStore'
import type {
  DelegationInjection,
  DriverSession,
  InstalledProvider
} from '../../../ports/providerDriver'
import {
  CANARY_TOKEN,
  LOGIN_ENV,
  driverConformance,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory,
  type RunPlan
} from '../../../testing/driverConformance'
import { bind, compareEvents, differences, type Json } from '../../../testing/expected'
import {
  readFixtureSet,
  type FixtureCase,
  type FixtureSet,
  type FixtureVariant
} from '../../../testing/fixtureSet'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { buildArgv, JEV_TOOLS } from './argv'
import { capabilitiesFromHelp, SPIKE_RECORDS } from './capabilities'
import { CodexAppServerDriver, type RolloutCheck } from './CodexAppServerDriver'

const FIXTURE_ROOT = new URL('../../../../../../../fixtures/codex/app-server-rpc/', import.meta.url)
const RECORDED = fileURLToPath(new URL('0.153.4/', FIXTURE_ROOT))
const SYNTHETIC = fileURLToPath(new URL('0.153.4-synthetic/', FIXTURE_ROOT))
const recorded = readFixtureSet(RECORDED)
const synthetic = readFixtureSet(SYNTHETIC)
/** One set for the harness: the recorded set's location and meta, with both folders' cases. */
const fixtures: FixtureSet = { ...recorded, cases: [...recorded.cases, ...synthetic.cases] }

const CODEX = CATALOG_RECORDS.find((record) => record.profile.id === 'codex') as CatalogRecord
const THREAD = '00000000-0000-4000-8000-000000000001'
const RELAY = '/opt/dwarfai/host/dwarfai'
const CREDENTIAL_FILE = '/home/j/.dwarfai/run/mcp/launch-1.cred'

const INSTALL: InstalledProvider = {
  providerId: CODEX.profile.id,
  binaryPath: '/usr/local/bin/codex',
  version: '0.153.4',
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** What a fresh driver reads of the stored launch record to resume (ISSUE-173). */
type ResumeContextLookup = NonNullable<
  ConstructorParameters<typeof CodexAppServerDriver>[0]['resumeContext']
>

function factoryWith(
  rolloutConfirms?: RolloutCheck,
  resumeContext?: ResumeContextLookup
): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('codex', { path: INSTALL.binaryPath, version: '0.153.4' })
    return new CodexAppServerDriver({
      record: CODEX,
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
      clientInfo: { name: 'dwarfai', version: '0.0.0' },
      redact: (text) => text,
      ...(rolloutConfirms === undefined ? {} : { rolloutConfirms }),
      ...(resumeContext === undefined ? {} : { resumeContext })
    })
  }
}

/**
 * A restarted Host (ISSUE-173): the launch runs on one driver instance and the resume on a new one
 * over the same OS, which knows the session only through `resumeContext`.
 */
function restartedWith(resumeContext?: ResumeContextLookup): DriverFactory {
  return (rig: ConformanceRig) => {
    const launcher = factoryWith()(rig)
    const resumer = factoryWith(undefined, resumeContext)(rig)
    return {
      profile: launcher.profile,
      transport: launcher.transport,
      detect: () => launcher.detect(),
      probe: (install) => launcher.probe(install),
      launch: (req) => launcher.launch(req),
      resume: (ref) => (resumer.resume as NonNullable<typeof resumer.resume>).call(resumer, ref)
    }
  }
}

const OPTIONS: ConformanceOptions = {
  ceiling: CODEX.ceiling,
  install: INSTALL,
  cases: {
    'C-17': {
      inapplicable:
        'adopt is false in v1: S-015-1 failed (the Codex daemon is Unix-only), recovery is thread/resume (ADR-015 item 5)'
    },
    'C-22': {
      inapplicable: 'the Codex profile offers no policy-only permission mode in v1 (15 §2.8)'
    },
    'C-27': { inapplicable: 'the Codex profile has no answer-channel gate' }
  }
}

driverConformance('CodexAppServerDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the driver's own cases (ISSUE-152 "Tests to write FIRST" item 2) ----------

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
async function againstExpected(
  name: string,
  factory = factoryWith(),
  plan: Omit<RunPlan, 'variant'> = {}
): Promise<string[]> {
  const own = fixture(name)
  const out: string[] = []
  for (const variant of own.variants) {
    const run = await runScript(factory, own.expected.script, { ...plan, variant }, OPTIONS)
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

/** The decision of every reply DwarfAI wrote to an approval request. */
function decisionsSent(sent: readonly Json[]): unknown[] {
  return sent.flatMap((frame) => {
    const result = (frame as { result?: { decision?: unknown } }).result
    return result?.decision === undefined ? [] : [result.decision]
  })
}

/** A launch over the recorded C-01 session, delegation gated in or not. */
async function launched(delegation: boolean): Promise<Awaited<ReturnType<typeof runScript>>> {
  return runScript(
    factoryWith(),
    [{ do: 'launch' }, { do: 'transportLost' }],
    { variant: variantOf('s0151b-client1'), delegation },
    OPTIONS
  )
}

/** The recorded Codex 0.153.4 help (S-015-1) and the same help without its app-server line. */
const HELP_0_153_4 = readFileSync(`${RECORDED}probe-help.jsonl`, 'utf8')
const HELP_WITHOUT_APP_SERVER = readFileSync(
  `${SYNTHETIC}c-26-help-without-app-server.jsonl`,
  'utf8'
)

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
  const refreshed = probing.refresh(CODEX.profile.id as ProviderId)
  for (let round = 0; round < 20; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    clock.advance(0)
  }
  await refreshed
  return {
    launch: probing.selected(CODEX.profile.id as ProviderId)?.launch,
    argv: spawn.spawns.map((s) => [s.executable, ...s.args])
  }
}

describe('CodexAppServerDriver', () => {
  it('[C-06, C-07] Allow sends accept and Deny sends decline, never the session-wide accept and never cancel', async () => {
    expect(await againstExpected('c-06-allow')).toEqual([])
    expect(await againstExpected('c-07-deny')).toEqual([])
    for (const name of ['c-06-allow', 'c-07-deny', 'c-11-unknown-request']) {
      const run = await runScript(
        factoryWith(),
        fixture(name).expected.script,
        { variant: variantOf(name) },
        OPTIONS
      )
      for (const decision of decisionsSent(run.sent)) {
        expect(['accept', 'decline']).toContain(decision)
      }
      const text = JSON.stringify(run.sent).toLowerCase()
      for (const flag of FORBIDDEN_FLAGS) expect(text).not.toContain(flag.toLowerCase())
      expect(decisionsSent(run.sent)).not.toContain('cancel')
    }
  })

  it('[C-09] an isSecret question is never rendered: it is declined with the empty answer set', async () => {
    expect(await againstExpected('c-09-secret-question')).toEqual([])
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-09-secret-question') },
      OPTIONS
    )
    const opened = run.events.find((e) => e.t === 'ask.opened')
    expect(opened?.t === 'ask.opened' && opened.ask.kind === 'question' && opened.ask.secret).toBe(
      true
    )
    // An empty answers array is an ordinary answer, never read as a decline (ADR-009 D3).
    expect(await againstExpected('c-09-question')).toEqual([])
  })

  it('[C-12] serverRequest/resolved yields ask.resolved elsewhere and a later answer is refused ask-closed', async () => {
    expect(await againstExpected('c-12-resolved-elsewhere')).toEqual([])
    expect(await againstExpected('c-13-stale-answer')).toEqual([])
  })

  it('[C-23] with delegation gated in the argv carries the credential file path in the jev entry and never the token', async () => {
    const run = await launched(true)
    const [codex] = run.spawn.spawns
    expect(codex?.executable).toBe(INSTALL.binaryPath)
    expect(codex?.args).toEqual([
      'app-server',
      '-c',
      `mcp_servers.jev.command="${RELAY}"`,
      '-c',
      'mcp_servers.jev.args=["dwarfai-mcp-relay"]',
      '-c',
      `mcp_servers.jev.env={ELECTRON_RUN_AS_NODE="1",DWARFAI_MCP_CREDENTIAL_FILE="${CREDENTIAL_FILE}"}`,
      '-c',
      'mcp_servers.jev.tools.delegate_subtask.approval_mode="approve"',
      '-c',
      'mcp_servers.jev.tools.subtask_result.approval_mode="approve"'
    ])
    expect(codex?.args.join(' ')).not.toContain(CANARY_TOKEN)
    expect(JSON.stringify(run.sent)).not.toContain(CANARY_TOKEN)
    // The relay's two variables live only in the entry; the child gets the childEnv allowlist.
    expect(codex?.env.DWARFAI_SPAWN).toBe('v1:conformance:launch-1:1')
    expect(codex?.env).not.toHaveProperty('DWARFAI_MCP_CREDENTIAL_FILE')
    expect(codex?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(codex?.env).not.toHaveProperty('DWARFAI_DELEGATION_TOKEN')
    expect(codex?.env).not.toHaveProperty('NODE_OPTIONS')
    // A relative credential path is refused before any spawn: the entry carries a path, never a value.
    expect(() =>
      buildArgv({
        relay: { program: RELAY, args: ['dwarfai-mcp-relay'] },
        credentialFilePath: CANARY_TOKEN,
        platform: 'linux'
      })
    ).toThrow(/path/)
  })

  it('[C-24] the jev entry pre-approves exactly the two DwarfAI tool names, and without both gates no jev entry exists', async () => {
    expect(JEV_TOOLS).toEqual(['delegate_subtask', 'subtask_result'])
    const gated = (await launched(true)).spawn.spawns[0]?.args ?? []
    const approvals = gated.filter((arg) => arg.includes('approval_mode'))
    expect(approvals).toEqual([
      'mcp_servers.jev.tools.delegate_subtask.approval_mode="approve"',
      'mcp_servers.jev.tools.subtask_result.approval_mode="approve"'
    ])
    const plain = (await launched(false)).spawn.spawns[0]?.args ?? []
    expect(plain).toEqual(['app-server'])
    for (const argv of [gated, plain, buildArgv(null)]) {
      for (const flag of FORBIDDEN_FLAGS) {
        expect(argv.join(' ').toLowerCase()).not.toContain(flag.toLowerCase())
      }
    }
  })

  it('[C-17, ADR-015] adopt is false in v1 and recovery uses thread/resume', async () => {
    const run = await launched(false)
    expect(run.driver.adopt).toBeUndefined()
    expect(SPIKE_RECORDS).toEqual({ sp12: 'partial', s0151: 'failed' })
    expect(capabilitiesFromHelp(HELP_0_153_4)).toMatchObject({
      adopt: false,
      resume: 'resume',
      mcpInjection: 'ticket-file'
    })
    expect(run.session?.capabilities.adopt).toBe(false)
    expect(run.session?.capabilities.resume).toBe('resume')
    const own = fixture('c-16-resume')
    const resumed = await runScript(
      factoryWith(),
      own.expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    const methods = resumed.transports[1]?.sent.map((frame) => JSON.parse(frame).method as string)
    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(resumed.session?.ref).toMatchObject({ providerId: 'codex', providerSessionId: THREAD })
    expect(resumed.session?.ref.previousProviderSessionId).toBeUndefined()
    // The resumed session's own stream is the replay alone: the history's two keys, no exit.
    expect(resumed.sessionEvents[1]?.map((e) => e.t)).toEqual(['message', 'message'])
    // A ref still live in this Host is never resumed beside itself (ADR-015: one writer).
    const live = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'resume' }],
      { variant: variantOf('s0151b-client1') },
      OPTIONS
    )
    expect(live.outcomes[1]).toEqual({
      rejected: { reason: 'resume-error', detail: expect.any(String) }
    })
  })

  it('[C-16, S4.16] a fresh driver instance resumes a stored thread from the launch record lookup, in its folder and with its spawn tag', async () => {
    const own = fixture('c-16-resume')
    const asked: string[] = []
    const resumed = await runScript(
      restartedWith((ref) => {
        asked.push(ref.providerSessionId)
        return ref.providerSessionId === THREAD
          ? { cwd: '/work/stored-mine', spawnTag: 'v1:install-173:launch-1:epoch-2' }
          : null
      }),
      own.expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    expect(asked).toEqual([THREAD])
    expect(resumed.session?.ref).toMatchObject({ providerId: 'codex', providerSessionId: THREAD })
    const methods = resumed.transports[1]?.sent.map((frame) => JSON.parse(frame).method as string)
    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(resumed.spawn.spawns[1]?.cwd).toBe('/work/stored-mine')
    expect(resumed.spawn.spawns[1]?.env.DWARFAI_SPAWN).toBe('v1:install-173:launch-1:epoch-2')

    // No lookup, or a lookup that knows nothing of the thread: a resume-error, nothing spawned.
    for (const lookup of [undefined, () => null]) {
      const unknown = await runScript(
        restartedWith(lookup),
        own.expected.script,
        { variant: variantOf('c-16-resume') },
        OPTIONS
      )
      const at = own.expected.script.findIndex((step) => step.do === 'resume')
      expect(unknown.outcomes[at]).toEqual({
        rejected: { reason: 'resume-error', detail: expect.any(String) }
      })
      expect(unknown.spawn.spawns).toHaveLength(1)
    }
  })

  it('[C-26] a codex without the app-server subcommand makes this driver launch false', async () => {
    const without = await probedLaunch(HELP_WITHOUT_APP_SERVER)
    expect(without.launch).toBe(false)
    // The probe ran the person's codex with --help, an argv array (15 §2.3), and nothing else.
    expect(without.argv).toEqual([[INSTALL.binaryPath, '--help']])
    const recordedHelp = await probedLaunch(HELP_0_153_4)
    expect(recordedHelp.launch).toBe(true)
    expect(capabilitiesFromHelp(null).launch).toBe(false)
    // A mention of app-server in prose is not the subcommand being listed.
    const prose = `${HELP_WITHOUT_APP_SERVER}\n  agents  Browse sessions on the shared app-server daemon\n`
    expect(capabilitiesFromHelp(prose).launch).toBe(false)
  })

  it('[FM-085] a turn answered by a foreign app-server is attributed only when the rollout confirms it', async () => {
    expect(await againstExpected('fm-085-foreign-server')).toEqual([])
    const checks: Parameters<RolloutCheck>[0][] = []
    const confirmed = await runScript(
      factoryWith(async (check) => {
        checks.push(check)
        return true
      }),
      [{ do: 'launch' }],
      { variant: variantOf('fm-085-foreign-server') },
      OPTIONS
    )
    expect(checks).toEqual([
      {
        threadId: THREAD,
        rolloutPath: '/home/j/.codex/sessions/2026/10/17/rollout-sample.jsonl',
        turnId: '0000000a-0000-4000-8000-000000000001'
      }
    ])
    expect(confirmed.events.map((e) => e.t)).toEqual([
      'status',
      'message',
      'message',
      'usage',
      'turn.ended',
      'status'
    ])
    // The driver's own server (the originator is this connection's client) needs no rollout check.
    const own: Parameters<RolloutCheck>[0][] = []
    await runScript(
      factoryWith(async (check) => {
        own.push(check)
        return false
      }),
      [{ do: 'launch' }],
      { variant: variantOf('s0151b-client1') },
      OPTIONS
    )
    expect(own).toEqual([])
  })

  it('[FM-064, ADR-014] closing an observed thread on the person app-server sends turn/interrupt and thread/archive, a protocol error answers failed protocol-error, and the server pid is never signalled', async () => {
    expect(await againstExpected('fm-064-interrupt-and-archive')).toEqual([])
    expect(await againstExpected('fm-064-close-refused')).toEqual([])
    const run = await runScript(
      factoryWith(),
      fixture('fm-064-interrupt-and-archive').expected.script,
      { variant: variantOf('fm-064-interrupt-and-archive') },
      OPTIONS
    )
    expect(run.spawn.killTreeCalls).toBe(0)
    expect(run.spawn.fake.signals).toEqual([])
  })

  it('[C-05] a message sent during a turn is queued and starts its own turn once the open one completed', async () => {
    expect(await againstExpected('queued-turn')).toEqual([])
  })

  it('[C-05] a turn with attachments is refused as a channel error, never sent without them', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('s0151b-client1') },
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
    expect(run.transports[0]?.sent).toHaveLength(4)
  })

  it('[C-21] a reached rate limit is error rate-limited and a provider error carries its code word', async () => {
    expect(await againstExpected('limits-and-errors')).toEqual([])
  })

  it('[C-05, ADR-015] a subagent thread is its own identity and its items are not the parent messages', async () => {
    expect(await againstExpected('subagent')).toEqual([])
  })
})

// ---------- the delegation entry (ISSUE-202 "Tests to write FIRST" item 1) ----------

/** The gated delegation launch: both gates on, so the request carries a ticket-file entry. */
const GATED = 'c-23-gated-delegation'
/** The variables only the relay entry's own env may hold (15 §4 "Delegation relay form"). */
const RELAY_ONLY = ['ELECTRON_RUN_AS_NODE', 'DWARFAI_MCP_CREDENTIAL_FILE'] as const
/** The `-c` key prefix of the Jev entry; any other `-c` key would configure something else. */
const JEV_AT = 'mcp_servers.jev.'

/** The gated case's hand-written argv (without the executable); only this case states one. */
function expectedArgv(): string[] {
  const { argv } = fixture(GATED).expected as { argv?: string[] }
  if (argv === undefined) throw new Error(`${GATED} states no argv`)
  return argv
}

/** The `-c` values of an argv, in order. */
function overrides(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => (argv[index - 1] === '-c' ? [arg] : []))
}

/** The Jev entry's own env as Codex reads it: the TOML inline table of `mcp_servers.jev.env`. */
function jevEnv(argv: readonly string[]): Record<string, string> {
  const setting = overrides(argv).find((value) => value.startsWith(`${JEV_AT}env=`))
  if (setting === undefined) throw new Error('no jev env override')
  // `{KEY="value",…}`: bare keys and TOML basic strings (JSON's escapes), as `argv.ts` writes them.
  const pairs = [...setting.matchAll(/([A-Z_]+)=("(?:[^"\\]|\\.)*")/g)]
  return Object.fromEntries(pairs.map(([, key, value]) => [key, JSON.parse(value as string)]))
}

/** The gated case run over its first variant. */
async function gatedRun(): Promise<Awaited<ReturnType<typeof runScript>>> {
  return runScript(
    factoryWith(),
    fixture(GATED).expected.script,
    { variant: variantOf(GATED) },
    OPTIONS
  )
}

/** Every variant of the gated case against its expected file, the argv included; failures as lines. */
async function gatedAgainstExpected(): Promise<string[]> {
  const own = fixture(GATED)
  const out: string[] = []
  for (const variant of own.variants) {
    const run = await runScript(factoryWith(), own.expected.script, { variant }, OPTIONS)
    const why = [
      ...run.failures,
      ...compareEvents(run.events, own.expected.events ?? [], run.bindings),
      ...(own.expected.outcomes ?? []).flatMap((want, index) =>
        want === null ? [] : differences(run.outcomes[index], bind(want, run.bindings), `#${index}`)
      ),
      ...differences(run.sent, bind(own.expected.sent ?? [], run.bindings), 'sent'),
      ...differences(run.spawn.spawns[0]?.args ?? null, expectedArgv(), 'argv')
    ]
    out.push(...why.map((line) => `${variant.label}: ${line}`))
  }
  return out
}

/** The driver with every launch carrying `delegation` as given, whatever the harness built. */
function launchedWith(delegation: DelegationInjection | null): DriverFactory {
  return (rig: ConformanceRig) => {
    const driver = factoryWith()(rig)
    return {
      profile: driver.profile,
      transport: driver.transport,
      detect: () => driver.detect(),
      probe: (install) => driver.probe(install),
      launch: (req) => driver.launch({ ...req, delegation })
    }
  }
}

describe('CodexAppServerDriver conformance', () => {
  it("[C-23, INV-59, INV-83] a gated delegation launch has no credential and no DWARFAI_DELEGATION_TOKEN string in any captured argv or env; the jev entry's env names only DWARFAI_MCP_CREDENTIAL_FILE with a path", async () => {
    expect(await gatedAgainstExpected()).toEqual([])
    const run = await gatedRun()
    // `codex app-server` is the only process DwarfAI starts; codex starts the relay itself.
    expect(run.spawn.spawns.map((spawn) => spawn.executable)).toEqual([INSTALL.binaryPath])
    const [codex] = run.spawn.spawns
    // The person's login env holds the canary token: it reaches nothing DwarfAI starts or sends.
    const captured = JSON.stringify([codex?.args, codex?.env, run.sent])
    expect(captured).not.toContain(CANARY_TOKEN)
    expect(captured).not.toContain('DWARFAI_DELEGATION_TOKEN')
    // The entry's env is the relay form; its one credential reference is the file path.
    const env = jevEnv(codex?.args ?? [])
    expect(Object.keys(env)).toEqual([...RELAY_ONLY])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.DWARFAI_MCP_CREDENTIAL_FILE).toBe(
      run.launches[0]?.request.delegation?.credentialFilePath
    )
    expect(env.DWARFAI_MCP_CREDENTIAL_FILE).toMatch(/^\/home\/j\/\.dwarfai\/run\/mcp\/[^/]+\.cred$/)
    // Outside the entry's env neither relay variable appears: not in codex's env, another
    // override or a frame.
    const elsewhere = overrides(codex?.args ?? []).filter(
      (value) => !value.startsWith(`${JEV_AT}env=`)
    )
    for (const name of RELAY_ONLY) {
      expect(codex?.env, name).not.toHaveProperty(name)
      expect(JSON.stringify([elsewhere, run.sent]), name).not.toContain(name)
    }
    expect(codex?.env.DWARFAI_SPAWN).toBe(run.launches[0]?.request.spawnTag)
  })

  it('[C-24] with both gates on exactly delegate_subtask and subtask_result are pre-approved inside the jev entry and no other tool, server or session-wide approval appears', async () => {
    const run = await gatedRun()
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.spawn.spawns).toHaveLength(1)
    const argv = run.spawn.spawns[0]?.args ?? []
    const settings = overrides(argv)
    // Every override belongs to the Jev entry: no other server and no global key is set.
    expect(settings.filter((value) => !value.startsWith(JEV_AT))).toEqual([])
    // The approvals are exactly the two DwarfAI tools, each scoped to its own name in the entry.
    expect(JEV_TOOLS).toEqual(['delegate_subtask', 'subtask_result'])
    expect(settings.filter((value) => /approv|bypass|trust|sandbox/i.test(value))).toEqual(
      JEV_TOOLS.map((tool) => `${JEV_AT}tools.${tool}.approval_mode="approve"`)
    )
    // Besides the overrides only the subcommand, no forbidden flag, and the thread asks on request.
    expect(argv.filter((arg, index) => arg !== '-c' && argv[index - 1] !== '-c')).toEqual([
      'app-server'
    ])
    for (const flag of FORBIDDEN_FLAGS) {
      expect(argv.join(' ').toLowerCase()).not.toContain(flag.toLowerCase())
    }
    const started = run.sent.find(
      (frame) => (frame as { method?: string }).method === 'thread/start'
    ) as { params?: Json } | undefined
    expect(started?.params).toEqual({ cwd: '/work/mine', approvalPolicy: 'on-request' })
  })

  it('[C-24, INV-81] without both gates, or for a delegated worker, there is no jev entry and no pre-approval', async () => {
    // Without both gates, and for a delegated worker, `issueFor` gives no entry (ADR-013 item 4),
    // so the request carries `delegation: null`.
    const ungated = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf(GATED) },
      OPTIONS
    )
    expect(ungated.launches[0]?.request.delegation).toBeNull()
    expect(ungated.spawn.spawns[0]?.args).toEqual(['app-server'])
    // A request that is not the ticket-file form this row injects gets no entry either: no
    // protocol entry while SP-12 is partial, and never a relay without its credential file path.
    const relay = { program: '/opt/dwarfai/host/dwarfai', args: ['dwarfai-mcp-relay'] }
    const path = '/home/j/.dwarfai/run/mcp/launch-1.cred'
    const requests: (DelegationInjection | null)[] = [
      null,
      { mechanism: 'protocol', relay, credentialFilePath: path },
      { mechanism: 'ticket-file', relay },
      { mechanism: 'ticket-file', credentialFilePath: path }
    ]
    for (const delegation of requests) {
      const run = await runScript(
        launchedWith(delegation),
        [{ do: 'launch' }],
        { variant: variantOf(GATED) },
        OPTIONS
      )
      expect(run.spawn.spawns[0]?.args, JSON.stringify(delegation)).toEqual(['app-server'])
      const captured = JSON.stringify([run.spawn.spawns[0]?.args, run.sent])
      expect(captured).not.toContain('mcp_servers')
      expect(captured).not.toContain('approval_mode')
    }
  })
})
