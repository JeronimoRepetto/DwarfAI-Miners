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
import { SqliteConfigWriteLedger } from '../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { NodeScheduler } from '../platform/clock/NodeScheduler'
import { SystemClock } from '../platform/clock/SystemClock'
import { NodeFs } from '../platform/fs/NodeFs'
import { UuidV7Generator } from '../platform/ids/UuidV7Generator'
import { migrationsFor } from '../platform/sqlite/migrations'
import { openHostDb } from '../platform/sqlite/migrations/runner'
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

/** The database the stopped Host leaves: migrated, with the Host-written entry on record. */
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
    const installed = await writer.install('claude-hooks', HOOK_TOKEN, 'settings')
    if (!installed.ok) throw new Error(`the seed install failed: ${installed.error}`)
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
async function runningHost(input: EndpointInput, hostDataDir: string) {
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
  registerHostShutdown(dispatcher, {
    stopAll: emptyOwnerStopAll,
    // The clean exit (ADR-002 D7) as far as the command can see it: the endpoint closes.
    lifecycle: {
      closeCleanly: async () => {
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
    accept: (connection) =>
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
  })
  if (bound.kind !== 'bound') throw new Error(`expected a bind, got ${bound.kind}`)
  close = () => bound.endpoint.close()
  cleanups.push(() => bound.endpoint.close())
  await token.issue(join(hostDataDir, 'run'))
  return { exited, log }
}

describe('--revert-integrations over this OS (ADR-016 item 7)', () => {
  it('[ADR-016] on each OS the packaged-style command removes a Host-written Claude hook entry from a temp settings.json with a foreign entry byte-identical', async () => {
    const root = caseRoot()
    const hostDataDir = join(root, 'app', 'host')
    mkdirSync(hostDataDir, { recursive: true })
    const settingsPath = join(root, 'home', '.claude', 'settings.json')
    mkdirSync(join(root, 'home', '.claude'), { recursive: true })
    const foreign = fixture('foreign-only.settings')
    writeFileSync(settingsPath, foreign)
    await hostWroteItsEntry(hostDataDir, settingsPath)
    expect(readFileSync(settingsPath, 'utf8')).not.toBe(foreign)
    const input = endpointInput(root, hostDataDir)
    const host = await runningHost(input, hostDataDir)

    const clock = new SystemClock()
    const log = new RecordingDiagnosticsLog()
    const code = await runRevertIntegrations(
      createNodeRevertIntegrations({
        hostDataDir,
        facts: async () => ({ ok: true, value: input }),
        ownerOnlyPipe: createFakeOwnerOnlyPipe().listen,
        client: CLIENT,
        protocolVersion: PROTOCOL_VERSION,
        open: {
          buildKind: 'test',
          releaseDataDir: join(root, 'release'),
          appVersion: APP_VERSION,
          migrations: migrationsFor({ clock, ids: new UuidV7Generator({ clock }) })
        },
        protectDbFiles: async () => undefined,
        fs: new NodeFs(),
        clock,
        ids: new UuidV7Generator({ clock }),
        scheduler: scheduler(),
        log,
        claudeSettingsPath: settingsPath,
        platform: PLATFORM
      })
    )

    expect(log.byEvent('host.revert-integrations')).toMatchObject([{ outcome: 'ok', count: 1 }])
    expect(code).toBe(0)
    // The running Host was stopped first (ADR-002 D7), then the entry went, foreign bytes kept.
    expect(host.exited.value).toBe(true)
    expect(host.log.byEvent('host.stop-all')).toMatchObject([{ outcome: 'ok' }])
    expect(readFileSync(settingsPath, 'utf8')).toBe(foreign)
    const reopened = openHostDb(join(hostDataDir, HOST_DB_FILE), {
      buildKind: 'test',
      releaseDataDir: join(root, 'release'),
      appVersion: APP_VERSION,
      clock,
      log: new RecordingDiagnosticsLog(),
      migrations: migrationsFor({ clock, ids: new UuidV7Generator({ clock }) })
    })
    if (!reopened.ok) throw new Error(`reopen refused: ${reopened.error}`)
    try {
      const rows = reopened.value.db.all('SELECT kind, reverted_at FROM config_writes')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.['reverted_at']).not.toBeNull()
    } finally {
      reopened.value.db.close()
    }
  }, 30_000)
})
