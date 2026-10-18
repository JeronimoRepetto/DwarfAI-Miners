// L4 for the person-run OpenCode server attach (ISSUE-237; 15 §4.6 row "Person-run server";
// ADR-017 item 3; 18 C-22; 15 §6 C-23; 13 FM-116), against the hand-written password-protected
// server case `fixtures/opencode/http-server/1.18.32-synthetic/person-run-password*`. The server
// double answers like the one S-031-3 measured: 401 without the right credential, 200 with it.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../../../kernel/fakes/RecordingDiagnosticsLog'
import { SECRET_READ_TIMEOUT_MS } from '../../../../../kernel/ports/secretReader'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type { InstalledProvider } from '../../../ports/providerDriver'
import { LOGIN_ENV } from '../../../testing/driverConformance'
import { readFixtureSet, type FixtureVariant } from '../../../testing/fixtureSet'
import { RecordingSpawn } from '../../../testing/recordingSpawn'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import { OpenCodeServerDriver } from './OpenCodeServerDriver'
import {
  OPENCODE_SERVER_CALL_TIMEOUT_MS,
  OpenCodeServerClient,
  type HttpCall,
  type HttpReply,
  type OpenCodeServerTarget
} from './personRunServer'
import { listSessionsRequest } from './serverRequests'

const ROOT = new URL('../../../../../../../', import.meta.url)
const fixtures = readFixtureSet(
  fileURLToPath(new URL('fixtures/opencode/http-server/1.18.32-synthetic/', ROOT))
)
const CASE = fixtures.cases.find((candidate) => candidate.name === 'person-run-password')
if (CASE === undefined) throw new Error('no person-run-password fixture')

interface ServerScript {
  readonly username: string
  readonly unauthorized: { readonly status: number; readonly body: unknown }
  readonly sessions: { readonly status: number; readonly body: unknown }
}

/** A password with a colon, a space and a non-ASCII letter: Basic must carry it intact. */
const PASSWORD = 'pa:ss wörd-0237'
const SERVER_URL = 'http://127.0.0.1:4096'
const PERSON: OpenCodeServerTarget = { owner: 'person', url: SERVER_URL }

const basic = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`

/** Every form the password could leak in: itself and its Basic credential. */
const LEAK_FORMS = [
  PASSWORD,
  encodeURIComponent(PASSWORD),
  Buffer.from(`opencode:${PASSWORD}`, 'utf8').toString('base64')
]

function world(
  options: { password?: string | null; variant?: FixtureVariant; reply?: 'never' | 'fail' } = {}
) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const stored = options.password === undefined ? PASSWORD : options.password
  const secretReader = new FakeSecretReader({
    scheduler,
    values: stored === null ? {} : { 'opencode-password': stored }
  })
  const log = new RecordingDiagnosticsLog()
  const variant = options.variant ?? (CASE as NonNullable<typeof CASE>).variants[0]
  const script = JSON.parse(variant?.received ?? '{}') as ServerScript
  const calls: HttpCall[] = []
  // The person's server: it was started with PASSWORD, whatever DwarfAI has stored.
  const http = (call: HttpCall): Promise<HttpReply> => {
    calls.push(call)
    if (options.reply === 'never') return new Promise<HttpReply>(() => {})
    if (options.reply === 'fail') return Promise.reject(new TypeError('fetch failed'))
    const authorized = call.headers.authorization === basic(script.username, PASSWORD)
    return Promise.resolve(authorized ? script.sessions : script.unauthorized)
  }
  return {
    clock,
    scheduler,
    secretReader,
    log,
    calls,
    deps: { secretReader, http, scheduler, log }
  }
}

async function settle(clock: FakeClock): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    clock.advance(0)
  }
}

/** Every text DwarfAI produced in a run: request URLs, bodies, headers, log records. */
function everythingSent(w: ReturnType<typeof world>): string {
  return JSON.stringify({
    calls: w.calls,
    entries: w.log.entries,
    refused: w.log.refused
  })
}

describe('OpenCodeServerClient — a person-run opencode serve (15 §4.6; ADR-017 item 3)', () => {
  it('[ADR-017, C-22] requests to a person-run server carry the stored password only in the Authorization header', async () => {
    const expected = (CASE as NonNullable<typeof CASE>).expected
    for (const variant of (CASE as NonNullable<typeof CASE>).variants) {
      const w = world({ variant })
      const client = new OpenCodeServerClient(PERSON, w.deps)

      const outcome = await client.listSessions()

      expect(outcome, variant.label).toStrictEqual(expected.outcomes?.[0])
      expect(w.secretReader.reads).toStrictEqual(['opencode-password'])
      expect(w.calls).toHaveLength(1)
      const [call] = w.calls
      const [sent] = (expected.sent ?? []) as {
        method: string
        path: string
        headers: Record<string, string>
      }[]
      expect(call?.method).toBe(sent?.method)
      expect(call?.url).toBe(`${SERVER_URL}${sent?.path}`)
      expect(call?.headers).toStrictEqual({
        ...sent?.headers,
        authorization: basic('opencode', PASSWORD)
      })
      expect(call?.body).toBeUndefined()
    }
  })

  it('[C-23] the password never appears in a URL, a captured argv or env, or a log record', async () => {
    // The request side, on success and on every failure path that logs.
    const runs = [
      world(),
      world({ password: 'not-the-servers-password' }),
      world({ reply: 'fail' }),
      world({ reply: 'never' })
    ]
    for (const w of runs) {
      const client = new OpenCodeServerClient(PERSON, w.deps)
      const pending = client.listSessions()
      await settle(w.clock)
      w.clock.advance(OPENCODE_SERVER_CALL_TIMEOUT_MS)
      await pending
      for (const call of w.calls) {
        const otherHeaders = Object.entries(call.headers).filter(
          ([name]) => name !== 'authorization'
        )
        const elsewhere = JSON.stringify({ url: call.url, body: call.body, otherHeaders })
        for (const form of LEAK_FORMS) expect(elsewhere).not.toContain(form)
      }
      const logged = JSON.stringify({ entries: w.log.entries, refused: w.log.refused })
      for (const form of LEAK_FORMS) expect(logged).not.toContain(form)
    }
    // The process side: the driver that owns the attach spawns only its `--help` probe, never with
    // the password, and launches nothing (S-031-3).
    const w = world()
    const processControl = new RecordingSpawn({
      clock: w.clock,
      scheduler: w.scheduler,
      decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: 'Commands:\n  opencode serve\n' })
    })
    const driver = serverDriver(w, processControl)
    const probing = driver.probe(INSTALL)
    await settle(w.clock)
    await probing
    await expect(driver.launch()).rejects.toMatchObject({ cause: 'could-not-start' })
    await driver.personRunServer(SERVER_URL)?.listSessions()
    expect(processControl.spawns.length).toBeGreaterThan(0)
    const captured = JSON.stringify(
      processControl.spawns.map((spawn) => ({ args: spawn.args, env: spawn.env }))
    )
    for (const form of LEAK_FORMS) expect(captured).not.toContain(form)
    // The driver's attach is the person-run one: its one call carries the credential in the header.
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.headers.authorization).toBe(basic('opencode', PASSWORD))
  })

  it("[ADR-017] the Host's own opencode serve never receives the person's password", async () => {
    const w = world()
    const own = new OpenCodeServerClient({ owner: 'host', url: SERVER_URL }, w.deps)

    await own.listSessions()

    expect(w.secretReader.reads).toStrictEqual([])
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.headers.authorization).toBeUndefined()
    expect(everythingSent(w)).not.toContain(LEAK_FORMS[2])
    // The driver launches no server of its own (S-031-3), so it never reads the password for one.
    const driverWorld = world()
    const driver = serverDriver(driverWorld)
    await expect(driver.launch()).rejects.toMatchObject({ cause: 'could-not-start' })
    expect(driverWorld.secretReader.reads).toStrictEqual([])
    expect(driverWorld.calls).toStrictEqual([])
  })

  it('[FM-116] a password read that times out yields unavailable and no request is sent', async () => {
    const w = world()
    w.secretReader.blocking = true
    const client = new OpenCodeServerClient(PERSON, w.deps)

    const pending = client.listSessions()
    await settle(w.clock)
    w.clock.advance(SECRET_READ_TIMEOUT_MS)

    expect(await pending).toStrictEqual({ kind: 'unavailable', cause: 'secret-store' })
    expect(w.calls).toStrictEqual([])
    expect(w.log.byEvent('opencode-server.unavailable')).toStrictEqual([
      {
        level: 'warn',
        event: 'opencode-server.unavailable',
        subsystem: 'suppliers',
        provider: 'opencode',
        outcome: 'failed',
        causeClass: 'password-timeout'
      }
    ])
  })

  it('[ADR-017] a rejected password yields unreachable with cause unauthorized and nothing is retried in a loop', async () => {
    const w = world({ password: 'not-the-servers-password' })
    const client = new OpenCodeServerClient(PERSON, w.deps)

    expect(await client.listSessions()).toStrictEqual({
      kind: 'unreachable',
      cause: 'unauthorized'
    })
    await settle(w.clock)
    w.clock.advance(10 * OPENCODE_SERVER_CALL_TIMEOUT_MS)
    await settle(w.clock)

    expect(w.calls).toHaveLength(1)
    expect(w.secretReader.reads).toStrictEqual(['opencode-password'])
    expect(w.log.byEvent('opencode-server.unreachable')).toStrictEqual([
      {
        level: 'warn',
        event: 'opencode-server.unreachable',
        subsystem: 'suppliers',
        provider: 'opencode',
        outcome: 'failed',
        causeClass: 'password-rejected',
        errCode: '401'
      }
    ])
  })

  it('[ADR-017] without a stored password a protected server is unreachable with cause unauthorized and no credential is sent', async () => {
    const w = world({ password: null })
    const client = new OpenCodeServerClient(PERSON, w.deps)

    expect(await client.listSessions()).toStrictEqual({
      kind: 'unreachable',
      cause: 'unauthorized'
    })
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.headers.authorization).toBeUndefined()
    expect(w.log.byEvent('opencode-server.unreachable')[0]?.causeClass).toBe('password-not-set')
  })

  it('[ADR-017, C-22] an address off this machine gets nothing: the password is not read and no request is sent', async () => {
    for (const url of [
      'http://192.168.1.20:4096',
      'https://127.0.0.1:4096',
      'http://opencode:secret@127.0.0.1:4096',
      'http://127.0.0.1.example.com:4096',
      'not a url'
    ]) {
      const w = world()
      const client = new OpenCodeServerClient({ owner: 'person', url }, w.deps)

      expect(await client.listSessions(), url).toStrictEqual({
        kind: 'unreachable',
        cause: 'not-loopback'
      })
      expect(w.secretReader.reads).toStrictEqual([])
      expect(w.calls).toStrictEqual([])
    }
    for (const url of ['http://localhost:4096', 'http://[::1]:4096', 'http://127.0.0.1:4096/']) {
      const w = world()
      const outcome = await new OpenCodeServerClient(
        { owner: 'person', url },
        w.deps
      ).listSessions()
      expect(outcome.kind, url).toBe('ok')
    }
  })

  it('[FM-116] a server that does not answer, or a failed connection, is unreachable once, without a retry', async () => {
    const silent = world({ reply: 'never' })
    const pending = new OpenCodeServerClient(PERSON, silent.deps).listSessions()
    await settle(silent.clock)
    silent.clock.advance(OPENCODE_SERVER_CALL_TIMEOUT_MS)
    expect(await pending).toStrictEqual({ kind: 'unreachable', cause: 'no-answer' })
    expect(silent.calls).toHaveLength(1)

    const failed = world({ reply: 'fail' })
    expect(await new OpenCodeServerClient(PERSON, failed.deps).listSessions()).toStrictEqual({
      kind: 'unreachable',
      cause: 'network'
    })
    expect(failed.calls).toHaveLength(1)
  })

  it('[ADR-017] the request shape is the session list: GET /session', () => {
    expect(listSessionsRequest()).toStrictEqual({ method: 'GET', path: '/session' })
  })
})

const OPENCODE = CATALOG_RECORDS.find((record) => record.profile.id === 'opencode') as CatalogRecord

const INSTALL: InstalledProvider = {
  providerId: OPENCODE.profile.id,
  binaryPath: '/home/j/.opencode/bin/opencode',
  version: '1.18.32',
  resolvedVia: 'path',
  statMtimeMs: 0
}

function serverDriver(w: ReturnType<typeof world>, processControl?: RecordingSpawn) {
  const resolver = new FakeInstallResolver()
  resolver.install('opencode', { path: INSTALL.binaryPath, version: '1.18.32' })
  return new OpenCodeServerDriver({
    record: OPENCODE,
    detection: createInstallDetection({
      resolver,
      fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
      scheduler: w.scheduler
    }),
    processControl:
      processControl ??
      new RecordingSpawn({
        clock: w.clock,
        scheduler: w.scheduler,
        decide: () => ({ kind: 'exit', afterMs: 0, code: 0, stdout: '' })
      }),
    scheduler: w.scheduler,
    loginEnv: LOGIN_ENV,
    home: '/home/j',
    platform: 'linux',
    server: w.deps
  })
}
