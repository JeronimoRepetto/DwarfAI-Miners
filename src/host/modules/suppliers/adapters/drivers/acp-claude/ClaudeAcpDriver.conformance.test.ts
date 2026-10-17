// L4 conformance of the Claude `acp` driver over a user-installed `claude-agent-acp` (15 §4.3,
// §4.10, §6; 17 §1.4, §2.3): the harness run over the scrubbed maintainer recordings of
// `fixtures/claude/acp/2.1.x/` (the person's own @agentclientprotocol/claude-agent-acp 0.93.0 with
// Claude Code 2.1.302) plus the hand-written cases of `2.1.x-synthetic/` that no recording covers,
// then the driver's own cases of ISSUE-151. Every `*.expected.json` is written by hand from the
// contract.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type { DriverSession, InstalledProvider } from '../../../ports/providerDriver'
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
import {
  readFixtureSet,
  type FixtureCase,
  type FixtureSet,
  type FixtureVariant
} from '../../../testing/fixtureSet'
import { FixtureTransport } from '../../../testing/fixtureTransport'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { acpProbeSource } from '../acp/client/capabilities'
import { ADAPTER_BINARY, C3_ROW, ClaudeAcpDriver, EXECUTABLE_PIN } from './ClaudeAcpDriver'

const FIXTURE_ROOT = new URL('../../../../../../../fixtures/claude/acp/', import.meta.url)
const recorded = readFixtureSet(fileURLToPath(new URL('2.1.x/', FIXTURE_ROOT)))
const synthetic = readFixtureSet(fileURLToPath(new URL('2.1.x-synthetic/', FIXTURE_ROOT)))
/** One set for the harness: the recorded set's location and meta, with both folders' cases. */
const fixtures: FixtureSet = { ...recorded, cases: [...recorded.cases, ...synthetic.cases] }

const CLAUDE = CATALOG_RECORDS.find((record) => record.profile.id === 'claude') as CatalogRecord
const ADAPTER_PATH = '/home/j/.npm-global/bin/claude-agent-acp'

const INSTALL: InstalledProvider = {
  providerId: CLAUDE.profile.id,
  binaryPath: '/usr/local/bin/claude',
  version: '2.1.x',
  resolvedVia: 'path',
  statMtimeMs: 0
}

interface FactoryOptions {
  readonly adapter?: boolean
  readonly s0081?: boolean
  readonly loginEnv?: Readonly<Record<string, string>>
}

function factoryWith(options: FactoryOptions = {}): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('claude', { path: INSTALL.binaryPath, version: '2.1.x' })
    if (options.adapter !== false) {
      resolver.install(ADAPTER_BINARY, { path: ADAPTER_PATH, version: '0.0.0-synthetic' })
    }
    return new ClaudeAcpDriver({
      record: CLAUDE,
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: rig.processControl,
      clock: rig.clock,
      scheduler: rig.scheduler,
      loginEnv: options.loginEnv ?? rig.loginEnv,
      platform: 'linux',
      redact: (text) => text,
      ...(options.s0081 === undefined ? {} : { acpLibrary: { s0081: options.s0081 } })
    })
  }
}

const OPTIONS: ConformanceOptions = {
  ceiling: CLAUDE.ceiling,
  install: INSTALL,
  // The person's own claude-agent-acp, resolved like a binary (ADR-009 D5 (a)): the only other
  // executable the driver may start.
  userAdapters: [ADAPTER_PATH],
  cases: {
    'C-12': {
      inapplicable:
        'answeredElsewhere is false: ACP reports no resolution outside DwarfAI (15 §3 row C3)'
    },
    'C-17': { inapplicable: 'adopt is false: a stdio adapter re-attaches nothing (15 §3 row C3)' },
    'C-22': {
      inapplicable:
        'no policy-only mode is offered: without the form capability the adapter removes AskUserQuestion itself (15 §2.8 row Claude acp), and this client always declares it'
    },
    'C-26': { inapplicable: 'the help probe gate is the stream-json driver’s (ADR-009 D4)' },
    'C-27': { inapplicable: 'the Claude profile has no answer-channel gate' }
  }
}

driverConformance('ClaudeAcpDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the driver's own cases (ISSUE-151 "Tests to write FIRST" item 3) ----------

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

describe('ClaudeAcpDriver', () => {
  it('[C-02, ADR-009] without a resolving claude-agent-acp the driver reports not-installed and nothing is spawned', async () => {
    const run = await runScript(
      factoryWith({ adapter: false }),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(await run.driver.detect()).toEqual({ kind: 'not-installed' })
    expect(run.outcomes[0]).toEqual({
      rejected: { cause: 'not-installed', detail: `${ADAPTER_BINARY} is not installed` }
    })
    expect(run.spawn.spawns).toEqual([])
    // With both resolving, detect names the person's claude, never the adapter (15 §2.4).
    const both = await runScript(factoryWith(), [], { variant: null }, OPTIONS)
    expect(await both.driver.detect()).toMatchObject({
      kind: 'installed',
      install: { binaryPath: INSTALL.binaryPath }
    })
  })

  it("[C-23] CLAUDE_CODE_EXECUTABLE is the user's resolved claude and no credential value is in any argv or env", async () => {
    // The person's login environment names another claude (an SDK-bundled one): never used.
    const loginEnv = { ...LOGIN_ENV, [EXECUTABLE_PIN]: '/opt/sdk/vendor/claude' }
    const run = await runScript(
      factoryWith({ loginEnv }),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch'), delegation: true },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.spawn.spawns).toHaveLength(1)
    const [adapter] = run.spawn.spawns
    expect(adapter?.executable).toBe(ADAPTER_PATH)
    expect(adapter?.args).toEqual([])
    expect(adapter?.env[EXECUTABLE_PIN]).toBe(INSTALL.binaryPath)
    expect(adapter?.env.DWARFAI_SPAWN).toBe('v1:conformance:launch-1:1')
    for (const name of [
      'DWARFAI_DELEGATION_TOKEN',
      'DWARFAI_MCP_CREDENTIAL_FILE',
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS'
    ]) {
      expect(adapter?.env).not.toHaveProperty(name)
    }
    const everything = JSON.stringify([adapter?.args, adapter?.env, run.sent])
    expect(everything).not.toContain(CANARY_TOKEN)
    // The relay entry carries the credential file's path, and its own env is the only place the
    // two relay variables appear (15 §4 Delegation relay form).
    const opened = run.sent.find((frame) => (frame as { method?: string }).method === 'session/new')
    expect(opened).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {
        cwd: '/work/mine',
        mcpServers: [
          {
            name: 'dwarfai',
            command: '/opt/dwarfai/host/dwarfai',
            args: ['dwarfai-mcp-relay'],
            env: [
              { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
              {
                name: 'DWARFAI_MCP_CREDENTIAL_FILE',
                value: '/home/j/.dwarfai/run/mcp/launch-1.cred'
              }
            ]
          }
        ]
      }
    })
    // initialize declares only the form elicitation the question card implements (15 §4.10).
    expect(run.sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }
    })
  })

  it('[C-02, ADR-029] on Windows an npm-installed adapter that resolves to a .js entry is started by the person node with the entry as its first argument, never through a shell', async () => {
    const entry =
      'C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\claude-agent-acp\\dist\\index.js'
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const windowsFactory =
      (withNode: boolean): DriverFactory =>
      (rig) => {
        const resolver = new FakeInstallResolver()
        resolver.install('claude', { path: 'C:\\Users\\j\\.local\\bin\\claude.exe' })
        resolver.install(ADAPTER_BINARY, { path: entry })
        if (withNode) resolver.install('node', { path: node })
        return new ClaudeAcpDriver({
          record: CLAUDE,
          detection: createInstallDetection({
            resolver,
            fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
            scheduler: rig.scheduler
          }),
          processControl: rig.processControl,
          clock: rig.clock,
          scheduler: rig.scheduler,
          loginEnv: rig.loginEnv,
          platform: 'win32',
          redact: (text) => text
        })
      }
    const install = { ...INSTALL, binaryPath: 'C:\\Users\\j\\.local\\bin\\claude.exe' }
    const options = { ...OPTIONS, install, userAdapters: [node] }
    const run = await runScript(
      windowsFactory(true),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      options
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([[node, entry]])
    expect(run.spawn.spawns[0]?.env[EXECUTABLE_PIN]).toBe(install.binaryPath)
    // No node the resolver can find: not installed, and nothing is spawned (no shell fallback).
    const noNode = await runScript(
      windowsFactory(false),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      options
    )
    expect(noNode.outcomes[0]).toEqual({
      rejected: {
        cause: 'not-installed',
        detail: `node, which runs ${ADAPTER_BINARY}, is not installed`
      }
    })
    expect(noNode.spawn.spawns).toEqual([])
    // Elsewhere a script adapter is its own program (a shebang entry): unchanged.
    const linux = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(linux.spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([[ADAPTER_PATH]])
  })

  it('[C-16, SP-15] session/load after a Host restart replays history whose sourceKeys dedupe to zero new rows', async () => {
    const own = fixture('c-16-resume')
    for (const variant of own.variants) {
      const run = await runScript(factoryWith(), own.expected.script, { variant }, OPTIONS)
      const [launched, resumed] = run.sessionEvents
      expect(resumed, `${variant.label}: the resume bound a session`).toBeDefined()
      expect(run.session?.ref.providerSessionId).toBe(run.bindings.session)
      expect(run.session?.ref.previousProviderSessionId).toBeUndefined()
      // The replay (the resumed session's events before its next turn) adds no key.
      const known = new Set(sourceKeysOf(launched ?? []))
      const replayed = (resumed ?? []).slice(
        0,
        (resumed ?? []).findIndex((e) => e.t === 'status')
      )
      expect(replayed.map((e) => e.t)).toEqual(['message', 'message'])
      expect(sourceKeysOf(replayed).filter((key) => !known.has(key))).toEqual([])
      // The second adapter process was asked to load the same session, not to open a new one.
      expect(run.spawn.spawns).toHaveLength(2)
      const load = run.sent.find(
        (frame) => (frame as { method?: string }).method === 'session/load'
      )
      expect(load).toMatchObject({ params: { sessionId: run.bindings.session, cwd: '/work/mine' } })
      expect(
        run.sent.filter((f) => (f as { method?: string }).method === 'session/new')
      ).toHaveLength(1)
    }
  })

  it('[C-16, ADR-015] a session id the adapter does not know is a stale ref, and a live one is never resumed', async () => {
    const session = variantOf('c-01-launch')
    let spawned = 0
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'transportLost' }, { do: 'resume' }],
      {
        variant: session,
        spawn: (_spec, fixtureOf) => {
          if (spawned++ === 0) return fixtureOf()
          return {
            kind: 'fixture',
            transport: new FixtureTransport({
              received: [
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 0,
                  result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
                }),
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  error: { code: -32002, message: 'Resource not found' }
                })
              ]
                .map((line) => `${line}\n`)
                .join(''),
              format: 'jsonl',
              gates: [1, 2]
            })
          }
        }
      },
      OPTIONS
    )
    expect(run.outcomes[2]).toEqual({
      rejected: { reason: 'stale-ref', detail: 'the agent refused with -32002' }
    })
    const live = await runScript(
      factoryWith(),
      [{ do: 'launch' }, { do: 'resume' }],
      { variant: session },
      OPTIONS
    )
    expect(live.outcomes[1]).toEqual({
      rejected: { reason: 'resume-error', detail: 'the session is live in this Host' }
    })
  })

  it('[ADR-009] with the ACP SDK license record absent, every ACP driver reports launch false', async () => {
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    const spawn = new RecordingSpawn({
      clock,
      scheduler,
      decide: () => ({ kind: 'fail', code: 'ENOENT' })
    })
    const rig = { clock, scheduler, processControl: spawn, loginEnv: LOGIN_ENV }
    const closed = factoryWith({ s0081: false })(rig)
    expect((await closed.probe(INSTALL)).launch).toBe(false)
    await expect(
      closed.launch({
        launchId: 'launch-1' as never,
        install: INSTALL,
        cwd: '/work/mine' as never,
        prompt: 'first prompt',
        permissionMode: null,
        delegation: null,
        spawnTag: 'v1:conformance:launch-1:1',
        onSpawned: async () => {}
      })
    ).rejects.toMatchObject({ cause: 'could-not-start' })
    expect(spawn.spawns).toEqual([])
    // The generic ACP source closes launch for any row, so no ACP driver is offered (15 §2.4).
    expect(acpProbeSource({ ...C3_ROW }, { s0081: false }).launch).toBe(false)
    expect(acpProbeSource({ launch: true }, { s0081: false })).toEqual({ launch: false })
    // With this build's record (S-008-1, 2026-10-16: bundle yes) the row opens launch.
    expect((await factoryWith()(rig).probe(INSTALL)).launch).toBe(true)
  })

  it('[C-19, ADR-009] a session/update kind the pinned protocol does not have is drift, once per kind, and the session continues', async () => {
    expect(await againstExpected('protocol-drift')).toEqual([])
  })

  it('[C-20, ADR-020] the adapter answering auth_required is error auth-required, never a sixth launch cause', async () => {
    expect(await againstExpected('auth-error')).toEqual([])
  })

  it('[C-13, ADR-010] a second answer for an answered ask is refused ask-closed and sends nothing', async () => {
    expect(await againstExpected('answered-twice')).toEqual([])
  })

  it('[C-05] a turn sent while one runs is held until that turn ends', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-14-refused') },
      OPTIONS
    )
    const session = run.session as DriverSession
    const receipt = await session.sendTurn({
      messageId: 'm-held' as never,
      kind: 'message',
      text: 'after this one',
      attachments: []
    })
    expect(receipt).toEqual({
      confidence: 'unconfirmed',
      heldUntilTurnEnd: true,
      correlation: 'm-held',
      providerTurnId: '2'
    })
    await expect(
      session.sendTurn({
        messageId: 'm-2' as never,
        kind: 'message',
        text: 'look at this',
        attachments: [{ path: '/work/mine/a.png', name: 'a.png', bytes: 3 }]
      })
    ).rejects.toEqual({ kind: 'channel-error', reason: expect.any(String) })
  })
})
