// L4 conformance of the OpenCode `http-server` driver (15 §4.6, §6; 17 §1.4, §2.3; ISSUE-155), with
// the protection mode S-031-3 recorded: none (`spike-results/S-031-3.md`, OpenCode 1.18.32). The
// driver therefore launches nothing (FM-084, option (c) is the `acp` entry), and the 15 §6 cases
// that the harness drives over a launched session (C-01, C-05…C-21, C-23…C-25, C-28, C-29) have no
// session to run on: their launched-side proof is `OpenCodeAcp.conformance.test.ts`. What this
// suite proves on the server side: the gate (C-27), the fail-closed launch and probe (FM-084, no
// password-less listener), the reply vocabulary over the S-011-1 recording (C-06, C-07), the
// SP-14 close (C-28) and the event stream of the recorded runs (C-19), against hand-written
// `*.expected.json` files in `fixtures/opencode/http-server/1.18.32/`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HostEpoch, IntegrationState, ProviderId } from '../../../../../kernel/domain/values'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import { createInstallDetection } from '../../../application/detection'
import { createCapabilityProbing } from '../../../application/probe'
import { merge, negotiatedFor } from '../../../domain/mergeCapabilities'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import { InMemoryCapabilityRecordStore } from '../../../ports/fakes/InMemoryCapabilityRecordStore'
import type {
  DelegationInjection,
  DriverEvent,
  InstalledProvider,
  ProviderDriver
} from '../../../ports/providerDriver'
import {
  LOGIN_ENV,
  runCase,
  runScript,
  type ConformanceOptions,
  type ConformanceRig,
  type DriverFactory
} from '../../../testing/driverConformance'
import { bind, differences, type Json } from '../../../testing/expected'
import { readFixtureSet, type FixtureCase } from '../../../testing/fixtureSet'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS, OPENCODE_ACP } from '../../catalog/profiles'
import { CatalogDriverRegistry } from '../../registry/CatalogDriverRegistry'
import { AcpDriver } from '../acp/AcpDriver'
import { SERVER_PROTECTION } from './capabilities'
import { OpenCodeServerDriver } from './OpenCodeServerDriver'
import { permissionReplyRequest } from './permissionMapping'
import { ServerEventMapper } from './serverEvents'
import { abortRequest, closePlan, configContent } from './serverRequests'

const ROOT = new URL('../../../../../../../', import.meta.url)
const fixtures = readFixtureSet(
  fileURLToPath(new URL('fixtures/opencode/http-server/1.18.32/', ROOT))
)
const HELP = readFileSync(
  fileURLToPath(new URL('spike-results/S-031-3/help/help-root.txt', ROOT)),
  'utf8'
)

const OPENCODE = CATALOG_RECORDS.find((record) => record.profile.id === 'opencode') as CatalogRecord

const INSTALL: InstalledProvider = {
  providerId: OPENCODE.profile.id,
  binaryPath: '/home/j/.opencode/bin/opencode',
  version: '1.18.32',
  resolvedVia: 'path',
  statMtimeMs: 0
}

function detection(rig: Pick<ConformanceRig, 'scheduler'>) {
  const resolver = new FakeInstallResolver()
  resolver.install('opencode', { path: INSTALL.binaryPath, version: '1.18.32' })
  return createInstallDetection({
    resolver,
    fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
    scheduler: rig.scheduler
  })
}

const serverFactory: DriverFactory = (rig) =>
  new OpenCodeServerDriver({
    record: OPENCODE,
    detection: detection(rig),
    processControl: rig.processControl,
    scheduler: rig.scheduler,
    loginEnv: rig.loginEnv,
    home: '/home/j',
    platform: 'linux'
  })

const OPTIONS: ConformanceOptions = { ceiling: OPENCODE.ceiling, install: INSTALL }

/** Every spawn is a CLI that prints the recorded `opencode --help` and exits 0. */
function helpRig(): ConformanceRig {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const processControl = new RecordingSpawn({
    clock,
    scheduler,
    decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: HELP })
  })
  return { clock, scheduler, processControl, loginEnv: LOGIN_ENV }
}

async function settle(rig: ConformanceRig): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    rig.clock.advance(0)
  }
}

/** A driver's probe on a help rig: the fake clock runs the help process to its exit. */
async function probed(driver: ProviderDriver, rig: ConformanceRig) {
  const pending = driver.probe(INSTALL)
  await settle(rig)
  return pending
}

function acpDriver(rig: ConformanceRig): ProviderDriver {
  return new AcpDriver({
    record: OPENCODE,
    row: OPENCODE_ACP.row,
    agentArgs: OPENCODE_ACP.agentArgs,
    detection: detection(rig),
    processControl: rig.processControl,
    clock: rig.clock,
    scheduler: rig.scheduler,
    loginEnv: rig.loginEnv,
    home: '/home/j',
    platform: 'linux',
    redact: (text) => text
  })
}

const DELEGATION: DelegationInjection = {
  mechanism: 'ticket-file',
  relay: { program: '/opt/dwarfai/host/dwarfai', args: ['dwarfai-mcp-relay'] },
  credentialFilePath: '/home/j/.dwarfai/run/mcp/launch-1.cred'
}

function fixture(name: string): FixtureCase {
  const found = fixtures.cases.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no fixture ${name}`)
  return found
}

/** The session id a recorded run's events are about (its `session.created`). */
function sessionOf(events: string): string {
  for (const line of events.split(/\r?\n/)) {
    if (line === '') continue
    const event = JSON.parse(line) as { type?: string; properties?: { sessionID?: string } }
    if (event.type === 'session.created' && event.properties?.sessionID !== undefined) {
      return event.properties.sessionID
    }
  }
  throw new Error('no session.created')
}

function mapAll(events: string, sessionId: string): DriverEvent[] {
  const mapper = new ServerEventMapper({
    providerId: OPENCODE.profile.id,
    sessionId,
    redact: (text) => text
  })
  return events.split(/\r?\n/).flatMap((line) => (line === '' ? [] : mapper.map(line)))
}

describe('OpenCodeServerDriver conformance', () => {
  it('[C-27] with the integration off, on-unverified and on-verified the effective permission is none, none and the ceiling', async () => {
    expect((await runCase('C-27', serverFactory, fixtures, OPTIONS)).failures).toEqual([])
    const rig = helpRig()
    const probe = await probed(serverFactory(rig), rig)
    const permissionAt = (state: IntegrationState) =>
      merge(OPENCODE.ceiling, negotiatedFor([probe], state)).permission
    expect([
      permissionAt('off'),
      permissionAt('on-unverified'),
      permissionAt('on-verified')
    ]).toEqual(['none', 'none', OPENCODE.ceiling.permission])
  })

  it('[FM-084, S-031-3] without a verified protection the server driver reports launch false and the acp entry is offered', async () => {
    expect(SERVER_PROTECTION).toBeNull()
    const rig = helpRig()
    const server = serverFactory(rig)
    const acp = acpDriver(rig)
    const registry = new CatalogDriverRegistry({
      catalogIds: [OPENCODE.profile.id],
      records: [OPENCODE],
      drivers: [acp, server],
      publicBuild: true
    })
    // ADR-009 D4 order: the server driver first, then the acp fallback.
    expect(registry.drivers(OPENCODE.profile.id)).toEqual([server, acp])
    const probing = createCapabilityProbing({
      registry,
      store: new InMemoryCapabilityRecordStore(),
      clock: rig.clock,
      scheduler: rig.scheduler,
      bus: { publish: () => {} },
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-1' as HostEpoch
    })
    const refreshed = probing.refresh(OPENCODE.profile.id as ProviderId)
    await settle(rig)
    await refreshed
    // The recorded help lists `serve`, yet the server driver stays closed: S-031-3 decides.
    expect((await probed(server, rig)).launch).toBe(false)
    const fallback = await probed(acp, rig)
    expect(fallback.launch).toBe(true)
    expect(probing.selected(OPENCODE.profile.id as ProviderId)).toEqual(fallback)
    // A launch of the server driver anyway is refused before any spawn (ADR-020 D1 cause 3).
    const launched = await runScript(serverFactory, [{ do: 'launch' }], { variant: null }, OPTIONS)
    expect(launched.outcomes[0]).toEqual({
      rejected: {
        cause: 'could-not-start',
        detail:
          'no verified protection for a Host-launched opencode serve (S-031-3): OpenCode launches through opencode acp'
      }
    })
  })

  it('[ADR-009] no loopback listener without a password is ever started', async () => {
    const rig = helpRig()
    const server = serverFactory(rig)
    await probed(server, rig)
    const launches = ['launch-1', 'launch-2'].map((launchId) =>
      server
        .launch({
          launchId: launchId as never,
          install: INSTALL,
          cwd: '/work/mine' as never,
          prompt: 'first prompt',
          permissionMode: null,
          delegation: launchId === 'launch-2' ? DELEGATION : null,
          spawnTag: `v1:conformance:${launchId}:1`,
          onSpawned: async () => {}
        })
        .then(
          () => 'resolved',
          () => 'rejected'
        )
    )
    await settle(rig)
    expect(await Promise.all(launches)).toEqual(['rejected', 'rejected'])
    // No Host-launched server exists, so there is none to re-attach either (15 §4.6 adopt).
    await expect(
      server.adopt?.({
        providerId: INSTALL.providerId,
        providerSessionId: 'ses_1',
        serverUrl: 'http://127.0.0.1:47831'
      })
    ).rejects.toEqual({
      reason: 'resume-error',
      detail: 'no Host-launched opencode serve to re-attach (S-031-3)'
    })
    // The one process the driver ever starts is the `--help` probe: never `serve`, never `web`.
    expect(rig.processControl.spawns.map((spawn) => [spawn.executable, ...spawn.args])).toEqual([
      [INSTALL.binaryPath, '--help']
    ])
  })

  it('[C-23] OPENCODE_CONFIG_CONTENT carries only the relay command and the credential file path', () => {
    const content = JSON.parse(configContent(DELEGATION, 'linux')) as Json
    expect(content).toEqual({
      mcp: {
        dwarfai: {
          type: 'local',
          command: ['/opt/dwarfai/host/dwarfai', 'dwarfai-mcp-relay'],
          environment: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_MCP_CREDENTIAL_FILE: '/home/j/.dwarfai/run/mcp/launch-1.cred'
          }
        }
      }
    })
    // Never a credential value, a token or a permission setting.
    const text = JSON.stringify(content)
    expect(text).not.toMatch(/password|token|permission/i)
    expect(() =>
      configContent({ ...DELEGATION, credentialFilePath: 'not-a-path' }, 'linux')
    ).toThrow()
  })

  it('[C-06, C-07] Allow replies once and Deny replies reject, never always', () => {
    const own = fixture('s0111-person-run-deny')
    const allow = permissionReplyRequest('per_1', 'allow', '/work/mine')
    const deny = permissionReplyRequest('per_1', 'deny', '/work/mine')
    expect([allow.body, deny.body]).toEqual([{ reply: 'once' }, { reply: 'reject' }])
    // The S-011-1 run's Deny: the recorded reply body is the one this mapping sends.
    const sent = (own.variants[0]?.streams.sent ?? '')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { body?: unknown })
    expect(
      differences(
        sent.flatMap((request) => (isReply(request.body) ? [request.body] : [])),
        bind((own.expected.sent ?? []) as Json, {})
      )
    ).toEqual([])
  })

  it('[C-28, SP-14, FM-080] close uses the abort endpoint when recorded, else falls to the tree kill of the Host own server', () => {
    const request = abortRequest('ses_1', '/work/mine')
    expect(request).toEqual({
      method: 'POST',
      path: '/session/ses_1/abort?directory=%2Fwork%2Fmine'
    })
    expect(closePlan('ses_1', '/work/mine', true)).toEqual({ kind: 'abort', request })
    expect(closePlan('ses_1', '/work/mine', false)).toEqual({ kind: 'tree-kill-own-server' })
    // SP-14's recorded abort: a POST with no body, answered 200 `true`; the server stayed up.
    const own = fixture('sp12-sp14-serve')
    const sent = (own.variants[0]?.streams.sent ?? '')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method: string; body?: unknown })
    const received = (own.variants[0]?.received ?? '')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { status: number; body?: unknown })
    const abortAt = sent.findIndex(
      (call, index) => call.method === 'POST' && call.body === undefined && index > 0
    )
    expect(sent[abortAt]).toMatchObject({ method: request.method })
    expect(received[abortAt]).toMatchObject({ status: 200, body: true })
  })

  // HO-33: the recorded streams are replayed in every variant and twice.
  it('[C-19] every recorded event stream, in every variant and twice, maps to its expected events and skips what it does not read', () => {
    for (const name of ['s0111-person-run-deny', 'sp12-sp14-serve']) {
      const own = fixture(name)
      for (const variant of own.variants) {
        const events = variant.streams.events ?? ''
        const sessionId = sessionOf(events)
        const want = bind((own.expected.events ?? []) as Json, { session: sessionId })
        const first = mapAll(events, sessionId)
        expect(differences(first, want), `${name} (${variant.label})`).toEqual([])
        expect(mapAll(events, sessionId)).toEqual(first)
      }
    }
    // A line that is not JSON, or an event of another session, is skipped; a broken read event is
    // one protocol-drift error, and the stream goes on.
    const mapper = new ServerEventMapper({
      providerId: 'opencode',
      sessionId: 'ses_1',
      redact: (t) => t
    })
    expect(mapper.map('not json')).toEqual([])
    expect(
      mapper.map(
        JSON.stringify({
          type: 'session.status',
          properties: { sessionID: 'ses_2', status: { type: 'busy' } }
        })
      )
    ).toEqual([])
    expect(
      mapper.map(JSON.stringify({ type: 'permission.asked', properties: { sessionID: 'ses_1' } }))
    ).toEqual([
      { t: 'error', cause: { kind: 'protocol-drift', detail: 'permission.asked without an id' } }
    ])
    expect(
      mapper.map(
        JSON.stringify({
          type: 'session.status',
          properties: { sessionID: 'ses_1', status: { type: 'busy' } }
        })
      )
    ).toEqual([{ t: 'status', value: 'working' }])
  })
})

function isReply(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'reply' in body
}
