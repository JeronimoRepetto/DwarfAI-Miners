// The PreferencesStore conformance suite (16 §4.12 "setter returns stored value"; 17 §1.3): run on
// the in-memory double and on the SQLite adapter over the template database (schema v1, seeded by
// migration 1). One row per machine; `load` returns exactly what `save` stored; a model or an effort
// without a provider is refused and leaves the row as it was (09 §4.8); `openCodePermissionsOn` is
// derived from the OpenCode integration, never stored (06 §14.2); the store joins the caller's
// transaction, so a rollback undoes its write. Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { HostPreferences } from '../domain/hostPreferences'
import type { PreferencesStore } from '../ports/preferencesStore'

export type OpenCodeIntegrationState = 'off' | 'on-unverified' | 'on-verified'

export interface PreferencesStoreSubject {
  store: PreferencesStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** How many preference rows the subject holds. */
  rowCount(): number
  /** Sets the state of the OpenCode integration the store derives `openCodePermissionsOn` from. */
  setOpenCodeIntegration(state: OpenCodeIntegrationState): void
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const CHOSEN: HostPreferences = {
  subagentDelegationOn: true,
  routingProfile: 'premium',
  defaultProvider: 'codex',
  defaultModel: 'gpt-5-codex',
  defaultEffort: 'high',
  systemNotificationsOn: false,
  openCodePermissionsOn: false
}

export function runPreferencesStoreContract(
  makeSubject: () => PreferencesStoreSubject | Promise<PreferencesStoreSubject>
): void {
  describe('PreferencesStore contract', () => {
    let subject: PreferencesStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<PreferencesStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    const save = (s: PreferencesStoreSubject, p: HostPreferences): void =>
      s.inTransaction(() => s.store.save(p))

    it('[US-DLG-001.AC01] a fresh store loads the migration-1 defaults', async () => {
      const s = await setUp()

      expect(s.store.load()).toStrictEqual({
        subagentDelegationOn: false,
        routingProfile: 'balanced',
        systemNotificationsOn: true,
        openCodePermissionsOn: false
      })
      expect(s.rowCount()).toBe(1)
    })

    it('[INV-105] save then load returns exactly what was stored, one row per machine', async () => {
      const s = await setUp()

      save(s, CHOSEN)
      expect(s.store.load()).toStrictEqual(CHOSEN)

      const none: HostPreferences = {
        subagentDelegationOn: false,
        routingProfile: 'economy',
        systemNotificationsOn: true,
        openCodePermissionsOn: false
      }
      save(s, none)
      expect(s.store.load()).toStrictEqual(none)
      expect(s.rowCount()).toBe(1)
    })

    it('[INV-105] a model or an effort without a provider is rejected', async () => {
      const s = await setUp()
      save(s, CHOSEN)
      const withoutProvider: HostPreferences = { ...CHOSEN, defaultProvider: undefined }

      expect(() => save(s, { ...withoutProvider, defaultEffort: undefined })).toThrow()
      expect(() => save(s, { ...withoutProvider, defaultModel: undefined })).toThrow()
      expect(s.store.load()).toStrictEqual(CHOSEN)
      expect(s.rowCount()).toBe(1)
    })

    it('[INV-105] openCodePermissionsOn is derived from the OpenCode integration and never stored', async () => {
      const s = await setUp()

      save(s, { ...CHOSEN, openCodePermissionsOn: true })
      expect(s.store.load().openCodePermissionsOn).toBe(false)

      s.setOpenCodeIntegration('on-unverified')
      expect(s.store.load()).toStrictEqual({ ...CHOSEN, openCodePermissionsOn: true })
      s.setOpenCodeIntegration('on-verified')
      save(s, { ...CHOSEN, openCodePermissionsOn: false })
      expect(s.store.load().openCodePermissionsOn).toBe(true)
      s.setOpenCodeIntegration('off')
      expect(s.store.load().openCodePermissionsOn).toBe(false)
    })

    it('[INV-105] a rolled-back caller transaction leaves the stored preferences unchanged', async () => {
      const s = await setUp()
      save(s, CHOSEN)

      expect(() =>
        s.inTransaction(() => {
          s.store.save({ ...CHOSEN, routingProfile: 'economy', subagentDelegationOn: false })
          throw new CallerFailure('the caller failed after the save')
        })
      ).toThrow(CallerFailure)
      expect(s.store.load()).toStrictEqual(CHOSEN)
    })
  })
}
