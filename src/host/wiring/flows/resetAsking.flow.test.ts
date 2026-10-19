// layer: L2
// L2 (17 §1.2): the asking module's Reset step registered with the Reset-metrics saga by
// host/wiring/resetParticipants.ts (ADR-023 items 1, 3, 4; 09 §7.2; 16 §4.12 `ResetDbStep`),
// composed over a copy of the template database with the real `SqliteAskRepository`: an ask open
// across the reset still shows on its step and can be answered; an answering ask keeps its
// answer attempt and settles normally; the step is part of the saga's one `db` transaction.
//
// TC-139-02.
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { AskId } from '../../kernel/domain/values'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import { permissionAsk, questionAsk } from '../../modules/asking/testing/askRepository.contract'
import { answerRows, seededAskDb } from '../../modules/asking/testing/sqliteAskDb'
import { createAttentionResetStep } from '../../modules/attention'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type ResetDbStep,
  type SecretStore
} from '../../modules/preferences'
import { createModuleResetSteps } from '../moduleResetSteps'
import { resetParticipants } from '../resetParticipants'

const EPOCH = 'epoch-0139'

/** Cut 1: nothing in the OS secret store, no owned config entry (the steps complete at once). */
const noSecrets: SecretStore = {
  backend: () => Promise.resolve('os-secret-store'),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve('deleted')
}
const noOwnedConfig: ExternalConfigWriter = {
  install: () => Promise.reject(new Error('nothing is installed in this case')),
  verify: () => Promise.resolve('absent'),
  revert: () => Promise.resolve({ ok: true, value: undefined }),
  findLegacy: () => Promise.resolve(false)
}

/**
 * A Host over a template copy: two present dwarfs, one with an open and a closed ask, the other
 * with an answering ask; the asks repository and the Reset saga with the asking step registered.
 */
function host(options: { laterStep?: ResetDbStep } = {}) {
  const { db, runner, clock, open, dwarfs } = seededAskDb()
  const [first, second] = dwarfs
  const asks = open()
  const front = questionAsk(1, first, { currentStep: 1 })
  const answering = permissionAsk(2, second)
  const closed = questionAsk(3, first, { state: 'cancelled', closedAt: clock.now() + 5 })
  runner.inTransaction(() => {
    ;[front, answering, closed].forEach((ask) => asks.save(ask))
    asks.settle(answering.id as AskId, { requestId: 'request-answering' })
  })

  const ids = new SequenceIdGenerator()
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    modules: createModuleResetSteps({
      db,
      scope: runner,
      clock,
      mapSites: [],
      random: () => 0
    }).steps,
    attention: createAttentionResetStep({ db, scope: runner }),
    ledger: { setInstallMoment: () => undefined },
    clock
  })
  const later = options.laterStep === undefined ? [] : [options.laterStep]
  const saga = createResetSaga({
    db,
    transactions: runner,
    dbSteps: [...participants.dbSteps, ...later],
    installMoment: participants.installMoment,
    maintenance: {
      deleteBackups: () => undefined,
      truncateWal: () => undefined,
      vacuum: () => undefined
    },
    secrets: noSecrets,
    externalConfig: noOwnedConfig,
    // No UI is attached: the ui-prefs step settles at once (07 S13.05).
    ui: { progress: () => undefined, resetPreferences: () => Promise.resolve() },
    bus: new InProcessEventBus<PreferencesEvent>({
      transactionScope: runner,
      onHandlerError: () => undefined
    }),
    clock,
    ids,
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })
  const askIds = () => db.all('SELECT id FROM asks ORDER BY id').map((row) => String(row['id']))
  return { db, runner, asks, saga, participants, askIds, first, second, front, answering, closed }
}

describe('resetAsking flow', () => {
  it('[ADR-023, US-RES-003.AC02] an ask open across a reset still shows on its step afterwards and can be answered', async () => {
    const { runner, asks, saga, first, front, closed, askIds } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result.outcome).toBe('reset')
    // The closed ask went; the open one is the dwarf's front ask again, on the step it was on.
    expect(askIds()).not.toContain(closed.id)
    expect(asks.openFor(first)).toStrictEqual(front)
    expect(asks.openFor(first)?.currentStep).toBe(1)
    // And it is answerable: the first submit wins it.
    expect(
      runner.inTransaction(() => asks.settle(front.id as AskId, { requestId: 'request-after' }))
    ).toBe('settled')
  })

  it('[ADR-023] an answering ask across a reset settles normally when its channel answers', async () => {
    const { db, runner, asks, saga, second, answering } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result.outcome).toBe('reset')
    expect(asks.openFor(second)?.state).toBe('answering')
    // Its pending answer attempt survived; the channel's answer settles it and the ask closes.
    expect(answerRows(db).map((row) => [row['request_id'], row['outcome']])).toStrictEqual([
      ['request-answering', null]
    ])
    runner.inTransaction(() => {
      db.run(
        `UPDATE ask_answers SET outcome = 'accepted', settled_at = at + 1 WHERE request_id = ?`,
        ['request-answering']
      )
      asks.save({ ...answering, state: 'answered-in-app', closedAt: answering.openedAt + 10 })
    })
    expect(asks.openFor(second)).toBeNull()
    expect(answerRows(db).map((row) => row['outcome'])).toStrictEqual(['accepted'])
  })

  it('[ADR-023] the asking step is registered before attention and runs inside the saga db transaction', async () => {
    const failing: ResetDbStep = {
      name: 'a-later-step',
      reset: () => {
        throw new Error('a later ResetDbStep failed')
      }
    }
    const { participants, saga, askIds } = host({ laterStep: failing })
    const names = participants.dbSteps.map((step) => step.name)
    expect(names).toContain('asking')
    expect(names.indexOf('asking')).toBeLessThan(names.indexOf('attention'))
    const before = askIds()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result).toStrictEqual({
      outcome: 'failed',
      reason: expect.any(String),
      resumesOnNextStart: false
    })
    // The closed ask's deletion rolled back with the transaction.
    expect(askIds()).toStrictEqual(before)
  })
})
