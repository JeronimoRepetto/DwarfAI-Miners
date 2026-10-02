import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { fixtureSeeds } from '../../platform/sqlite/testing/fixtureSeeds'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { PreferencesEvent } from './domain/events'
import type { ResetStep } from './domain/resetSaga'
import { FakeExternalConfigWriter } from './ports/fakes/FakeExternalConfigWriter'
import { FakeSecretStore } from './ports/fakes/FakeSecretStore'
import type { ResetDbStep } from './ports/resetJournal'
import type { ResetDbMaintenance, ResetUiFanout } from './application/resetSaga'
import { createPreferencesResetStep, createResetSaga } from './index'

// L2 (17 §1.2): the Reset-metrics saga as the module creates it (ADR-023 items 1–5; 07 machine 13; 16 §4.12 `resetMetrics`)
// over the real `SqliteResetJournal` on a copy of the template database, with the preferences
// module's own `ResetDbStep`, `FakeSecretStore`, `FakeExternalConfigWriter`, a recording
// post-commit cleanup, a recording UI fan-out, `FakeClock` and `RecordingEventBus`. The UI
// fan-out over real connections is L6 (host/transport/methods/resetMetrics.contract.test.ts).

const T = 1_750_000_000_000
const YES = { confirmed: 'yes' } as const

/** What happened, in order, across the saga's collaborators. */
type Trace = string[]

class RecordingMaintenance implements ResetDbMaintenance {
  /** When set, `vacuum` throws once (the Host "dies" before VACUUM finished, CH-11). */
  crashOnVacuum = false

  constructor(
    private readonly trace: Trace,
    private readonly scope: SqliteTransactionRunner,
    private readonly step: () => ResetStep | undefined
  ) {}

  deleteBackups(): void {
    this.record('deleteBackups')
  }

  truncateWal(): void {
    this.record('truncateWal')
  }

  vacuum(): void {
    if (this.crashOnVacuum) {
      this.crashOnVacuum = false
      throw new Error('CH-11: the Host stopped before VACUUM finished')
    }
    this.record('vacuum')
  }

  private record(action: string): void {
    this.trace.push(`${action} tx=${this.scope.isInTransaction()} step=${this.step()}`)
  }
}

class RecordingUiFanout implements ResetUiFanout {
  readonly progressed: ResetStep[] = []
  readonly sent: number[] = []
  /** Settles the pending `resetPreferences` (every attached UI acked or detached). */
  release: (() => void) | null = null
  holdAcks = false

  constructor(private readonly trace: Trace) {}

  progress(progress: { resetId: string; epoch: number; step: ResetStep }): void {
    this.progressed.push(progress.step)
    this.trace.push(`progress ${progress.step}`)
  }

  resetPreferences(epoch: number): Promise<void> {
    this.sent.push(epoch)
    this.trace.push(`ui.resetPreferences ${epoch}`)
    if (!this.holdAcks) return Promise.resolve()
    return new Promise((resolve) => {
      this.release = resolve
    })
  }
}

/** A module's `ResetDbStep` that records what it sees inside the `db` transaction. */
function recordingStep(
  name: string,
  trace: Trace,
  scope: SqliteTransactionRunner,
  epoch: () => number,
  fail = false
): ResetDbStep {
  return {
    name,
    reset: (tx: TransactionRunner) =>
      tx.inTransaction(() => {
        trace.push(`${name} tx=${scope.isInTransaction()} epoch=${epoch()}`)
        if (fail) throw new Error(`${name} failed`)
      })
  }
}

function saga(options: { failingDbStep?: boolean } = {}) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T)
  const ids = new SequenceIdGenerator()
  const trace: Trace = []
  const epoch = () => Number(db.all('SELECT reset_epoch FROM app_meta')[0]?.['reset_epoch'])
  const journalStep = () =>
    db.all('SELECT step FROM reset_journal ORDER BY started_at DESC LIMIT 1')[0]?.['step'] as
      ResetStep | undefined
  const maintenance = new RecordingMaintenance(trace, transactions, journalStep)
  const secrets = new FakeSecretStore()
  const externalConfig = new FakeExternalConfigWriter()
  const ui = new RecordingUiFanout(trace)
  const bus = new RecordingEventBus<PreferencesEvent>({ transactionScope: transactions })
  for (const type of ['MetricsResetStarted', 'MetricsResetFinished', 'MetricsResetFailed'] as const)
    bus.subscribe(type, () => trace.push(type))
  const log = new RecordingDiagnosticsLog()
  const installMoment: ResetDbStep = {
    name: 'ledger-install-moment',
    reset: (tx) =>
      tx.inTransaction(() => {
        trace.push('install-moment')
        db.run(
          `INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'reset')
           ON CONFLICT (id) DO UPDATE SET at = excluded.at, reason = 'reset',
             backfill_state = 'not-started', backfill_done_at = NULL`,
          [clock.now()]
        )
      })
  }
  const subject = createResetSaga({
    db,
    transactions,
    dbSteps: [
      createPreferencesResetStep({ db, clock }),
      recordingStep('first', trace, transactions, epoch),
      recordingStep('last', trace, transactions, epoch, options.failingDbStep)
    ],
    installMoment,
    maintenance,
    secrets,
    externalConfig,
    ui,
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-0212',
    log
  })
  /** The stored routing profile: the preferences step returns it to 'balanced' (09 §4.9). */
  const preferences = {
    routingProfile: () =>
      db.all('SELECT routing_profile FROM host_preferences')[0]?.['routing_profile'],
    setRoutingProfile: (value: string) =>
      transactions.inTransaction(() =>
        db.run('UPDATE host_preferences SET routing_profile = ?', [value])
      )
  }
  const journalRow = () => ({
    ...db.all('SELECT step, finished_at, epoch FROM reset_journal ORDER BY started_at DESC')[0]
  })
  return {
    db,
    transactions,
    clock,
    trace,
    subject,
    maintenance,
    secrets,
    externalConfig,
    ui,
    bus,
    log,
    epoch,
    journalStep,
    journalRow,
    preferences
  }
}

describe('ResetSaga', () => {
  it('[INV-108, S13.01] the db step runs every registered step in one transaction with the epoch bump and publishes MetricsResetStarted after the commit', async () => {
    const ok = saga()
    ok.preferences.setRoutingProfile('premium')

    const result = await ok.subject.resetMetrics(YES)

    expect(result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    // Both module steps ran inside the transaction that already holds the new epoch.
    expect(ok.trace.slice(0, 3)).toStrictEqual([
      'first tx=true epoch=1',
      'last tx=true epoch=1',
      'MetricsResetStarted'
    ])
    expect(ok.preferences.routingProfile()).toBe('balanced')
    const started = ok.bus.ofType('MetricsResetStarted')
    expect(started).toHaveLength(1)
    expect(started[0]?.payload).toStrictEqual({ resetId: expect.any(String), epoch: 1 })

    // A step that fails rolls the whole db transaction back: no journal row, no epoch, no event.
    const failing = saga({ failingDbStep: true })
    failing.preferences.setRoutingProfile('premium')

    const refused = await failing.subject.resetMetrics(YES)

    expect(refused).toMatchObject({ outcome: 'failed', resumesOnNextStart: false })
    expect(failing.epoch()).toBe(0)
    expect(failing.journalStep()).toBeUndefined()
    expect(failing.preferences.routingProfile()).toBe('premium')
    expect(failing.bus.published).toStrictEqual([])
    expect(failing.trace.some((line) => line.startsWith('deleteBackups'))).toBe(false)
  })

  it('[S13.01] after the commit, still in db, the backups are deleted, the WAL truncated and VACUUM run', async () => {
    const { subject, trace, secrets } = saga()

    await subject.resetMetrics(YES)

    const cleanup = trace.filter((line) => /^(deleteBackups|truncateWal|vacuum)/.test(line))
    expect(cleanup).toStrictEqual([
      'deleteBackups tx=false step=db',
      'truncateWal tx=false step=db',
      'vacuum tx=false step=db'
    ])
    expect(trace.indexOf('MetricsResetStarted')).toBeLessThan(
      trace.indexOf('deleteBackups tx=false step=db')
    )
    // The secrets step comes after the whole cleanup.
    expect(secrets.deleted).toStrictEqual(['jev-key', 'opencode-password'])
    expect(trace.indexOf('vacuum tx=false step=db')).toBeLessThan(trace.indexOf('progress secrets'))
  })

  it('[FM-117, S13.07] a secret delete that throws fails the step, keeps finished steps and returns failed with resumesOnNextStart', async () => {
    const { subject, secrets, ui, bus, log, epoch, journalRow, trace, preferences } = saga()
    secrets.failDeletes(new Error('the keychain is locked'))

    const result = await subject.resetMetrics(YES)

    expect(result).toStrictEqual({
      outcome: 'failed',
      reason: 'secret-delete-failed',
      resumesOnNextStart: true
    })
    // The db step and its cleanup stay done; nothing after the secrets step ran.
    expect(epoch()).toBe(1)
    expect(journalRow()).toMatchObject({ step: 'db', finished_at: null })
    expect(preferences.routingProfile()).toBe('balanced')
    expect(trace).toContain('vacuum tx=false step=db')
    expect(ui.sent).toStrictEqual([])
    expect(trace).not.toContain('install-moment')
    expect(bus.ofType('MetricsResetFinished')).toStrictEqual([])
    expect(bus.ofType('MetricsResetFailed').map((event) => event.payload)).toStrictEqual([
      {
        resetId: expect.any(String),
        step: 'secrets',
        reason: 'secret-delete-failed',
        resumesOnNextStart: true
      }
    ])
    expect(log.byEvent('reset.failed')).toMatchObject([
      {
        level: 'error',
        subsystem: 'preferences',
        msg: 'secrets',
        causeClass: 'secret-delete-failed'
      }
    ])
  })

  it('[ADR-017] an unavailable secret service completes the secrets step', async () => {
    const { subject, secrets } = saga()
    secrets.setBackend('unavailable')

    expect(await subject.resetMetrics(YES)).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(secrets.deleted).toStrictEqual(['jev-key', 'opencode-password'])
  })

  it('[S13.03, S13.07] a config file locked by its tool fails the external-config step and the secrets stay deleted', async () => {
    const { subject, secrets, externalConfig, journalRow, ui } = saga()
    await secrets.set('jev-key', 'k')
    externalConfig.lock('opencode-plugin')

    const result = await subject.resetMetrics(YES)

    expect(result).toStrictEqual({
      outcome: 'failed',
      reason: 'config-revert-locked',
      resumesOnNextStart: true
    })
    expect(await secrets.has('jev-key')).toBe(false)
    expect(journalRow()).toMatchObject({ step: 'secrets' })
    expect(externalConfig.reverts).toContain('opencode-plugin')
    expect(ui.sent).toStrictEqual([])
  })

  it('[S13.04, S13.05] ui.resetPreferences reaches every attached UI and the saga moves on when each acked or detached', async () => {
    const { subject, ui, trace, journalRow } = saga()
    ui.holdAcks = true

    const pending = subject.resetMetrics(YES)
    await new Promise((resolve) => setImmediate(resolve))

    expect(ui.sent).toStrictEqual([1])
    expect(journalRow()).toMatchObject({ step: 'external-config' })
    expect(trace).not.toContain('install-moment')

    ui.release?.()
    expect(await pending).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(trace.indexOf('ui.resetPreferences 1')).toBeLessThan(trace.indexOf('install-moment'))
  })

  it('[S13.06, INV-108] the result reset with its epoch is returned only at done', async () => {
    const { subject, ui, bus, journalRow, db, clock, log } = saga()
    clock.advance(1_000)

    const result = await subject.resetMetrics(YES)

    expect(result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(journalRow()).toMatchObject({ step: 'done', finished_at: T + 1_000, epoch: 1 })
    expect(ui.progressed).toStrictEqual([
      'db',
      'secrets',
      'external-config',
      'ui-prefs',
      'install-moment',
      'done'
    ])
    expect({ ...db.all('SELECT at, reason FROM install_moment')[0] }).toStrictEqual({
      at: T + 1_000,
      reason: 'reset'
    })
    expect(bus.published.map((event) => event.type)).toStrictEqual([
      'MetricsResetStarted',
      'MetricsResetFinished'
    ])
    expect(bus.ofType('MetricsResetFinished')[0]?.payload).toStrictEqual({
      resetId: bus.ofType('MetricsResetStarted')[0]?.payload.resetId,
      epoch: 1
    })
    expect(log.byEvent('reset.step').map((entry) => entry.msg)).toStrictEqual([
      'db',
      'db',
      'secrets',
      'external-config',
      'ui-prefs',
      'install-moment',
      'done'
    ])
    expect(log.refused).toStrictEqual([])
  })

  it('[INV-109] the saga never ends a session, closes an open ask or cancels a launch', async () => {
    const { db, transactions, subject, bus } = saga()
    const seed = fixtureSeeds['cut-0']
    if (seed === undefined) throw new Error('no cut-0 seed')
    const DWARF = '00000000-0000-7000-8000-00000000c0d1'
    const MINE = '00000000-0000-7000-8000-00000000c0f1'
    transactions.inTransaction(() => {
      for (const statement of seed.statements) db.exec(statement)
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at)
         VALUES ('00000000-0000-7000-8000-0000000a5c01', ?, 'permission', 'driver', 'req-1', '{}',
           'open', ?)`,
        [DWARF, T]
      )
      db.run(
        `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id,
           launched_with_let_jev_choose, state, delegated, host_epoch, requested_at, spawned_at)
         VALUES ('00000000-0000-7000-8000-0000000a1a01', ?, '/work/mine-one', 'supplier',
           'claude', 0, 'spawned', 0, 'epoch-0212', ?, ?)`,
        [MINE, T, T]
      )
    })
    const live = () => ({
      dwarf: { ...db.all('SELECT process_state FROM dwarfs')[0] },
      ask: { ...db.all('SELECT state, closed_at FROM asks')[0] },
      launch: { ...db.all('SELECT state, settled_at FROM launches')[0] }
    })
    const before = live()

    expect(await subject.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    expect(before).toStrictEqual({
      dwarf: { process_state: 'running' },
      ask: { state: 'open', closed_at: null },
      launch: { state: 'spawned', settled_at: null }
    })
    expect(live()).toStrictEqual(before)
    expect(bus.published.map((event) => event.type)).toStrictEqual([
      'MetricsResetStarted',
      'MetricsResetFinished'
    ])
  })

  it('[S13.07] a second resetMetrics while the saga runs waits for it and answers its result', async () => {
    const { subject, ui, epoch, bus } = saga()
    ui.holdAcks = true

    const first = subject.resetMetrics(YES)
    await new Promise((resolve) => setImmediate(resolve))
    const second = subject.resetMetrics(YES)
    ui.release?.()

    expect(await first).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(await second).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(epoch()).toBe(1)
    expect(bus.ofType('MetricsResetStarted')).toHaveLength(1)
  })

  it('[S13.07, S13.02] a resetMetrics after a failed step continues the same saga from its journal and completes it', async () => {
    const { subject, secrets, epoch, journalRow, bus, trace } = saga()
    secrets.failDeletes(new Error('the keychain is locked'))
    expect(await subject.resetMetrics(YES)).toMatchObject({ outcome: 'failed' })
    secrets.failDeletes(null)

    expect(await subject.resetMetrics(YES)).toStrictEqual({ outcome: 'reset', epoch: 1 })

    expect(epoch()).toBe(1)
    expect(journalRow()).toMatchObject({ step: 'done', epoch: 1 })
    expect(bus.ofType('MetricsResetStarted')).toHaveLength(1)
    // Resuming from db re-runs the idempotent cleanup before the secrets step.
    expect(trace.filter((line) => line.startsWith('vacuum'))).toHaveLength(2)
  })

  it('[FM-019, CH-11] a cleanup stopped before VACUUM finished keeps the journal at db and is run again before secrets', async () => {
    const { subject, maintenance, secrets, journalRow, trace } = saga()
    maintenance.crashOnVacuum = true

    expect(await subject.resetMetrics(YES)).toStrictEqual({
      outcome: 'failed',
      reason: 'db-cleanup-failed',
      resumesOnNextStart: true
    })
    expect(journalRow()).toMatchObject({ step: 'db' })
    expect(secrets.deleted).toStrictEqual([])

    expect(await subject.resetMetrics(YES)).toStrictEqual({ outcome: 'reset', epoch: 1 })
    const resumed = trace.slice(trace.lastIndexOf('deleteBackups tx=false step=db'))
    expect(resumed.slice(0, 3)).toStrictEqual([
      'deleteBackups tx=false step=db',
      'truncateWal tx=false step=db',
      'vacuum tx=false step=db'
    ])
    expect(secrets.deleted).toStrictEqual(['jev-key', 'opencode-password'])
  })
})
