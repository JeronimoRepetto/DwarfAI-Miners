import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeFs } from '../kernel/fakes/FakeFs'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { FileSystemSubject } from '../kernel/testing/fileSystem.contract'
import {
  claudeHooksWorld,
  fixture,
  HOOK_TOKEN
} from '../modules/preferences/adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { SqliteChannelTokenStore } from '../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../platform/sqlite/testing/templateDb'
import {
  createRevertStore,
  dispatchHostMode,
  REVERT_INTEGRATIONS_FLAG,
  REVERT_STOP_BOUND_MS,
  runRevertIntegrations,
  type RevertHostLink,
  type StopAllAnswer
} from './revertIntegrations'

// L2 (17 §1.2): the `--revert-integrations` composition (ADR-016 item 7; 16 §7.4; ISSUE-225) over a
// fake running Host and endpoint, the real config writer engine with the `claude-hooks` target on
// FakeFs and its ISSUE-220 fixtures, a per-test copy of the migrated database, and FakeScheduler
// for the 30 s bound. No real Host, socket, home folder or timer.

const HOME = '/home/j'
const LOG_FILE = `${HOME}/userData/logs/host-0001.log`

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => [HOME, ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

/** Lets every pending promise and FakeFs read run (no timer moves). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A Host of the same profile that answers `hello` as `ui`, as the command sees it. */
class FakeRunningHost {
  /** Holds the endpoint until it exited. */
  holdsEndpoint = true
  private exited: () => void = () => {}
  private readonly closedPromise = new Promise<void>((resolve) => (this.exited = resolve))

  constructor(
    private readonly calls: string[],
    private readonly answer: StopAllAnswer | 'never'
  ) {}

  readonly link: RevertHostLink = {
    stopAll: () => {
      this.calls.push('stop-all')
      return this.answer === 'never' ? new Promise(() => {}) : Promise.resolve(this.answer)
    },
    closed: this.closedPromise,
    close: () => this.calls.push('link-closed')
  }

  /** The clean exit after stop-all: the endpoint closes, and the connection with it. */
  exit(): void {
    this.holdsEndpoint = false
    this.exited()
  }
}

async function world(options: { host?: (calls: string[]) => FakeRunningHost } = {}) {
  const storage = memory()
  const { db, path: dbPath } = openTemplateCopy()
  const hooks = await claudeHooksWorld(storage, db)
  await hooks.seed(fixture('foreign-only.settings'))
  await storage.seed(LOG_FILE, 'kept log segment\n')
  // The Host wrote its entry (ISSUE-220) with the live claude-hooks token (ADR-016 item 1).
  const installed = await hooks.writer.install('claude-hooks', HOOK_TOKEN, 'settings')
  if (!installed.ok) throw new Error(`the seed install failed: ${installed.error}`)
  new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() }).issue(
    'claude-hooks',
    'ab'.repeat(32),
    1_760_000_000_000
  )
  const installedText = await hooks.read()

  const clock = new FakeClock(1_760_000_100_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const calls: string[] = []
  const host = options.host?.(calls) ?? null
  const run = () =>
    runRevertIntegrations({
      attach: async () => {
        calls.push('attach')
        return host === null ? { kind: 'none' } : { kind: 'attached', link: host.link }
      },
      takeEndpoint: async () => {
        calls.push('take')
        if (host?.holdsEndpoint === true) return { kind: 'in-use' }
        return { kind: 'taken', release: async () => void calls.push('release') }
      },
      openStore: async () => {
        calls.push('open-db')
        return createRevertStore({
          db,
          transactions: new SqliteTransactionRunner(db),
          fs: hooks.fs,
          clock,
          ids: new SequenceIdGenerator(),
          scheduler,
          log,
          claudeSettingsPath: hooks.path,
          platform: 'linux',
          close: () => void calls.push('close-db')
        })
      },
      clock,
      scheduler,
      log
    })
  return { db, dbPath, storage, hooks, installedText, clock, scheduler, log, calls, host, run }
}

function rows(db: SqliteDatabase) {
  return db.all('SELECT kind, reverted_at FROM config_writes ORDER BY written_at, id')
}

function liveTokens(db: SqliteDatabase): number {
  const row = db.all(
    `SELECT count(*) AS n FROM channel_tokens WHERE channel = 'claude-hooks' AND revoked_at IS NULL`
  )[0]
  return Number(row?.['n'])
}

/** Advances the fake clock in small steps, letting each step's work run. */
async function advance(clock: FakeClock, ms: number, step = 250): Promise<void> {
  for (let done = 0; done < ms; done += step) {
    clock.advance(Math.min(step, ms - done))
    await settle()
  }
}

describe('--revert-integrations: stop the Host, then revert (ADR-016 item 7; 16 §7.4)', () => {
  it('[ADR-016] with no Host running the command reverts every active config_writes row, keeps foreign entries byte-identical and exits 0', async () => {
    const w = await world()
    expect(w.installedText).not.toBe(fixture('foreign-only.settings'))

    const code = await w.run()

    expect(code).toBe(0)
    expect(await w.hooks.read()).toBe(fixture('foreign-only.settings'))
    expect(rows(w.db)).toEqual([{ kind: 'claude-hooks', reverted_at: w.clock.now() }])
    expect(w.hooks.setting().state).toBe('off')
    // 16 §7.4: the revert revokes the channel's token.
    expect(liveTokens(w.db)).toBe(0)
    expect(w.calls).toEqual(['attach', 'take', 'open-db', 'close-db', 'release'])
  })

  it('[ADR-016] with a Host running the command sends stop-all first and reverts only after the endpoint closed', async () => {
    const w = await world({ host: (calls) => new FakeRunningHost(calls, { ok: true, failed: 0 }) })

    const running = w.run()
    await settle()
    await advance(w.clock, 5_000)

    // The Host has not exited yet: nothing is taken, opened or reverted.
    expect(w.calls).toEqual(['attach', 'stop-all'])
    expect(await w.hooks.read()).toBe(w.installedText)
    expect(rows(w.db)).toEqual([{ kind: 'claude-hooks', reverted_at: null }])

    w.host?.exit()
    await settle()
    const code = await running

    expect(code).toBe(0)
    expect(w.calls).toEqual([
      'attach',
      'stop-all',
      'link-closed',
      'take',
      'open-db',
      'close-db',
      'release'
    ])
    expect(await w.hooks.read()).toBe(fixture('foreign-only.settings'))
    expect(rows(w.db)[0]?.['reverted_at']).not.toBeNull()
  })

  it('[ADR-016] a Host that does not stop within 30 s or reports stop-all-incomplete leaves every entry and exits non-zero', async () => {
    // The Host answers stop-all but never exits.
    const silent = await world({
      host: (calls) => new FakeRunningHost(calls, { ok: true, failed: 0 })
    })
    const waiting = silent.run()
    await settle()
    await advance(silent.clock, REVERT_STOP_BOUND_MS - 250)
    expect(silent.calls).not.toContain('open-db')
    await advance(silent.clock, 500)
    expect(await waiting).not.toBe(0)
    expect(silent.calls).not.toContain('open-db')
    expect(await silent.hooks.read()).toBe(silent.installedText)
    expect(rows(silent.db)).toEqual([{ kind: 'claude-hooks', reverted_at: null }])
    expect(silent.log.byEvent('host.revert-integrations')).toMatchObject([
      { level: 'warn', outcome: 'failed', causeClass: 'host-not-stopped' }
    ])

    // An owned session could not be ended: the Host keeps running (S12.21).
    const incomplete = await world({
      host: (calls) => new FakeRunningHost(calls, { ok: true, failed: 1 })
    })
    expect(await incomplete.run()).not.toBe(0)
    expect(incomplete.calls).toEqual(['attach', 'stop-all', 'link-closed'])
    expect(await incomplete.hooks.read()).toBe(incomplete.installedText)
    expect(rows(incomplete.db)).toEqual([{ kind: 'claude-hooks', reverted_at: null }])
    expect(incomplete.log.byEvent('host.revert-integrations')).toMatchObject([
      { level: 'warn', outcome: 'failed', causeClass: 'stop-all-incomplete' }
    ])
  })

  it('[ADR-016] a Host that never answers stop-all within 30 s leaves every entry and exits non-zero', async () => {
    const w = await world({ host: (calls) => new FakeRunningHost(calls, 'never') })
    const waiting = w.run()
    await settle()
    await advance(w.clock, REVERT_STOP_BOUND_MS + 250)

    expect(await waiting).not.toBe(0)
    expect(w.calls).toEqual(['attach', 'stop-all', 'link-closed'])
    expect(await w.hooks.read()).toBe(w.installedText)
  })

  it('[ADR-016] an endpoint still held after the Host connection closed is retried until the 30 s bound, then nothing is reverted', async () => {
    const w = await world({ host: (calls) => new FakeRunningHost(calls, { ok: true, failed: 0 }) })
    const host = w.host as FakeRunningHost
    const waiting = w.run()
    await settle()
    // The connection closes but something still holds the endpoint (ADR-002 D3: the bind is the mutex).
    host.exit()
    host.holdsEndpoint = true
    await settle()
    await advance(w.clock, REVERT_STOP_BOUND_MS + 250)

    expect(await waiting).not.toBe(0)
    expect(w.calls.filter((call) => call === 'take').length).toBeGreaterThan(1)
    expect(w.calls).not.toContain('open-db')
    expect(await w.hooks.read()).toBe(w.installedText)
  })

  it('[ADR-016] a Host that refuses the ui hello leaves every entry and exits non-zero', async () => {
    const w = await world()
    const code = await runRevertIntegrations({
      attach: async () => ({ kind: 'refused', code: 'AUTH_FAILED' }),
      takeEndpoint: async () => {
        throw new Error('the endpoint is never taken while a Host answers')
      },
      openStore: async () => {
        throw new Error('the database is never opened while a Host answers')
      },
      clock: w.clock,
      scheduler: w.scheduler,
      log: w.log
    })

    expect(code).not.toBe(0)
    expect(await w.hooks.read()).toBe(w.installedText)
  })

  it('[ADR-016] the database, logs, preferences and secrets are kept', async () => {
    const w = await world()
    const preferences = w.db.all('SELECT * FROM host_preferences')
    const tokenRows = w.db.all('SELECT count(*) AS n FROM channel_tokens')

    expect(await w.run()).toBe(0)

    expect(await w.hooks.read()).toBe(fixture('foreign-only.settings'))
    expect(existsSync(w.dbPath)).toBe(true)
    expect(w.db.all('SELECT * FROM host_preferences')).toEqual(preferences)
    // The token row is revoked, never deleted; the command holds no SecretStore at all (ADR-017).
    expect(w.db.all('SELECT count(*) AS n FROM channel_tokens')).toEqual(tokenRows)
    const logFile = await w.storage.fs.readFile(LOG_FILE)
    expect(logFile.ok && new TextDecoder().decode(logFile.value)).toBe('kept log segment\n')
  })

  it('[ADR-016] a second run finds no active row and touches nothing', async () => {
    const w = await world()
    expect(await w.run()).toBe(0)
    const after = { text: await w.hooks.read(), rows: rows(w.db), backups: await w.hooks.backups() }
    expect(after.text).toBe(fixture('foreign-only.settings'))
    const reverts = w.log.byEvent('config.revert').length
    w.clock.advance(60_000)

    expect(await w.run()).toBe(0)

    expect({
      text: await w.hooks.read(),
      rows: rows(w.db),
      backups: await w.hooks.backups()
    }).toEqual(after)
    expect(w.log.byEvent('config.revert')).toHaveLength(reverts)
  })

  it('[ADR-016, INV-111, C-20] a locked settings.json keeps every byte and its row active, and the command exits non-zero (16 §7.4)', async () => {
    const w = await world()
    w.hooks.fs.lock(w.hooks.path)

    const waiting = w.run()
    await advance(w.clock, 1_000, 50)

    expect(await waiting).not.toBe(0)
    expect(await w.hooks.read()).toBe(w.installedText)
    expect(rows(w.db)).toEqual([{ kind: 'claude-hooks', reverted_at: null }])
    expect(liveTokens(w.db)).toBe(1)
    expect(w.calls).toContain('release')
  })
})

describe('the Host process modes (ADR-016 item 7; ISSUE-225 lead decision)', () => {
  it('[ADR-016] --revert-integrations runs the revert mode, exits with its code and never runs the normal boot', async () => {
    const calls: string[] = []
    await dispatchHostMode({
      argv: ['/app/DwarfAI-Miners', '/app/out/host/main.js', REVERT_INTEGRATIONS_FLAG],
      revertIntegrations: async () => {
        calls.push('revert')
        return 7
      },
      boot: async () => void calls.push('boot'),
      exit: (code) => void calls.push(`exit ${code}`)
    })

    expect(calls).toEqual(['revert', 'exit 7'])
  })

  it('[ADR-016] without the flag the Host boots normally and the revert mode never runs', async () => {
    const calls: string[] = []
    await dispatchHostMode({
      argv: ['/app/DwarfAI-Miners', '/app/out/host/main.js'],
      revertIntegrations: async () => {
        calls.push('revert')
        return 0
      },
      boot: async () => void calls.push('boot'),
      exit: (code) => void calls.push(`exit ${code}`)
    })

    expect(calls).toEqual(['boot'])
  })
})
