// L8 OS lane (17 §1.8): `--revert-integrations` (ADR-016 item 7; ISSUE-225) over this OS's real
// pieces — the UI endpoint (a named pipe on Windows, a Unix socket elsewhere), the real file system
// in a per-test temp folder, the real SQLite database file and real timers — with a running Host
// of the same profile served on that endpoint: the command connects as `ui`, sends `host.shutdown
// {stop-all}`, waits for the endpoint to close, takes it, and reverts the Host-written Claude hook
// entry. Runs on every OS in `pnpm test:os`. The pipe is Node's own (createFakeOwnerOnlyPipe): the
// owner-only ACL is the native helper's (its own OS tests), not what is under test here. Synthetic
// SID and temp paths only (privacy-guard); no real home folder.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endpointFor, PROTOCOL_VERSION, type EndpointInput } from '@dwarfai/contracts'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { ClaudeHooksConfigWriter } from '../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import {
  fixture,
  HOOK_TOKEN
} from '../modules/preferences/adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { ConfigWriterEngine } from '../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { NodeScheduler } from '../platform/clock/NodeScheduler'
import { SystemClock } from '../platform/clock/SystemClock'
import { NodeFs } from '../platform/fs/NodeFs'
import { UuidV7Generator } from '../platform/ids/UuidV7Generator'
import { migrationsFor } from '../platform/sqlite/migrations'
import { openHostDb } from '../platform/sqlite/migrations/runner'
import { HostEpochLog } from '../platform/sqlite/hostEpochLog'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import { UiToken } from '../transport/auth/uiToken'
import { HelloThrottle } from '../transport/auth/throttle'
import { collectCapabilities } from '../transport/capabilities'
import { acceptConnection } from '../transport/connection'
import { ConnectionRegistry } from '../transport/connectionRegistry'
import { Dispatcher } from '../transport/dispatcher'
import { createFakeOwnerOnlyPipe } from '../transport/endpoint/fakes/FakeOwnerOnlyPipe'
import { bindEndpoint } from '../transport/endpoint/server'
import { HostStateHolder } from '../transport/lifecycle/hostState'
import type { UpgradeDrain } from '../transport/lifecycle/drain'
import { registerHostShutdown } from '../transport/methods/hostShutdown'
import { HOST_DB_FILE } from './hostDatabase'
import { emptyOwnerStopAll } from './emptyOwnerStopAll'
import { createNodeRevertIntegrations, runRevertIntegrations } from './revertIntegrations'
import { decideBind } from './singleInstance'
import { hashOf } from '../modules/preferences/testing/inMemoryChannelTokens'

const WINDOWS = process.platform === 'win32'
const PLATFORM: NodeJS.Platform = process.platform
const APP_VERSION = '0.0.0-test'
const CLIENT = { appVersion: APP_VERSION, buildId: 'abc1234', pid: process.pid }
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-225-os-')) : mkdtempSync('/tmp/dw225-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** This OS's endpoint input for `hostDataDir` (ADR-002 D2), with a synthetic SID on Windows. */
function endpointInput(root: string, hostDataDir: string): EndpointInput {
  if (WINDOWS) {
    const sid = `S-1-5-21-0-0-0-${process.pid}${Math.floor(Math.random() * 1e6)}`
    return { platform: 'win32', hostDataDir, userSid: sid, sha256 }
  }
  if (PLATFORM === 'darwin') return { platform: 'darwin', hostDataDir, home: root, sha256 }
  return { platform: 'linux', hostDataDir, sha256 }
}

/**
 * The database the Host leaves: migrated, with the Host-written entry on record and its epoch, which
 * its clean exit marked clean (09 §8.4; ADR-002 D7).
 */
async function hostWroteItsEntry(hostDataDir: string, settingsPath: string): Promise<void> {
  const clock = new SystemClock()
  const ids = new UuidV7Generator({ clock })
  const log = new RecordingDiagnosticsLog()
  const opened = openHostDb(join(hostDataDir, HOST_DB_FILE), {
    buildKind: 'test',
    releaseDataDir: join(hostDataDir, '..', 'release'),
    appVersion: APP_VERSION,
    clock,
    log,
    migrations: migrationsFor({ clock, ids })
  })
  if (!opened.ok) throw new Error(`the test database was refused: ${opened.error}`)
  const { db } = opened.value
  try {
    const writer = new ConfigWriterEngine({
      fs: new NodeFs(),
      transactions: new SqliteTransactionRunner(db),
      ledger: new SqliteConfigWriteLedger({ db }),
      settings: new SqliteIntegrationSettingStore({ db }),
      tokens: new SqliteChannelTokenStore({ db, ids }),
      clock,
      ids,
      scheduler: scheduler(),
      log,
      targets: [
        new ClaudeHooksConfigWriter({
          path: settingsPath,
          platform: PLATFORM,
          ingressPort: () => 45123
        })
      ]
    })
    const installed = await writer.install(
      'claude-hooks',
      HOOK_TOKEN,
      'settings',
      hashOf(HOOK_TOKEN)
    )
    if (!installed.ok) throw new Error(`the seed install failed: ${installed.error}`)
    const transactions = new SqliteTransactionRunner(db)
    const epochs = new HostEpochLog({ db, transactions })
    transactions.inTransaction(() =>
      epochs.beginEpoch(transactions, {
        epoch: 'epoch-os',
        startedAt: clock.now(),
        bootIdentity: { bootId: 'boot-os', bootTimeMs: 1, logonSessionId: 'unknown' }
      })
    )
    epochs.markClean('stop-all', clock.now())
  } finally {
    db.close()
  }
}

function scheduler(): NodeScheduler {
  return new NodeScheduler({
    onTaskError: (error) => {
      throw error
    }
  })
}

/** A Host of the same profile on the real endpoint, serving `hello` and `host.shutdown`. */
async function runningHost(
  input: EndpointInput,
  hostDataDir: string,
  options: { ignoresStop?: boolean } = {}
) {
  const endpoint = endpointFor(input)
  if (!endpoint.ok) throw new Error(`no endpoint: ${endpoint.error.kind}`)
  const clock = new SystemClock()
  const timers = scheduler()
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: timers,
    state: () => state.current().state
  })
  const exited = { value: false }
  let close: () => Promise<void> = async () => {}
  const held = new Set<Socket>()
  registerHostShutdown(dispatcher, {
    stopAll: emptyOwnerStopAll,
    // The clean exit (ADR-002 D7) as far as the command can see it: the endpoint closes.
    lifecycle: {
      closeCleanly: async () => {
        if (options.ignoresStop === true) {
          // It drops its connections and keeps its endpoint, answering every new hello.
          for (const socket of held) socket.destroy()
          return
        }
        exited.value = true
        await close()
      }
    },
    log,
    drain: { enter: () => undefined, start: () => undefined } as unknown as UpgradeDrain
  })
  const token = new UiToken()
  const pipe = createFakeOwnerOnlyPipe()
  const bound = await bindEndpoint(endpoint.value, {
    log,
    scheduler: timers,
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    ownerOnlyPipe: pipe.listen,
    accept: (connection) => {
      held.add(connection)
      connection.once('close', () => held.delete(connection))
      acceptConnection(connection, {
        token,
        ids: new UuidV7Generator({ clock }),
        identity: {
          hostVersion: APP_VERSION,
          buildId: 'abc1234',
          protocolVersion: PROTOCOL_VERSION
        },
        epoch: 'epoch-os',
        state: () => state.current(),
        capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
        scheduler: timers,
        clock,
        log,
        dispatcher,
        connections,
        throttle: new HelloThrottle(clock)
      })
    }
  })
  if (bound.kind !== 'bound') throw new Error(`expected a bind, got ${bound.kind}`)
  close = () => bound.endpoint.close()
  cleanups.push(() => bound.endpoint.close())
  await token.issue(join(hostDataDir, 'run'))
  return { exited, log }
}

/** One case's folders: the Host data, Claude Code's settings with a foreign entry, the endpoint input. */
async function caseWithHostEntry() {
  const root = caseRoot()
  const hostDataDir = join(root, 'app', 'host')
  mkdirSync(hostDataDir, { recursive: true })
  const settingsPath = join(root, 'home', '.claude', 'settings.json')
  mkdirSync(join(root, 'home', '.claude'), { recursive: true })
  const foreign = fixture('foreign-only.settings')
  writeFileSync(settingsPath, foreign)
  await hostWroteItsEntry(hostDataDir, settingsPath)
  const installed = readFileSync(settingsPath, 'utf8')
  expect(installed).not.toBe(foreign)
  const input = endpointInput(root, hostDataDir)
  return { root, hostDataDir, settingsPath, foreign, installed, input }
}

function openOptions(root: string, clock: SystemClock) {
  return {
    buildKind: 'test' as const,
    releaseDataDir: join(root, 'release'),
    appVersion: APP_VERSION,
    migrations: migrationsFor({ clock, ids: new UuidV7Generator({ clock }) })
  }
}

/** The production command over this OS, as host/main.ts composes it. */
async function revertCommand(
  c: Awaited<ReturnType<typeof caseWithHostEntry>>,
  options: { stopBoundMs?: number } = {}
) {
  const clock = new SystemClock()
  const log = new RecordingDiagnosticsLog()
  const code = await runRevertIntegrations({
    ...createNodeRevertIntegrations({
      hostDataDir: c.hostDataDir,
      facts: async () => ({ ok: true, value: c.input }),
      ownerOnlyPipe: createFakeOwnerOnlyPipe().listen,
      client: CLIENT,
      protocolVersion: PROTOCOL_VERSION,
      open: openOptions(c.root, clock),
      protectDbFiles: async () => undefined,
      fs: new NodeFs(),
      clock,
      ids: new UuidV7Generator({ clock }),
      scheduler: scheduler(),
      log,
      claudeSettingsPath: c.settingsPath,
      platform: PLATFORM
    }),
    ...options
  })
  return { code, log }
}

/** The rows and the previous epoch, read with the boot's own reader (hostEpochLog.ts, 09 §8.4 step 1). */
function databaseState(c: { root: string; hostDataDir: string }) {
  const clock = new SystemClock()
  const opened = openHostDb(join(c.hostDataDir, HOST_DB_FILE), {
    ...openOptions(c.root, clock),
    clock,
    log: new RecordingDiagnosticsLog()
  })
  if (!opened.ok) throw new Error(`reopen refused: ${opened.error}`)
  const { db } = opened.value
  try {
    const epochs = new HostEpochLog({ db, transactions: new SqliteTransactionRunner(db) })
    return {
      rows: db.all('SELECT kind, reverted_at FROM config_writes'),
      previous: epochs.readPrevious()
    }
  } finally {
    db.close()
  }
}

describe('--revert-integrations over this OS (ADR-016 item 7)', () => {
  it('[ADR-016] on each OS the packaged-style command removes a Host-written Claude hook entry from a temp settings.json with a foreign entry byte-identical', async () => {
    const c = await caseWithHostEntry()
    const before = databaseState(c).previous
    const host = await runningHost(c.input, c.hostDataDir)

    const { code, log } = await revertCommand(c)

    expect(log.byEvent('host.revert-integrations')).toMatchObject([{ outcome: 'ok', count: 1 }])
    expect(code).toBe(0)
    // The running Host was stopped first (ADR-002 D7), then the entry went, foreign bytes kept.
    expect(host.exited.value).toBe(true)
    expect(host.log.byEvent('host.stop-all')).toMatchObject([{ outcome: 'ok' }])
    expect(readFileSync(c.settingsPath, 'utf8')).toBe(c.foreign)
    const after = databaseState(c)
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.['reverted_at']).not.toBeNull()
    // The next boot reads the stopped Host's clean marker unchanged: no epoch began (09 §8.4).
    expect(before?.marker).toMatchObject({ reason: 'stop-all' })
    expect(after.previous).toEqual(before)
  }, 30_000)

  it('[ADR-016, ADR-002] a live Host that keeps its endpoint and answers hello after stop-all is never reverted around: the command exits non-zero', async () => {
    const c = await caseWithHostEntry()
    const host = await runningHost(c.input, c.hostDataDir, { ignoresStop: true })

    const { code, log } = await revertCommand(c, { stopBoundMs: 2_000 })

    expect(code).not.toBe(0)
    expect(host.log.byEvent('host.stop-all')).toMatchObject([{ outcome: 'ok' }])
    expect(log.byEvent('host.revert-integrations')).toMatchObject([
      { outcome: 'failed', causeClass: 'host-not-stopped' }
    ])
    expect(readFileSync(c.settingsPath, 'utf8')).toBe(c.installed)
    expect(databaseState(c).rows).toMatchObject([{ kind: 'claude-hooks', reverted_at: null }])
  }, 30_000)
})
