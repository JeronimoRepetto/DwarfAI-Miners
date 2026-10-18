// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostFrame,
  HostFrames,
  IpcResult,
  OpenCodeSettingsView,
  PreferencesView,
  SetOpenCodePermissionsParams,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { DEFAULT_OPENCODE_SETTINGS_VIEW, useOpenCodeSettings } from './useOpenCodeSettings'

/**
 * Settings' OpenCode section, renderer side (#588 T6).
 *
 * The honesty rule every settings composable here holds: `settings` only ever
 * becomes a value main answered with. For this section that matters twice
 * over — a relay main could not turn on must never be drawn as on, and the
 * password is never part of any value this composable holds.
 *
 * AMENDED for ISSUE-234 (was: today's `OpenCodeSettings`, `pluginEnabled: boolean` with a `pluginError` string, and
 * A-53 taking a boolean): from the step-4a switch (ISSUE-235) A-52…A-55 answer the 14 §3.8 `OpenCodeSettingsView`
 * (`permissions: IntegrationState`, 14 §2.1 A-52 CHANGE) inside an `IpcResult`, A-53 takes
 * `SetOpenCodePermissionsParams` and answers the Host's `Outcome`, and the state is a read model that also follows the
 * `preferences` snapshot section and the `integration.changed` / `preferences.changed` frames above its seq (ADR-033
 * items 2–3; 14 §6.4 row `useOpenCodeSettings`).
 */
type Api = ReturnType<typeof createFakeWindowApi>
type SnapshotAnswer = IpcResult<SnapshotPage>

const EPOCH = 'epoch-0234'
const REQUEST = '01920000-0000-7000-a000-000000000234'
const OFF: OpenCodeSettingsView = { ...DEFAULT_OPENCODE_SETTINGS_VIEW }

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function preferencesView(overrides: Partial<PreferencesView> = {}): PreferencesView {
  return {
    preferences: {
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    },
    secrets: [{ name: 'opencode-password', configured: false }],
    secretBackend: 'os-secret-store',
    integrations: [
      { id: 'claude-hooks', state: 'off', changedAt: 1 },
      { id: 'opencode-permissions', state: 'off', changedAt: 1 }
    ],
    welcome: { due: false, legacyFound: [], offered: [] },
    ...overrides
  } as PreferencesView
}

function page(seq: number, view: PreferencesView = preferencesView()): SnapshotAnswer {
  return {
    ok: true,
    value: {
      snapshotId: `snap-${seq}`,
      seq,
      epoch: EPOCH,
      chunks: [{ section: 'preferences', data: view }]
    }
  } as SnapshotAnswer
}

function integrationChanged(seq: number, data: HostFrames['integration.changed']): HostFrame {
  return { type: 'evt', seq, epoch: EPOCH, name: 'integration.changed', data } as HostFrame
}

function fakeApi(overrides: Record<string, unknown> = {}) {
  let listener: ((frames: HostFrame[]) => void) | null = null
  const api = {
    getOpenCodeSettings: vi.fn().mockResolvedValue(ok({ ...OFF })),
    setOpenCodePluginEnabled: vi.fn(async (request: SetOpenCodePermissionsParams) =>
      ok({ ok: true, value: { state: request.on ? 'on-verified' : 'off' } })
    ),
    setOpenCodeServerPassword: vi.fn(async () => ok({ ...OFF, passwordConfigured: true })),
    clearOpenCodeServerPassword: vi.fn(async () => ok({ ...OFF })),
    getHostSnapshot: vi.fn((_request: SnapshotParams) => Promise.resolve(page(10))),
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    }),
    ...overrides
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi(api as unknown as Partial<Api>)
  })
  return {
    ...api,
    push(frames: HostFrame[]) {
      if (listener === null) throw new Error('nothing follows onHostEvent')
      listener(frames)
    }
  }
}

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function section() {
  const opencode = useOpenCodeSettings({ newRequestId: () => REQUEST })
  stops.push(opencode.stop)
  return opencode
}

describe('useOpenCodeSettings (#588 T6)', () => {
  it('starts off, the true state of an install that never touched it', () => {
    fakeApi()
    expect(section().settings.value).toEqual(OFF)
  })

  it('adopts the stored settings on sync, and keeps the last known ones when the bridge fails', async () => {
    fakeApi({
      getOpenCodeSettings: vi
        .fn()
        .mockResolvedValueOnce(ok({ ...OFF, permissions: 'on-verified' }))
        .mockRejectedValueOnce(new Error('no bridge'))
    })
    const { settings, sync } = section()
    await sync()
    expect(settings.value.permissions).toBe('on-verified')
    await sync()
    expect(settings.value.permissions).toBe('on-verified')
  })

  it('draws a refused switch as off, with the Host’s failure beside it', async () => {
    const api = fakeApi({
      setOpenCodePluginEnabled: vi.fn(async () => ok({ ok: false, error: 'config-write-failed' }))
    })
    const { settings, failure, setPluginEnabled } = section()
    await setPluginEnabled(true)
    expect(settings.value.permissions).toBe('off')
    expect(failure.value).toBe('config-write-failed')
    expect(api.setOpenCodePluginEnabled).toHaveBeenCalledWith({
      on: true,
      origin: 'settings',
      requestId: REQUEST
    })
  })

  it('hands the password to the bridge and keeps no copy of it', async () => {
    const api = fakeApi()
    const { settings, savePassword } = section()
    await savePassword('hunter2')
    expect(api.setOpenCodeServerPassword).toHaveBeenCalledWith('hunter2')
    expect(settings.value.passwordConfigured).toBe(true)
    expect(JSON.stringify(settings.value)).not.toContain('hunter2')
  })

  it('clears the password through main', async () => {
    const api = fakeApi({
      getOpenCodeSettings: vi.fn().mockResolvedValue(ok({ ...OFF, passwordConfigured: true }))
    })
    const { settings, sync, clearPassword } = section()
    await sync()
    await clearPassword()
    expect(api.clearOpenCodeServerPassword).toHaveBeenCalledOnce()
    expect(settings.value.passwordConfigured).toBe(false)
  })

  it('ignores a second request while one is in flight', async () => {
    let release: () => void = () => undefined
    const api = fakeApi({
      setOpenCodePluginEnabled: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve(ok({ ok: true, value: { state: 'on-verified' } }))
          })
      )
    })
    const { applying, setPluginEnabled, savePassword } = section()
    const first = setPluginEnabled(true)
    expect(applying.value).toBe(true)
    await setPluginEnabled(false)
    await savePassword('x')
    release()
    await first
    expect(api.setOpenCodePluginEnabled).toHaveBeenCalledOnce()
    expect(api.setOpenCodeServerPassword).not.toHaveBeenCalled()
    expect(applying.value).toBe(false)
  })

  it('re-reads the real state when a write breaks on the way', async () => {
    const api = fakeApi({
      setOpenCodePluginEnabled: vi.fn().mockRejectedValue(new Error('bridge broke'))
    })
    const { setPluginEnabled } = section()
    await setPluginEnabled(true)
    expect(api.getOpenCodeSettings).toHaveBeenCalledOnce()
  })

  // ADDED for ISSUE-234 (14 §6.4 row `useOpenCodeSettings`; ADR-033 items 2–3; ISSUE-234 tests 1–3, 6).
  it('[US-SET-009.AC07] useOpenCodeSettings reads permissions off from OpenCodeSettingsView on a fresh profile', async () => {
    fakeApi()
    const { settings, sync } = section()
    await sync()
    expect(settings.value).toEqual({
      permissions: 'off',
      passwordConfigured: false,
      secretBackend: 'os-secret-store'
    })
  })

  it('[US-SET-009.AC08, ADR-011] an integration.changed frame from another entry point updates the toggle in this window', async () => {
    const api = fakeApi()
    const opencode = section()
    expect(await opencode.start()).toBe(true)
    expect(api.getHostSnapshot).toHaveBeenCalledWith({ sections: ['preferences'] })
    expect(opencode.settings.value.permissions).toBe('off')

    // The Add panel of another window (or the first-run step) turned it on: this window follows the Host.
    api.push([
      integrationChanged(11, {
        id: 'opencode-permissions',
        state: 'on-verified',
        consentOrigin: 'add-panel'
      })
    ])
    expect(opencode.settings.value.permissions).toBe('on-verified')
    expect(opencode.settings.value.consentOrigin).toBe('add-panel')
    // Another integration's frame leaves it alone.
    api.push([integrationChanged(12, { id: 'claude-hooks', state: 'off' })])
    expect(opencode.settings.value.permissions).toBe('on-verified')
  })

  it('[US-SET-009.AC03, NFR-SEC-04] saving the password shows the stored state and never keeps the typed value in state', async () => {
    const api = fakeApi()
    const opencode = section()
    await opencode.start()
    await opencode.savePassword('typed-pass-0234')
    expect(api.setOpenCodeServerPassword).toHaveBeenCalledWith('typed-pass-0234')
    expect(opencode.settings.value.passwordConfigured).toBe(true)
    // A later preferences.changed frame (the Host's whole view) keeps it stored and still carries no password.
    api.push([
      {
        type: 'evt',
        seq: 11,
        epoch: EPOCH,
        name: 'preferences.changed',
        data: preferencesView({ secrets: [{ name: 'opencode-password', configured: true }] })
      } as HostFrame
    ])
    expect(opencode.settings.value.passwordConfigured).toBe(true)
    expect(JSON.stringify(opencode.settings.value)).not.toContain('typed-pass-0234')
    expect(JSON.stringify(opencode.view.value)).not.toContain('typed-pass-0234')
  })

  it('[ADR-033] a frame with a seq at or below the snapshot’s is ignored', async () => {
    const api = fakeApi({ getHostSnapshot: vi.fn(() => Promise.resolve(page(20))) })
    const opencode = section()
    await opencode.start()
    api.push([
      integrationChanged(20, { id: 'opencode-permissions', state: 'on-verified' }),
      integrationChanged(19, { id: 'opencode-permissions', state: 'on-unverified' })
    ])
    expect(opencode.settings.value.permissions).toBe('off')
    api.push([integrationChanged(21, { id: 'opencode-permissions', state: 'on-unverified' })])
    expect(opencode.settings.value.permissions).toBe('on-unverified')
  })
})
