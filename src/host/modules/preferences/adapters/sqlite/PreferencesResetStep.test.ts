import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { PreferencesResetStep } from './PreferencesResetStep'
import { SqlitePreferencesStore } from './SqlitePreferencesStore'

// L3 (17 §1.3): the preferences module's `ResetDbStep` (16 §4.12) over a copy of the template
// database (migration 1 seeded, 09 §4.9).

const T = 1_750_000_000_000

describe('PreferencesResetStep', () => {
  it('[ADR-023] the preferences reset step returns host_preferences to the migration-1 defaults inside the caller transaction and leaves the integration settings untouched', () => {
    const { db } = openTemplateCopy()
    const transactions = new SqliteTransactionRunner(db)
    const clock = new FakeClock(T)
    const store = new SqlitePreferencesStore({ db, clock })
    const defaults = store.load()
    transactions.inTransaction(() => {
      store.save({
        subagentDelegationOn: true,
        routingProfile: 'premium',
        defaultProvider: 'claude',
        defaultModel: 'opus',
        defaultEffort: 'high',
        systemNotificationsOn: false,
        openCodePermissionsOn: false
      })
      db.run(
        `UPDATE integration_settings SET state = 'on-verified', consent_origin = 'settings',
         changed_at = ? WHERE id = 'opencode-permissions'`,
        [T]
      )
    })
    const integrations = () =>
      db.all('SELECT * FROM integration_settings ORDER BY id').map((row) => ({ ...row }))
    const before = integrations()
    const step = new PreferencesResetStep({ db, clock })

    clock.advance(5_000)
    transactions.inTransaction(() => step.reset(transactions))

    expect(step.name).toBe('preferences')
    // 09 D-22: the OpenCode integration is reverted in step external-config, not here, so the
    // derived openCodePermissionsOn still reads on.
    expect(store.load()).toStrictEqual({ ...defaults, openCodePermissionsOn: true })
    expect(db.all('SELECT updated_at FROM host_preferences')[0]?.['updated_at']).toBe(T + 5_000)
    expect(integrations()).toStrictEqual(before)

    // Joined: a failure later in the same db transaction leaves the stored preferences as they were.
    transactions.inTransaction(() => store.save({ ...defaults, routingProfile: 'economy' }))
    expect(() =>
      transactions.inTransaction(() => {
        step.reset(transactions)
        throw new Error('a later ResetDbStep failed')
      })
    ).toThrow('a later ResetDbStep failed')
    expect(store.load().routingProfile).toBe('economy')
  })
})
