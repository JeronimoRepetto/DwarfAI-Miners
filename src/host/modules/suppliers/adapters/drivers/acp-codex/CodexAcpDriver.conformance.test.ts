// L4 conformance of the Codex `acp` driver over a user-installed `codex-acp` (15 §4.5, §4.10, §6;
// 17 §1.4, §2.3): the harness run over the scrubbed maintainer recordings of
// `fixtures/codex/acp/0.153.4/` (the person's own codex-acp 1.13.1 with CODEX_PATH pinned to their
// codex 0.153.4, recorded on Windows with the adapter run outside this driver; macOS and Linux
// pending) plus the hand-written cases of `0.157.x-synthetic/` that no recording covers, then the
// driver's own cases of ISSUE-153. Every `*.expected.json` is written by hand from the contract.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch, ProviderId } from '../../../../../kernel/domain/values'
import { createInstallDetection } from '../../../application/detection'
import { createCapabilityProbing } from '../../../application/probe'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import { InMemoryCapabilityRecordStore } from '../../../ports/fakes/InMemoryCapabilityRecordStore'
import type { DriverSession, InstalledProvider } from '../../../ports/providerDriver'
import { ProbeTestDriver } from '../../../testing/ProbeTestDriver'
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
import { CatalogDriverRegistry } from '../../registry/CatalogDriverRegistry'
import {
  ADAPTER_BINARY,
  CODEX_PATH,
  CodexAcpDriver,
  MODE_PIN,
  PINNED_MODE,
  X2_ROW,
  type Platform
} from './CodexAcpDriver'

const FIXTURE_ROOT = new URL('../../../../../../../fixtures/codex/acp/', import.meta.url)
const recorded = readFixtureSet(fileURLToPath(new URL('0.153.4/', FIXTURE_ROOT)))
const synthetic = readFixtureSet(fileURLToPath(new URL('0.157.x-synthetic/', FIXTURE_ROOT)))
/** One set for the harness: the recorded set's location and meta, with both folders' cases. */
const fixtures: FixtureSet = { ...recorded, cases: [...recorded.cases, ...synthetic.cases] }

const CODEX = CATALOG_RECORDS.find((record) => record.profile.id === 'codex') as CatalogRecord
const ADAPTER_PATH = '/home/j/.npm-global/bin/codex-acp'

const INSTALL: InstalledProvider = {
  providerId: CODEX.profile.id,
  binaryPath: '/usr/local/bin/codex',
  version: '0.157.0',
  resolvedVia: 'path',
  statMtimeMs: 0
}

interface FactoryOptions {
  readonly adapter?: boolean
  readonly s0081?: boolean
  readonly loginEnv?: Readonly<Record<string, string>>
  readonly platform?: Platform
}

function factoryWith(options: FactoryOptions = {}): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('codex', { path: INSTALL.binaryPath, version: '0.157.0' })
    if (options.adapter !== false) {
      resolver.install(ADAPTER_BINARY, { path: ADAPTER_PATH, version: '0.0.0-synthetic' })
    }
    return new CodexAcpDriver({
      record: CODEX,
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: rig.processControl,
      clock: rig.clock,
      scheduler: rig.scheduler,
      loginEnv: options.loginEnv ?? rig.loginEnv,
      platform: options.platform ?? 'linux',
      redact: (text) => text,
      ...(options.s0081 === undefined ? {} : { acpLibrary: { s0081: options.s0081 } })
    })
  }
}

const OPTIONS: ConformanceOptions = {
  ceiling: CODEX.ceiling,
  install: INSTALL,
  // The person's own codex-acp, resolved like a binary (ADR-009 D5 (a)): the only other
  // executable the driver may start (no S-008-1 bundle row exists for it).
  userAdapters: [ADAPTER_PATH],
  cases: {
    'C-09': {
      inapplicable:
        'question is none: 15 §3 row X2 U→none, so no question card is offered over codex-acp'
    },
    'C-12': {
      inapplicable:
        'answeredElsewhere is false: ACP reports no resolution outside DwarfAI (15 §3 row X2)'
    },
    'C-17': { inapplicable: 'adopt is false: a stdio adapter re-attaches nothing (15 §3 row X2)' },
    'C-22': {
      inapplicable: 'no policy-only mode is offered for Codex acp (15 §2.8 has no Codex acp row)'
    },
    'C-26': { inapplicable: 'the help probe gate is the stream-json driver’s (ADR-009 D4)' },
    'C-27': { inapplicable: 'the Codex profile has no answer-channel gate' }
  }
}

driverConformance('CodexAcpDriver conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the driver's own cases (ISSUE-153 "Tests to write FIRST" item 2) ----------

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

function rig(): ConformanceRig {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const processControl = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'fail', code: 'ENOENT' })
  })
  return { clock, scheduler, processControl, loginEnv: LOGIN_ENV }
}

describe('CodexAcpDriver', () => {
  it('[C-02, ADR-009] codex-acp not bundled and not installed makes the driver not-installed with nothing spawned', async () => {
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
    // With both resolving, detect names the person's codex, never the adapter (15 §2.4).
    const both = await runScript(factoryWith(), [], { variant: null }, OPTIONS)
    expect(await both.driver.detect()).toMatchObject({
      kind: 'installed',
      install: { binaryPath: INSTALL.binaryPath }
    })
  })

  it("[C-23] codexPath is the user's resolved codex and the adapter env is the allowlist", async () => {
    // The person's login environment names another codex (the adapter's bundled @openai/codex)
    // and an auto-approving initial mode: neither reaches the adapter.
    const loginEnv = {
      ...LOGIN_ENV,
      [CODEX_PATH]: '/home/j/.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
      [MODE_PIN]: 'agent-full-access',
      OPENAI_API_KEY: 'never-forwarded'
    }
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
    // No `cli` or `login` subcommand: those run codex through the adapter's own shell path.
    expect(adapter?.args).toEqual([])
    expect(adapter?.env).toEqual({
      PATH: LOGIN_ENV.PATH,
      HOME: LOGIN_ENV.HOME,
      LANG: LOGIN_ENV.LANG,
      DWARFAI_SPAWN: 'v1:conformance:launch-1:1',
      [CODEX_PATH]: INSTALL.binaryPath,
      [MODE_PIN]: PINNED_MODE
    })
    const everything = JSON.stringify([adapter?.args, adapter?.env, run.sent])
    expect(everything).not.toContain(CANARY_TOKEN)
    expect(everything).not.toContain('never-forwarded')
    // mcpInjection none (15 §3 row X2, U→none until SP-12 lists codex-acp): even a gated
    // delegation launch sends no relay entry.
    const opened = run.sent.find((frame) => (frame as { method?: string }).method === 'session/new')
    expect(opened).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: '/work/mine', mcpServers: [] }
    })
  })

  it('[C-24, ADR-008] no forbidden flag and no shell path is used on Windows', async () => {
    // cxacp@bf37821 src/CodexJsonRpcConnection.ts:19-22 starts a pinned codex on Windows through
    // `shell: true` (and src/CodexCli.ts:26-30 does for `codex-acp cli`): 18 C-17 forbids a shell,
    // so on Windows the driver offers no launch and spawns nothing.
    const windows = factoryWith({ platform: 'win32' })
    const install = { ...INSTALL, binaryPath: 'C:\\Users\\j\\.local\\bin\\codex.exe' }
    const run = await runScript(
      windows,
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      { ...OPTIONS, install }
    )
    expect(run.outcomes[0]).toEqual({
      rejected: {
        cause: 'could-not-start',
        detail: 'codex-acp starts codex through a shell on Windows'
      }
    })
    expect(run.spawn.spawns).toEqual([])
    expect((await windows(rig()).probe(install)).launch).toBe(false)
    // On macOS and Linux the adapter is its own program, with no argument and no shell.
    const linux = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(linux.spawn.spawns.map((s) => [s.executable, ...s.args])).toEqual([[ADAPTER_PATH]])
  })

  it('[ADR-009] the Codex profile offers this driver only when app-server-rpc reports launch false', async () => {
    const offered = async (appServerLaunch: boolean): Promise<string | null> => {
      const r = rig()
      const resolver = new FakeInstallResolver()
      resolver.install('codex', { path: INSTALL.binaryPath, version: '0.157.0' })
      const detection = createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: r.scheduler
      })
      const appServer = new ProbeTestDriver({
        profile: CODEX.profile,
        transport: 'app-server-rpc',
        detection,
        probe: async () => ({ ...X2_ROW, resume: 'resume', launch: appServerLaunch })
      })
      const acp = factoryWith()(r)
      const registry = new CatalogDriverRegistry({
        catalogIds: CATALOG_RECORDS.map((record) => record.profile.id),
        records: CATALOG_RECORDS,
        drivers: [acp, appServer],
        publicBuild: true
      })
      const probing = createCapabilityProbing({
        registry,
        store: new InMemoryCapabilityRecordStore(),
        clock: r.clock,
        scheduler: r.scheduler,
        bus: { publish: () => {} },
        ids: new SequenceIdGenerator(),
        hostEpoch: 'epoch-1' as HostEpoch
      })
      expect(registry.drivers('codex' as ProviderId).map((d) => d.transport)).toEqual([
        'app-server-rpc',
        'acp'
      ])
      await probing.refresh('codex' as ProviderId)
      const selected = probing.selected('codex' as ProviderId) as ProviderCapabilities
      return selected.launch ? selected.resume : null
    }
    // A codex whose app-server is offered: CodexAppServerDriver is the one (its resume value).
    expect(await offered(true)).toBe('resume')
    // A codex whose app-server-rpc probe says launch false: this driver is the one offered.
    expect(await offered(false)).toBe('load')
  })

  it('[C-16, SP-15] session/load after a Host restart replays history whose sourceKeys dedupe to zero new rows', async () => {
    const own = fixture('c-16-resume')
    for (const variant of own.variants) {
      const run = await runScript(factoryWith(), own.expected.script, { variant }, OPTIONS)
      const [launched, resumed] = run.sessionEvents
      expect(resumed, `${variant.label}: the resume bound a session`).toBeDefined()
      expect(run.session?.ref.providerSessionId).toBe(run.bindings.session)
      const known = new Set(sourceKeysOf(launched ?? []))
      const replayed = (resumed ?? []).slice(
        0,
        (resumed ?? []).findIndex((e) => e.t === 'status')
      )
      expect(replayed.map((e) => e.t)).toEqual(['message', 'message'])
      expect(sourceKeysOf(replayed).filter((key) => !known.has(key))).toEqual([])
      expect(run.spawn.spawns).toHaveLength(2)
      for (const spawn of run.spawn.spawns) expect(spawn.env[CODEX_PATH]).toBe(INSTALL.binaryPath)
      const load = run.sent.find(
        (frame) => (frame as { method?: string }).method === 'session/load'
      )
      expect(load).toMatchObject({ params: { sessionId: run.bindings.session, cwd: '/work/mine' } })
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

  it('[ADR-009] with the ACP SDK license record absent, the driver reports launch false and spawns nothing', async () => {
    const r = rig()
    const closed = factoryWith({ s0081: false })(r)
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
    expect((r.processControl as RecordingSpawn).spawns).toEqual([])
    expect((await factoryWith()(r).probe(INSTALL)).launch).toBe(true)
  })

  it('[ADR-009, C-25] the probe is the 15 §3 row X2 under the Codex ceiling: question, mcpInjection and subagents none', async () => {
    const caps = await factoryWith()(rig()).probe(INSTALL)
    expect(caps).toMatchObject({
      launch: true,
      permission: 'interactive',
      question: 'none',
      mcpInjection: 'none',
      subagents: 'none',
      resume: 'load',
      usage: { fidelity: 1, rateLimits: false },
      answeredElsewhere: false,
      adopt: false
    })
  })

  it('[C-09, ADR-009] row X2 declares no elicitation, and a form question the adapter sends anyway is refused Method not found and opens no ask', async () => {
    expect(await againstExpected('question-refused')).toEqual([])
  })

  it('[C-07] Deny sends the native decline when _meta.codex.decision is offered, never a cancel listed first', async () => {
    expect(await againstExpected('c-07-deny-prefers-decline')).toEqual([])
  })

  it('[C-07] recorded provider gap: codex 0.153.4 through codex-acp 1.13.1 offers only cancel to reject an escalated command, so a Deny sends cancel and the turn ends interrupted, not by the app', async () => {
    // Not a pass of C-07 (a Deny continues the turn, 15 §2.7): the recording shows no option
    // that rejects without interrupting. Reported to the lead; the harness C-07 case runs over the
    // synthetic decline set only until a Codex version offers decline here.
    expect(await againstExpected('deny-cancel-only')).toEqual([])
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
  })

  // ---------- AMENDMENT-19 (owner, 2026-10-17): the permission mode is pinned ----------

  it('[C-24, ADR-008] a launch whose adapter reports an auto-approving mode is pinned to read-only before its first prompt, and its first tool use still opens a DwarfAI permission ask', async () => {
    expect(await againstExpected('c-24-mode-pin-auto-review')).toEqual([])
    expect(await againstExpected('c-24-mode-pin-full-access')).toEqual([])
  })

  it('[C-24, ADR-008, ADR-020] a session that cannot be put in read-only fails the launch closed as could-not-start and sends no prompt', async () => {
    expect(await againstExpected('c-24-mode-pin-refused')).toEqual([])
    const session = '00000000-0000-4000-8000-0000000c0d01'
    const init = { jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {} } }
    const replay = (lines: readonly unknown[], gates: readonly number[]) => ({
      kind: 'fixture' as const,
      transport: new FixtureTransport({
        received: lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
        format: 'jsonl',
        gates
      })
    })
    const cases: [string, ReturnType<typeof replay>][] = [
      [
        'the agent reports no permission mode',
        replay([init, { jsonrpc: '2.0', id: 1, result: { sessionId: session } }], [1, 2])
      ],
      [
        'the agent kept permission mode agent-full-access after set_mode read-only',
        replay(
          [
            init,
            {
              jsonrpc: '2.0',
              id: 1,
              result: {
                sessionId: session,
                modes: {
                  currentModeId: 'agent-full-access',
                  availableModes: [{ id: 'read-only' }]
                }
              }
            },
            {
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: session,
                update: { sessionUpdate: 'current_mode_update', currentModeId: 'agent-full-access' }
              }
            },
            { jsonrpc: '2.0', id: 2, result: {} }
          ],
          [1, 2, 3, 3]
        )
      ]
    ]
    for (const [detail, transport] of cases) {
      const run = await runScript(
        factoryWith(),
        [{ do: 'launch' }],
        { variant: variantOf('c-01-launch'), spawn: () => transport },
        OPTIONS
      )
      expect(run.outcomes[0]).toEqual({ rejected: { cause: 'could-not-start', detail } })
      expect(
        run.sent.some((frame) => (frame as { method?: string }).method === 'session/prompt')
      ).toBe(false)
    }
  })
})

// ---------- the delegation entry (ISSUE-202 "Tests to write FIRST" item 2) ----------

describe('CodexAcpDriver conformance', () => {
  it('[C-23] the codex-acp launch injects no delegation entry and carries no credential while SP-12 does not cover it', async () => {
    // SP-12 (`spike-results/SP-12.md`) probed codex app-server, opencode and kimi, not codex-acp:
    // row X2 keeps `mcpInjection: 'none'` (15 §4.5), so even an offered entry is not injected.
    expect(X2_ROW.mcpInjection).toBe('none')
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch', delegation: true }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    // The launch was offered a ticket-file entry with its relay and credential file path.
    const offered = run.launches[0]?.request.delegation
    expect(offered).toMatchObject({ mechanism: 'ticket-file' })
    const relay = offered?.relay?.program as string
    const credentialFile = offered?.credentialFilePath as string
    expect([relay, credentialFile].every((value) => value.length > 0)).toBe(true)
    // None of it reaches the adapter's argv or env, or any frame; session/new has no MCP server.
    const opened = run.sent.find((frame) => (frame as { method?: string }).method === 'session/new')
    expect(opened).toMatchObject({ params: { mcpServers: [] } })
    const [adapter] = run.spawn.spawns
    const captured = JSON.stringify([run.spawn.spawns.map((s) => [s.args, s.env]), run.sent])
    for (const absent of [
      relay,
      'dwarfai-mcp-relay',
      credentialFile,
      CANARY_TOKEN,
      'DWARFAI_DELEGATION_TOKEN',
      'DWARFAI_MCP_CREDENTIAL_FILE',
      'ELECTRON_RUN_AS_NODE'
    ]) {
      expect(captured, absent).not.toContain(absent)
    }
    expect(adapter?.env.DWARFAI_SPAWN).toBe(run.launches[0]?.request.spawnTag)
    // The session reports the row's value, not an injection it never made.
    expect(run.session?.capabilities.mcpInjection).toBe('none')
  })
})
