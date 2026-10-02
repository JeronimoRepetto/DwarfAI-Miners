// layer: L10
// L10 (17 §1.10): the Reset-metrics saga survives a Host killed mid-saga (CH-01) and a Host killed
// between the `db` commit and `VACUUM` (CH-11): the next boot resumes it at 16 §8.2 step 3, before
// commands (the Host answers commands only from `ready`) and before observation (step 7), and
// completes the reset (ADR-023 item 4 and Verification; 07 S13.08; 13 FM-019).
//
// Each "Host" is the saga composed over the same database file in a temp directory. The kill is a
// fake injector: from the kill on, every statement of that Host's connection throws, so nothing
// after it reaches the file, and that Host is dropped. The next Host opens the file again and runs
// the real boot step list with the saga's resume injected.
//
// TC-212-03.
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type ResetStep,
  type SecretStore
} from '../../modules/preferences'
import { NodeSqliteDatabase } from '../../platform/sqlite/NodeSqliteDatabase'
import { SqliteResetCleanup } from '../../platform/sqlite/resetCleanup'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { copyTemplateDb } from '../../platform/sqlite/testing/templateDb'
import { runBoot } from '../boot'
import { createBootSteps } from '../bootSteps'
import { resetParticipants } from '../resetParticipants'

const T = 1_790_000_000_000

/** Every connection a case opened, closed before its temp directory is removed. */
const opened: NodeSqliteDatabase[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})
const YES = { confirmed: 'yes' } as const

/** The process of a killed Host is gone: nothing it would still do runs. */
class HostKilled extends Error {
  constructor() {
    super('CH-01: the Host was killed')
    this.name = 'HostKilled'
  }
}

/** The Host's connection, which the fake injector can kill: every later call throws. */
function killable(db: SqliteDatabase): SqliteDatabase & { kill(): void } {
  let killed = false
  const guard = <T>(work: () => T): T => {
    if (killed) throw new HostKilled()
    return work()
  }
  return {
    exec: (sql) => guard(() => db.exec(sql)),
    run: (sql, params) => guard(() => db.run(sql, params)),
    all: (sql, params) => guard(() => db.all(sql, params)),
    openReader: () => guard(() => db.openReader()),
    close: () => db.close(),
    kill: () => {
      killed = true
    }
  }
}

/** What the machine keeps across Hosts: the database file, the clock and the OS secret store. */
function machine() {
  const path = copyTemplateDb()
  const clock = new FakeClock(T)
  const ids = new SequenceIdGenerator()
  const secrets = new Map<string, string>([
    ['jev-key', 'k'],
    ['opencode-password', 'p']
  ])
  // The pre-migration backups the reset must delete (ADR-023 item 1; 09 D-11).
  const backup = join(dirname(path), `${basename(path)}.bak-v1-20260101T000000000Z`)
  writeFileSync(backup, 'a copy of the wiped conversation')
  return { path, clock, ids, secrets, backup }
}

type Machine = ReturnType<typeof machine>

/**
 * One Host over `m`. `killAt` kills it right after the journal reached that step (or, for
 * `cleanup`, after the `db` commit and before the backups, the WAL and `VACUUM`).
 */
function host(m: Machine, killAt?: ResetStep | 'cleanup') {
  const raw = NodeSqliteDatabase.open(m.path)
  opened.push(raw)
  const db = killable(raw)
  const transactions = new SqliteTransactionRunner(db)
  const log = new RecordingDiagnosticsLog()
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: transactions,
    onHandlerError: () => undefined
  })
  const kill = (): never => {
    db.kill()
    throw new HostKilled()
  }
  const cleanup = new SqliteResetCleanup({ db, path: m.path })
  const order: string[] = []
  const secrets: SecretStore = {
    backend: () => Promise.resolve('os-secret-store'),
    get: (name) => Promise.resolve(m.secrets.get(name) ?? null),
    has: (name) => Promise.resolve(m.secrets.has(name)),
    set: (name, value) => {
      m.secrets.set(name, value)
      return Promise.resolve()
    },
    delete: (name) => {
      order.push(`delete ${name}`)
      m.secrets.delete(name)
      return Promise.resolve('deleted')
    }
  }
  const externalConfig: ExternalConfigWriter = {
    install: () => Promise.reject(new Error('nothing is installed in this case')),
    verify: () => Promise.resolve('absent'),
    revert: () => Promise.resolve({ ok: true, value: undefined }),
    findLegacy: () => Promise.resolve(false)
  }
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock: m.clock }),
    ledger: {
      setInstallMoment: (at) =>
        db.run(
          `INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'reset')
           ON CONFLICT (id) DO UPDATE SET at = excluded.at, reason = 'reset',
             backfill_state = 'not-started', backfill_done_at = NULL`,
          [at]
        )
    },
    clock: m.clock
  })
  const saga = createResetSaga({
    db,
    transactions,
    dbSteps: participants.dbSteps,
    installMoment: participants.installMoment,
    maintenance: {
      deleteBackups: () => {
        if (killAt === 'cleanup') kill()
        order.push('deleteBackups')
        cleanup.deleteBackups()
      },
      truncateWal: () => {
        order.push('truncateWal')
        cleanup.truncateWal()
      },
      vacuum: () => {
        order.push('vacuum')
        cleanup.vacuum()
      }
    },
    secrets,
    externalConfig,
    // No UI is attached to these Hosts: the ui-prefs step settles at once (07 S13.05).
    ui: {
      progress: ({ step }) => {
        if (step === killAt) kill()
      },
      resetPreferences: () => Promise.resolve()
    },
    bus,
    clock: m.clock,
    ids: m.ids,
    hostEpoch: 'epoch-0212',
    log
  })

  /** The real boot step list with this Host's saga resume injected. */
  async function boot() {
    const states: string[] = []
    const atReady: Array<{ step: unknown; vacuumed: boolean }> = []
    const outcome = await runBoot(
      (paths) =>
        createBootSteps({
          paths,
          clock: m.clock,
          scheduler: new FakeScheduler(m.clock),
          ids: m.ids,
          fs: new FakeFs(),
          processControl: new FakeProcessControl(),
          log,
          endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
          database: { open: () => Promise.resolve() },
          resumeResetSaga: () => saga.resumeOnBoot()
        }),
      {
        log,
        clock: m.clock,
        state: {
          report: (report) => {
            states.push(report.state)
            // Commands are answered only from `ready` (14 §3.3 HOST_NOT_READY).
            if (report.state === 'ready') {
              atReady.push({ step: journal().step, vacuumed: order.includes('vacuum') })
            }
          }
        },
        privilege: () =>
          Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
        paths: { ok: true, value: new FakeAppPaths() },
        runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
        exit: () => undefined
      }
    )
    return { outcome, states, atReady }
  }

  const journal = () => ({
    ...raw.all('SELECT step, epoch, last_failure FROM reset_journal')[0]
  })
  const bootSteps = () => log.byEvent('host.boot.step').map((entry) => entry.causeClass)
  return { saga, boot, order, journal, raw, log, bootSteps }
}

/** Runs `resetMetrics` on a Host that is killed during it: the call never answers `reset`. */
async function killedDuring(h: ReturnType<typeof host>): Promise<void> {
  let answered: unknown = null
  try {
    answered = await h.saga.resetMetrics(YES)
  } catch (error) {
    expect(error).toBeInstanceOf(HostKilled)
    return
  }
  expect(answered).not.toMatchObject({ outcome: 'reset' })
}

describe('Reset saga resume at boot (07 S13.08; ADR-023 item 4)', () => {
  it('[FM-019, S13.08, CH-01] a Host killed at each step resumes at the next boot before commands and completes the reset', async () => {
    const steps: readonly ResetStep[] = [
      'db',
      'secrets',
      'external-config',
      'ui-prefs',
      'install-moment'
    ]
    for (const killAt of steps) {
      const m = machine()
      const killed = host(m, killAt)
      await killedDuring(killed)
      expect(killed.journal(), killAt).toMatchObject({ step: killAt, epoch: 1 })

      const next = host(m)
      const { outcome, atReady } = await next.boot()

      expect(outcome, killAt).toEqual({ kind: 'ready' })
      // Resumed before commands (ready) and before construct-modules and observation (16 §8.2).
      expect(atReady, killAt).toEqual([{ step: 'done', vacuumed: killAt === 'db' }])
      const ran = next.bootSteps()
      expect(ran.indexOf('resume-reset-saga'), killAt).toBeLessThan(
        ran.indexOf('start-observation')
      )
      expect(next.log.byEvent('host.boot.step')[2], killAt).toMatchObject({
        causeClass: 'resume-reset-saga',
        outcome: 'ok'
      })
      expect(next.log.byEvent('reset.resumed'), killAt).toMatchObject([{ msg: killAt }])
      // The reset is complete, with the one epoch of the killed saga.
      expect(next.journal(), killAt).toMatchObject({ step: 'done', epoch: 1 })
      expect([...m.secrets.keys()], killAt).toStrictEqual([])
      expect(existsSync(m.backup), killAt).toBe(false)
      expect({ ...next.raw.all('SELECT reason FROM install_moment')[0] }, killAt).toStrictEqual({
        reason: 'reset'
      })
    }
  })

  it('[FM-019, CH-11] a Host killed between the db commit and VACUUM re-runs the cleanup before secrets', async () => {
    const m = machine()
    const killed = host(m, 'cleanup')
    await killedDuring(killed)
    expect(killed.journal()).toMatchObject({ step: 'db', epoch: 1, last_failure: null })
    expect(killed.order).toStrictEqual([])
    expect(existsSync(m.backup)).toBe(true)
    expect([...m.secrets.keys()]).toStrictEqual(['jev-key', 'opencode-password'])

    const next = host(m)
    const { outcome, atReady } = await next.boot()

    expect(outcome).toEqual({ kind: 'ready' })
    expect(atReady).toEqual([{ step: 'done', vacuumed: true }])
    expect(next.order).toStrictEqual([
      'deleteBackups',
      'truncateWal',
      'vacuum',
      'delete jev-key',
      'delete opencode-password'
    ])
    expect(existsSync(m.backup)).toBe(false)
    expect(
      readdirSync(dirname(m.path)).filter((name) => name.startsWith(`${basename(m.path)}.bak-`))
    ).toStrictEqual([])
    expect(Number(next.raw.all('PRAGMA freelist_count')[0]?.['freelist_count'])).toBe(0)
    expect(next.journal()).toMatchObject({ step: 'done', epoch: 1 })
  })
})
