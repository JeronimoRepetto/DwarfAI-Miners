// L4 conformance of the generic ACP driver (15 §4.10, §6; 17 §1.4, §2.3): the harness run over the
// synthetic set of `fixtures/acp-generic/acp/1/` (`ci-synthetic`: a generic ACP agent, no provider,
// no CLI run), then the driver's own cases of ISSUE-154. Every `*.expected.json` is written by hand
// from the contract. The catalog record is a synthetic one: OpenCode `acp` (ISSUE-155) and Kiro
// (ISSUE-158) bring their own.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import type { PassThrough } from 'node:stream'
import { FakeProcessControl } from '../../../../../kernel/fakes/FakeProcessControl'
import type {
  ProcessControl,
  SpawnSpec,
  SpawnedProcess
} from '../../../../../kernel/ports/processControl'
import { createInstallDetection } from '../../../application/detection'
import { ceilingOf, type ProviderCapabilities } from '../../../domain/capabilities'
import type { CatalogRecord, PermissionModeCatalog } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type { InstalledProvider, SessionRef } from '../../../ports/providerDriver'
import {
  LOGIN_ENV,
  driverConformance,
  runCase,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory
} from '../../../testing/driverConformance'
import { bind, compareEvents, differences } from '../../../testing/expected'
import { readFixtureSet, type FixtureCase, type FixtureVariant } from '../../../testing/fixtureSet'
import { FixtureTransport } from '../../../testing/fixtureTransport'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { publicLaunchOf } from '../../catalog/profiles'
import { CatalogDriverRegistry } from '../../registry/CatalogDriverRegistry'
import { AcpDriver } from './AcpDriver'

const fixtures = readFixtureSet(
  fileURLToPath(new URL('../../../../../../../fixtures/acp-generic/acp/1/', import.meta.url))
)

/** The synthetic agent's design row (15 §3 style): what a verified ACP agent would report. */
const ROW: ProviderCapabilities = {
  launch: true,
  observe: false,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'none',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}

function recordOf(
  row: ProviderCapabilities,
  modes?: PermissionModeCatalog,
  id = 'acp-generic'
): CatalogRecord {
  const ceiling = { ...ceilingOf(row), resume: ['load', 'resume', 'none'] as const }
  return {
    profile: {
      id,
      label: 'Synthetic ACP agent',
      binaries: ['synthetic-agent'],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['acp'],
      publicLaunch: publicLaunchOf(ceiling, modes)
    },
    ceiling,
    ...(modes === undefined ? {} : { modes })
  }
}

const RECORD = recordOf(ROW)
const AGENT_ARGS = ['acp']

const INSTALL: InstalledProvider = {
  providerId: RECORD.profile.id,
  binaryPath: '/home/j/.local/bin/synthetic-agent',
  version: '1',
  resolvedVia: 'path',
  statMtimeMs: 0
}

const HELP_WITH_ACP = [
  'Usage: synthetic-agent [command]',
  '',
  'Commands:',
  '  chat   Start an interactive chat',
  '  acp    Start the agent over the Agent Client Protocol',
  ''
].join('\n')

interface FactoryOptions {
  readonly row?: ProviderCapabilities
  readonly record?: CatalogRecord
  readonly pinnedMode?: string
  readonly help?: string
}

/**
 * Every `--help` spawn prints `help` and exits 0 at once; every other spawn is the run's (a
 * fixture transport), so a probe never consumes a recorded process.
 */
function withHelp(rig: ConformanceRig, help: string): ProcessControl {
  const printer = new FakeProcessControl({ clock: rig.clock })
  const run = rig.processControl
  const printHelp = (spec: SpawnSpec): SpawnedProcess => {
    const spawned = printer.spawn(spec)
    void spawned.identity.then((identity) => {
      ;(spawned.stdout as PassThrough | null)?.end(help)
      ;(spawned.stderr as PassThrough | null)?.end()
      printer.exit(identity.pid, { code: 0, signal: null })
    })
    return spawned
  }
  return {
    probe: (pid) => run.probe(pid),
    isRunning: (pid) => run.isRunning(pid),
    listProcesses: (filter) => run.listProcesses(filter),
    sameProcess: (a, b) => run.sameProcess(a, b),
    spawn: (spec) => (spec.args.includes('--help') ? printHelp(spec) : run.spawn(spec)),
    killTree: (target, opts) => run.killTree(target, opts),
    currentBootIdentity: () => run.currentBootIdentity()
  }
}

function factoryWith(options: FactoryOptions = {}): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('synthetic-agent', { path: INSTALL.binaryPath, version: '1' })
    return new AcpDriver({
      record: options.record ?? RECORD,
      row: options.row ?? ROW,
      agentArgs: AGENT_ARGS,
      ...(options.pinnedMode === undefined ? {} : { pinnedMode: options.pinnedMode }),
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: withHelp(rig, options.help ?? HELP_WITH_ACP),
      clock: rig.clock,
      scheduler: rig.scheduler,
      loginEnv: rig.loginEnv,
      home: '/home/j',
      platform: 'linux',
      redact: (text) => text
    })
  }
}

const OPTIONS: ConformanceOptions = {
  ceiling: RECORD.ceiling,
  install: INSTALL,
  cases: {
    'C-12': {
      inapplicable: 'answeredElsewhere is false: ACP reports no resolution outside DwarfAI'
    },
    'C-17': { inapplicable: 'adopt is false: a stdio agent re-attaches nothing' },
    'C-22': {
      inapplicable:
        'no policy-only mode is offered: an ACP agent asks through session/request_permission, and one with no verified deny is not launchable in public builds (15 §2.8)'
    },
    'C-26': { inapplicable: 'the help probe gate is the stream-json driver’s (ADR-009 D4)' },
    'C-27': { inapplicable: 'the synthetic profile has no answer-channel gate' }
  }
}

driverConformance('AcpDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the driver's own cases (ISSUE-154 "Tests to write FIRST" item 2) ----------

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

const SESSION = '00000000-0000-4000-8000-00000000ac01'

/** A transport replaying `lines`, each gated on how many frames the driver sent before it. */
function replay(lines: readonly unknown[], gates: readonly number[]) {
  return {
    kind: 'fixture' as const,
    transport: new FixtureTransport({
      received: lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      format: 'jsonl',
      gates
    })
  }
}

const initialized = (agentCapabilities: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 0,
  result: { protocolVersion: 1, agentCapabilities }
})

const methods = (frames: readonly unknown[]): string[] =>
  frames.flatMap((frame) => {
    const method = (frame as { method?: unknown }).method
    return typeof method === 'string' ? [method] : []
  })

describe('AcpDriver', () => {
  it('[C-11] with neither allow_once nor reject_once the driver replies with a JSON-RPC error (F-ACP-NOREJECT)', async () => {
    expect(await againstExpected('f-acp-noreject')).toEqual([])
    const run = await runScript(
      factoryWith(),
      fixture('f-acp-noreject').expected.script,
      { variant: variantOf('f-acp-noreject') },
      OPTIONS
    )
    // The reply to the request is an error, never a selected option (no allow_always, ever).
    expect(run.sent.filter((frame) => (frame as { id?: unknown }).id === 131)).toEqual([
      {
        jsonrpc: '2.0',
        id: 131,
        error: { code: -32603, message: 'Internal error: denied: no reject_once option' }
      }
    ])
  })

  it('[C-16] an agent that advertises session/load replays and one without it uses session/resume or reports resume none', async () => {
    // Both fixtures (session/load with replay; session/resume without) pass the C-16 case.
    expect((await runCase('C-16', factoryWith(), fixtures, OPTIONS)).failures).toEqual([])
    const loaded = await runScript(
      factoryWith(),
      fixture('c-16-resume').expected.script,
      { variant: variantOf('c-16-resume') },
      OPTIONS
    )
    expect(methods(loaded.sent)).toContain('session/load')
    const resumed = await runScript(
      factoryWith(),
      fixture('c-16-resume-no-load').expected.script,
      { variant: variantOf('c-16-resume-no-load') },
      OPTIONS
    )
    expect(resumed.session?.capabilities.resume).toBe('resume')
    expect(methods(resumed.sent)).not.toContain('session/load')
    // An agent offering neither: the session reports resume none and nothing is spawned again.
    let spawned = 0
    const agent = replay(
      [
        initialized({ sessionCapabilities: { close: {} } }),
        { jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } },
        { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
      ],
      [1, 2, 3]
    )
    const neither = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      {
        variant: variantOf('c-01-launch'),
        spawn: () => {
          spawned += 1
          return agent
        }
      },
      OPTIONS
    )
    expect(neither.outcomes[0]).toEqual({ resolved: true })
    expect(neither.session?.capabilities.resume).toBe('none')
    // The transport is lost (CH-04), so the session is no longer live in this Host.
    agent.transport.eof()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ref = neither.session?.ref as SessionRef
    await expect(neither.driver.resume?.(ref)).rejects.toEqual({
      reason: 'resume-error',
      detail: 'the agent offers neither session/load nor session/resume'
    })
    expect(spawned).toBe(1)
  })

  it('[C-21] a turn with usage_update notifications yields one sealed fidelity-1 observation per unit key, from its session/prompt usage', async () => {
    expect(await againstExpected('c-21-usage-update')).toEqual([])
    const run = await runScript(
      factoryWith(),
      fixture('c-21-usage-update').expected.script,
      { variant: variantOf('c-21-usage-update') },
      OPTIONS
    )
    const usage = run.events.flatMap((event) => (event.t === 'usage' ? [event.observation] : []))
    expect(usage.map((observation) => [observation.unitKey, observation.fidelity])).toEqual([
      [`${SESSION}:turn:1`, 1]
    ])
  })

  it('[C-22, ADR-011] a profile with permission none and no verified deny is not launchable in a public build', async () => {
    const policyLess: ProviderCapabilities = { ...ROW, permission: 'none', question: 'none' }
    const registryOf = (record: CatalogRecord, publicBuild: boolean) => {
      const driver = factoryWith({ record, row: policyLess })(fakeRig())
      return {
        driver,
        registry: new CatalogDriverRegistry({
          catalogIds: [record.profile.id],
          records: [record],
          drivers: [driver],
          publicBuild
        })
      }
    }
    const unverified = recordOf(policyLess)
    expect(unverified.profile.publicLaunch).toBe('gated')
    const inPublic = registryOf(unverified, true)
    expect(inPublic.registry.drivers(unverified.profile.id)).toEqual([])
    const inDevelopment = registryOf(unverified, false)
    expect(inDevelopment.registry.drivers(unverified.profile.id)).toEqual([inDevelopment.driver])
    // A verified non-interactive deny policy (15 §2.8) is what would let it launch publicly.
    const verified = recordOf(policyLess, { specs: [], denyPolicyVerified: true })
    const withDeny = registryOf(verified, true)
    expect(withDeny.registry.drivers(verified.profile.id)).toEqual([withDeny.driver])
  })

  it('[ADR-009] initialize declares only elicitation.form, never fs or terminal', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }
    })
    // The agent binary is the person's own, started with the profile's ACP arguments only.
    expect(run.spawn.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([
      [INSTALL.binaryPath, ...AGENT_ARGS]
    ])
    // fs and terminal requests are refused with Method not found (c-11).
    expect(await againstExpected('c-11-unknown-request')).toEqual([])
  })

  it('[ADR-009, C-11] a row without a question channel declares no form elicitation in initialize', async () => {
    const run = await runScript(
      factoryWith({ row: { ...ROW, question: 'none' } }),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.sent[0]).toMatchObject({ method: 'initialize', params: { clientCapabilities: {} } })
    expect(
      (run.sent[0] as { params: { clientCapabilities: unknown } }).params.clientCapabilities
    ).toEqual({})
  })

  it('[ADR-009, C-01] probe opens launch only when the person agent --help lists its ACP subcommand', async () => {
    const probeWith = async (help: string) => {
      const run = await runScript(factoryWith({ help }), [], { variant: null }, OPTIONS)
      return run.driver.probe(INSTALL)
    }
    expect((await probeWith(HELP_WITH_ACP)).launch).toBe(true)
    expect(
      (await probeWith('Usage: synthetic-agent [command]\n\n  chat   Start a chat\n')).launch
    ).toBe(false)
    // `acp` as part of another word is not the subcommand.
    expect((await probeWith('Commands:\n  acpx   Something else\n')).launch).toBe(false)
  })

  it('[C-24, ADR-008] an agent that reports a session mode that skips the permission ask fails the launch closed and sends no prompt', async () => {
    expect(await againstExpected('mode-skips-asks')).toEqual([])
    const launchIn = async (mode: string, pinnedMode?: string) => {
      const answers = [
        initialized({}),
        {
          jsonrpc: '2.0',
          id: 1,
          result: {
            sessionId: SESSION,
            modes: {
              currentModeId: mode,
              availableModes: [
                { id: mode, name: mode },
                { id: 'ask', name: 'Ask' }
              ]
            }
          }
        },
        ...(pinnedMode === undefined ? [] : [{ jsonrpc: '2.0', id: 2, result: {} }]),
        {
          jsonrpc: '2.0',
          id: pinnedMode === undefined ? 2 : 3,
          result: { stopReason: 'end_turn' }
        }
      ]
      const agent = replay(
        answers,
        answers.map((_, index) => index + 1)
      )
      const run = await runScript(
        factoryWith(pinnedMode === undefined ? {} : { pinnedMode }),
        [{ do: 'launch' }],
        { variant: variantOf('c-01-launch'), spawn: () => agent },
        OPTIONS
      )
      return { outcome: run.outcomes[0], sent: agent.transport.sent.map((f) => JSON.parse(f)) }
    }
    // ADR-008 item 3's yolo flag, spelt as a mode id.
    const yolo = await launchIn('yolo')
    expect(yolo.outcome).toEqual({
      rejected: {
        cause: 'could-not-start',
        detail: 'the agent reports permission mode yolo, which skips the permission ask'
      }
    })
    expect(methods(yolo.sent)).not.toContain('session/prompt')
    // A mode that asks is left as it is.
    const asking = await launchIn('code')
    expect(asking.outcome).toEqual({ resolved: true })
    expect(methods(asking.sent)).toEqual(['initialize', 'session/new', 'session/prompt'])
    // AMENDMENT-19: a record that pins a mode gets it before the first prompt.
    const pinned = await launchIn('yolo', 'ask')
    expect(pinned.outcome).toEqual({ resolved: true })
    expect(methods(pinned.sent)).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
      'session/prompt'
    ])
  })

  it('[C-23] a row without ticket-file injection sends no relay entry in session/new', async () => {
    const run = await runScript(
      factoryWith({ row: { ...ROW, mcpInjection: 'none' } }),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch'), delegation: true },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    const opened = run.sent.find((frame) => (frame as { method?: string }).method === 'session/new')
    expect(opened).toMatchObject({ params: { cwd: '/work/mine', mcpServers: [] } })
  })
})

/** A rig of fresh doubles for a driver built outside `runScript`. */
function fakeRig(): ConformanceRig {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const processControl = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'fail', code: 'ENOENT' })
  })
  return { clock, scheduler, processControl, loginEnv: LOGIN_ENV }
}
