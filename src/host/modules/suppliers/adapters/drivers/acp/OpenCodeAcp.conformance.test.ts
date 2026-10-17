// L4 conformance of OpenCode's `acp` entry (15 §4.7, §4.10, §6; 17 §1.4, §2.3; ISSUE-155): the
// generic `AcpDriver` configured by the catalog's OpenCode record and `OPENCODE_ACP` (row O2,
// `opencode acp`), run over the recorded OpenCode 1.18.32 set (`fixtures/opencode/acp/1.18.32/`,
// its meta and location) plus the hand-written cases of `1.18.32-synthetic/`, whose agent side is
// that recording's handshake. Every `*.expected.json` is written by hand from the contract.
//
// S-031-3 failed (`spike-results/S-031-3.md`), so ADR-009 D4 option (c) is the launched OpenCode
// driver: this suite is the one that must pass C-01…C-29 (TC-155-01).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FakeProcessControl } from '../../../../../kernel/fakes/FakeProcessControl'
import type {
  ProcessControl,
  SpawnSpec,
  SpawnedProcess
} from '../../../../../kernel/ports/processControl'
import type { IntegrationState } from '../../../../../kernel/domain/values'
import { createInstallDetection } from '../../../application/detection'
import { combineLowest, merge, negotiatedFor } from '../../../domain/mergeCapabilities'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type { InstalledProvider } from '../../../ports/providerDriver'
import {
  driverConformance,
  runCase,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory
} from '../../../testing/driverConformance'
import { readFixtureSet, type FixtureSet, type FixtureVariant } from '../../../testing/fixtureSet'
import { CATALOG_RECORDS, OPENCODE_ACP } from '../../catalog/profiles'
import { AcpDriver } from './AcpDriver'

const FIXTURE_ROOT = new URL('../../../../../../../fixtures/opencode/acp/', import.meta.url)
const recorded = readFixtureSet(fileURLToPath(new URL('1.18.32/', FIXTURE_ROOT)))
const synthetic = readFixtureSet(fileURLToPath(new URL('1.18.32-synthetic/', FIXTURE_ROOT)))
/** One set for the harness: the recorded set's location and meta, with both folders' cases. */
const fixtures: FixtureSet = { ...recorded, cases: [...recorded.cases, ...synthetic.cases] }

const OPENCODE = CATALOG_RECORDS.find((record) => record.profile.id === 'opencode') as CatalogRecord

const INSTALL: InstalledProvider = {
  providerId: OPENCODE.profile.id,
  binaryPath: '/home/j/.opencode/bin/opencode',
  version: '1.18.32',
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** `opencode --help` as OpenCode 1.18.32 printed it (the S-031-3 record's raw output). */
const HELP = readFileSync(
  fileURLToPath(
    new URL('../../../../../../../spike-results/S-031-3/help/help-root.txt', import.meta.url)
  ),
  'utf8'
)

/** Every `--help` spawn prints `help` and exits 0; every other spawn is the run's fixture. */
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

function factoryWith(help = HELP): DriverFactory {
  return (rig: ConformanceRig) => {
    const resolver = new FakeInstallResolver()
    resolver.install('opencode', { path: INSTALL.binaryPath, version: '1.18.32' })
    return new AcpDriver({
      record: OPENCODE,
      row: OPENCODE_ACP.row,
      agentArgs: OPENCODE_ACP.agentArgs,
      detection: createInstallDetection({
        resolver,
        fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
        scheduler: rig.scheduler
      }),
      processControl: withHelp(rig, help),
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
  ceiling: OPENCODE.ceiling,
  install: INSTALL,
  cases: {
    'C-09': { inapplicable: 'OpenCode acp has no question channel (15 §4.7, HR D8)' },
    'C-12': {
      inapplicable: 'answeredElsewhere is false: ACP reports no resolution outside DwarfAI (row O2)'
    },
    'C-16': { inapplicable: 'resume is none: rows O1 and O2 are U→none, below the ceiling' },
    'C-17': { inapplicable: 'adopt is false for a stdio agent (row O2)' },
    'C-22': {
      inapplicable:
        'no policy-only mode is offered: while the integration is not on-verified the broker answers every permission reject (15 §2.8 OpenCode row)'
    },
    'C-26': { inapplicable: 'the help probe gate is the stream-json driver’s (ADR-009 D4)' }
  }
}

driverConformance('OpenCode acp conformance', factoryWith(), fixtures, OPTIONS)

// ---------- the entry's own cases (ISSUE-155 "Tests to write FIRST" item 3) ----------

function variantOf(name: string): FixtureVariant {
  const variant = fixtures.cases.find((fixture) => fixture.name === name)?.variants[0]
  if (variant === undefined) throw new Error(`no ${name} variant`)
  return variant
}

const firstFrame = (text: string): unknown => JSON.parse(text.split('\n')[0] as string)

describe('OpenCode acp', () => {
  it('[C-27] with the integration off, on-unverified and on-verified the effective permission is none, none and the ceiling', async () => {
    expect((await runCase('C-27', factoryWith(), fixtures, OPTIONS)).failures).toEqual([])
    const run = await runScript(factoryWith(), [{ do: 'probe' }], { variant: null }, OPTIONS)
    const probe = run.outcomes[0] as Parameters<typeof combineLowest>[0]
    const permissionAt = (state: IntegrationState) =>
      merge(OPENCODE.ceiling, negotiatedFor([probe], state)).permission
    expect(OPENCODE.profile.answerChannelGate).toBe('opencode-permissions')
    expect(permissionAt('off')).toBe('none')
    expect(permissionAt('on-unverified')).toBe('none')
    expect(permissionAt('on-verified')).toBe(OPENCODE.ceiling.permission)
    // Questions are gated too, and closed anyway: OpenCode acp has none.
    expect(merge(OPENCODE.ceiling, negotiatedFor([probe], 'on-verified')).question).toBe('none')
  })

  it('[C-27, ADR-011] with the gate closed a permission that still arrives is answered reject and one chat line is written', async () => {
    const run = await runScript(
      factoryWith(),
      [
        { do: 'launch' },
        {
          do: 'answerPermission',
          providerRequestId: 'toolu_0000000000000000000000c1',
          decision: 'deny'
        }
      ],
      { variant: variantOf('c-07-permission-deny') },
      OPTIONS
    )
    // The session's sources, lowered by the closed gate (15 §2.1): the broker reads permission
    // none, so the request is born auto-denied with its one system line (ADR-011 item 3, asking
    // S6.03), and its Deny reaches the agent as reject_once, never an always option.
    const session = run.session
    expect(session).not.toBeNull()
    for (const state of ['off', 'on-unverified'] as const) {
      expect(
        merge(OPENCODE.ceiling, negotiatedFor([session?.capabilities ?? {}], state)).permission
      ).toBe('none')
    }
    const opened = run.events.filter((event) => event.t === 'ask.opened')
    expect(opened).toHaveLength(1)
    expect(run.outcomes[1]).toEqual({ kind: 'accepted' })
    const reply = run.sent.find((frame) => (frame as { result?: unknown }).result !== undefined)
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected' } } })
    const chosen = (reply as { result: { outcome: { optionId: string } } }).result.outcome.optionId
    expect(chosen).toMatch(/reject/)
    expect(chosen).not.toMatch(/always/)
  })

  it('[ADR-009, HR D8] initialize declares no elicitation and an elicitation request opens no question card', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-11-unknown-request') },
      OPTIONS
    )
    expect(run.sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} }
    })
    expect(run.events.filter((event) => event.t === 'ask.opened')).toEqual([])
    expect(run.session?.capabilities.question).toBe('none')
  })

  it('[C-01, S-031-3] the entry launches the person opencode with acp and the synthetic handshake is the recorded one', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch') },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    expect(run.spawn.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([
      [INSTALL.binaryPath, 'acp']
    ])
    // The synthetic initialize answer is the recorded OpenCode 1.18.32 one, re-numbered.
    const recording = readFileSync(
      fileURLToPath(new URL('1.18.32/sp12-session-new-mcp.jsonl', FIXTURE_ROOT)),
      'utf8'
    )
    const recordedInit = firstFrame(recording) as { result: unknown }
    const syntheticInit = firstFrame(variantOf('c-01-launch').received) as { result: unknown }
    expect(syntheticInit.result).toEqual(recordedInit.result)
  })

  it('[C-23] session/new carries no relay entry for OpenCode acp, even on a delegation launch', async () => {
    const run = await runScript(
      factoryWith(),
      [{ do: 'launch' }],
      { variant: variantOf('c-01-launch'), delegation: true },
      OPTIONS
    )
    expect(run.outcomes[0]).toEqual({ resolved: true })
    const opened = run.sent.find((frame) => (frame as { method?: string }).method === 'session/new')
    expect(opened).toMatchObject({ params: { cwd: '/work/mine', mcpServers: [] } })
  })

  it('[FM-084, S-031-3] the probe opens launch only when opencode --help lists acp', async () => {
    const probeWith = async (help: string) => {
      const run = await runScript(factoryWith(help), [{ do: 'probe' }], { variant: null }, OPTIONS)
      return (run.outcomes[0] as { launch: boolean }).launch
    }
    expect(await probeWith(HELP)).toBe(true)
    expect(
      await probeWith('Commands:\n  opencode serve   starts a headless opencode server\n')
    ).toBe(false)
  })
})
