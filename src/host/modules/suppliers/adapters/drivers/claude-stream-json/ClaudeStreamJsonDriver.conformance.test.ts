// L4 conformance of the Claude `stream-json` driver (15 §4.2, §6; 17 §1.4, §2.3): the harness run
// over the hand-written fixtures of `fixtures/claude/stream-json/2.1.x/` (synthetic until the
// ISSUE-321 recordings replace them), then the driver's own cases of ISSUE-150.
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
import type { DriverSession, InstalledProvider } from '../../../ports/providerDriver'
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
import { bind, compareEvents, differences } from '../../../testing/expected'
import { readFixtureSet, type FixtureCase } from '../../../testing/fixtureSet'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { buildArgv } from './argv'
import { capabilitiesFromHelp, SPIKE_RECORDS } from './capabilities'
import { ClaudeStreamJsonDriver } from './ClaudeStreamJsonDriver'
import type { McpConfigFiles } from './mcpConfigFile'

const FIXTURES = fileURLToPath(
  new URL('../../../../../../../fixtures/claude/stream-json/2.1.x/', import.meta.url)
)
const fixtures = readFixtureSet(FIXTURES)

const CLAUDE = CATALOG_RECORDS.find((record) => record.profile.id === 'claude') as CatalogRecord
const MCP_DIR = '/home/j/.dwarfai/run/mcp'
const SESSION = '00000000-0000-7000-8000-000000000001'

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

function factoryWith(shared?: McpConfigFiles): DriverFactory {
  return (rig: ConformanceRig) => {
    const files = shared ?? new RecordingMcpConfigFiles()
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
      ids: new SequenceIdGenerator(),
      loginEnv: rig.loginEnv,
      home: '/home/j',
      platform: 'linux',
      mcpConfig: { dir: MCP_DIR, files },
      redact: (text) => text
    })
  }
}

const NO_ASK =
  'permission and question are none (15 §3 row C2: the prompt-tool channel is UNVERIFIED until SP-08, and questions stay disabled, ADR-009 D4)'

const OPTIONS: ConformanceOptions = {
  ceiling: CLAUDE.ceiling,
  install: INSTALL,
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
    'C-16': {
      inapplicable:
        'resume is none until SP-15 (15 §3 row C2, U→none); resume() itself is proven by the SP-15 cases below'
    },
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
  files = new RecordingMcpConfigFiles()
): Promise<{ run: Run; files: RecordingMcpConfigFiles }> {
  const variant = fixture('c-01-launch').variants[0]
  if (variant === undefined) throw new Error('no c-01 variant')
  const run = await runScript(
    factoryWith(files),
    [{ do: 'launch' }, { do: 'transportLost' }],
    { variant, ...plan },
    OPTIONS
  )
  return { run, files }
}

const HELP_WITH_FLAG = readFileSync(`${FIXTURES}probe-help-with-prompt-tool.jsonl`, 'utf8')
const HELP_WITHOUT_FLAG = readFileSync(`${FIXTURES}c-26-help-without-prompt-tool.jsonl`, 'utf8')

describe('ClaudeStreamJsonDriver', () => {
  it('[C-26, SP-08] help output without --permission-prompt-tool makes launch false and the driver is not offered', async () => {
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    const spawn = new RecordingSpawn({
      clock,
      scheduler,
      decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: HELP_WITHOUT_FLAG })
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
    expect(probing.selected(CLAUDE.profile.id as ProviderId)?.launch).toBe(false)
    // The probe ran the person's claude with --help, an argv array (15 §2.3), and nothing else.
    expect(spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([
      [INSTALL.binaryPath, '--help']
    ])
    // The help parse itself: only the flag (with --disallowedTools) and a passed SP-08 open launch.
    expect(capabilitiesFromHelp(HELP_WITHOUT_FLAG, { sp08: true }).launch).toBe(false)
    expect(capabilitiesFromHelp(HELP_WITH_FLAG, { sp08: true }).launch).toBe(true)
    expect(capabilitiesFromHelp(HELP_WITH_FLAG, SPIKE_RECORDS).launch).toBe(false)
    expect(capabilitiesFromHelp(null, { sp08: true }).launch).toBe(false)
    const noDisallow = HELP_WITH_FLAG.split('\n')
      .filter((line) => !line.includes('--disallowedTools'))
      .join('\n')
    expect(capabilitiesFromHelp(noDisallow, { sp08: true }).launch).toBe(false)
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
    // Without a gated delegation there is no file and no --mcp-config.
    const plain = await launched()
    expect(plain.files.written.size).toBe(0)
    expect(plain.run.spawn.spawns[0]?.args).not.toContain('--mcp-config')
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
      '--permission-prompt-tool',
      'mcp__dwarfai__permission',
      '--disallowedTools',
      'AskUserQuestion'
    ])
    expect(run.session?.capabilities.question).toBe('none')
    // The prompt never travels in argv (15 §1.2 DriverLaunchRequest.prompt).
    expect(args.join(' ')).not.toContain('first prompt')
  })

  it('[C-16, SP-15] resume passes --resume with the stored session id and a new id sets previousProviderSessionId', async () => {
    const resumed = async (name: string) => {
      const own = fixture(name)
      const variant = own.variants[0]
      if (variant === undefined) throw new Error(`no ${name} variant`)
      return runScript(factoryWith(), own.expected.script, { variant }, OPTIONS)
    }
    const same = await resumed('resume-same-id')
    const args = same.spawn.spawns[1]?.args ?? []
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
    expect(args).not.toContain('--session-id')
    expect(same.session?.ref).toMatchObject({ providerId: 'claude', providerSessionId: SESSION })
    expect(same.session?.ref.previousProviderSessionId).toBeUndefined()
    // Resume writes nothing: there is no prompt to send (15 §1.2).
    expect(same.transports[1]?.sent).toEqual([])

    const other = await resumed('resume-new-id')
    expect(other.session?.ref).toMatchObject({
      providerSessionId: '00000000-0000-4000-8000-0000000000ff',
      previousProviderSessionId: SESSION
    })

    // A ref still live in this Host is never resumed beside itself (ADR-015: one writer).
    const live = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'resume' }],
      { variant: fixture('resume-same-id').variants[0] ?? null },
      OPTIONS
    )
    expect(live.outcomes[1]).toEqual({
      rejected: { reason: 'resume-error', detail: expect.any(String) }
    })
  })

  it('[S-020-1] until the readiness line is recorded, earlyFailure is exit-only', async () => {
    const { run } = await launched()
    expect(run.session?.capabilities.earlyFailure).toBe('exit-only')
    expect(capabilitiesFromHelp(HELP_WITH_FLAG, { sp08: true }).earlyFailure).toBe('exit-only')
    expect(SPIKE_RECORDS).toEqual({ sp08: false })
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
    const variant = fixture('c-01-launch').variants[0] ?? null
    const run = await runScript(factoryWith(), [{ do: 'launch' }], { variant }, OPTIONS)
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
