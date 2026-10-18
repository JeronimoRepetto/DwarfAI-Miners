import { computed, ref } from 'vue'
import type {
  ConsentOrigin,
  HostFrame,
  HostFrames,
  IpcResult,
  OpenCodeSettingsView,
  PreferencesView,
  SnapshotChunk
} from '@dwarfai/contracts'
import type { OpenCodeSettings } from '../types'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { mintRequestId } from './requestIds'
import { useHostConnection } from './useHostConnection'

/*
 * State for Settings' OpenCode section (#588 T6; ISSUE-234; 14 §6.4 row `useOpenCodeSettings`: A-52…A-55 +
 * `integration.changed`, CHANGE): the consent to the permission requests and the optional server password.
 *
 * - The state is the Host's `OpenCodeSettingsView` (14 §3.8): `permissions` is the `opencode-permissions`
 *   `IntegrationState`, with its `consentOrigin`; `passwordConfigured` and `secretBackend` are the password's status.
 *   It is a read model (ADR-033 item 3; readModel.ts): the snapshot's `preferences` section sets it with its seq, and a
 *   B-F25 `integration.changed` frame for `opencode-permissions` or a `preferences.changed` frame applies only when its
 *   seq is above the last one applied, so a change made in another window or entry point (the Add panel, the first-run
 *   step, a Reset) shows here (ADR-011; US-SET-009.AC08). A-52 (`sync`) reads the same view.
 * - The honesty rule `useNotificationSettings` and `useJevSettings` hold: the state only ever becomes a value the Host
 *   answered with. A-53 answers whether the Host could do it; it never sets the toggle, the Host's frames do (16 §7.4
 *   "the UI reflects the real state"), and a refusal is kept as `failure` (`config-write-failed` /
 *   `config-revert-failed`). The words for it are design's, not this composable's (no approved copy yet, 25-AGENTS §8.1),
 *   so it is not drawn. A-54/A-55 answer the view after the write, which this adopts.
 * - The password is handed straight to the preload by `savePassword` and never kept here; nothing the Host answers ever
 *   carries it (NFR-SEC-04, INV-107).
 * - One `applying` flag for the whole section, like `useJevSettings`' single `saving`: the switch and the password are
 *   one section, and a second request racing the first could land out of order. Read-only while the Host is not
 *   connected (ADR-002 D9; 13 FM-146): nothing leaves.
 */

type PermissionsFailure = 'config-write-failed' | 'config-revert-failed'

const OPENCODE_PERMISSIONS = 'opencode-permissions'

/** A fresh profile: off, no password, the OS secret store assumed until the Host says otherwise. */
export const DEFAULT_OPENCODE_SETTINGS_VIEW: OpenCodeSettingsView = {
  permissions: 'off',
  passwordConfigured: false,
  secretBackend: 'os-secret-store'
}

export interface OpenCodeSettingsDeps {
  /** A UUIDv7 per toggle intent (14 §1.6); the default mints one from the clock and the platform's random source. */
  newRequestId?: () => string
}

/** The section's view from the Host's `PreferencesView` (the snapshot section, or a `preferences.changed` frame). */
function viewOf(preferences: PreferencesView): OpenCodeSettingsView {
  const setting = preferences.integrations.find((entry) => entry.id === OPENCODE_PERMISSIONS)
  const password = preferences.secrets.find((secret) => secret.name === 'opencode-password')
  return {
    permissions: setting?.state ?? 'off',
    ...(setting?.consentOrigin === undefined ? {} : { consentOrigin: setting.consentOrigin }),
    passwordConfigured: password?.configured === true,
    secretBackend: preferences.secretBackend
  }
}

function preferencesOf(chunks: readonly SnapshotChunk[]): PreferencesView | undefined {
  for (const chunk of chunks) {
    if (chunk.section === 'preferences') return chunk.data as PreferencesView
  }
  return undefined
}

export function useOpenCodeSettings(deps: OpenCodeSettingsDeps = {}) {
  const { newRequestId = mintRequestId } = deps
  const settings = ref<OpenCodeSettingsView>({ ...DEFAULT_OPENCODE_SETTINGS_VIEW })
  const failure = ref<PermissionsFailure | null>(null)
  const applying = ref(false)

  const model = createReadModel<OpenCodeSettingsView, HostFrame>({
    state: { ...DEFAULT_OPENCODE_SETTINGS_VIEW },
    replace(data) {
      settings.value = { ...data }
    },
    apply(frame) {
      if (frame.name === 'preferences.changed') {
        settings.value = viewOf(frame.data as PreferencesView)
        return
      }
      if (frame.name !== 'integration.changed') return
      const data = frame.data as HostFrames['integration.changed']
      if (data.id !== OPENCODE_PERMISSIONS) return
      // The frame's own consent origin, or none: an origin the frame does not carry is not kept from before.
      const { passwordConfigured, secretBackend } = settings.value
      settings.value = {
        permissions: data.state,
        ...(data.consentOrigin === undefined ? {} : { consentOrigin: data.consentOrigin }),
        passwordConfigured,
        secretBackend
      }
    }
  })

  const follower: HostFollower = followHost(
    {
      subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
      snapshot: (params) => window.api.getHostSnapshot(params)
    },
    {
      model,
      sections: ['preferences'],
      dataOf: (chunks) => {
        const preferences = preferencesOf(chunks)
        return preferences === undefined
          ? { ...DEFAULT_OPENCODE_SETTINGS_VIEW }
          : viewOf(preferences)
      },
      settled: () => undefined
    }
  )

  /** Adopt the stored view (A-52); on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      const answer = await window.api.getOpenCodeSettings()
      if (answer.ok) settings.value = answer.value
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  async function run(request: () => Promise<void>): Promise<void> {
    if (useHostConnection().readOnly.value) return
    if (applying.value) return
    applying.value = true
    try {
      await request()
    } catch {
      // The failed write may or may not have reached the Host before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  /** A-53: turn the permission requests on or off, recorded with the entry point that asked (16 §7.2). */
  function setPermissions(on: boolean, origin: ConsentOrigin = 'settings'): Promise<void> {
    return run(async () => {
      const answer = await window.api.setOpenCodePluginEnabled({
        on,
        origin,
        requestId: newRequestId()
      })
      failure.value = answer.ok && !answer.value.ok ? answer.value.error : null
    })
  }

  /** Settings' switch: the consent origin `settings`. */
  function setPluginEnabled(enabled: boolean): Promise<void> {
    return setPermissions(enabled, 'settings')
  }

  /** A-54/A-55's answer: the view after the write, adopted only when it came. */
  function adopt(answer: IpcResult<OpenCodeSettingsView>): void {
    if (answer.ok) settings.value = answer.value
  }

  function savePassword(password: string): Promise<void> {
    return run(async () => adopt(await window.api.setOpenCodeServerPassword(password)))
  }

  function clearPassword(): Promise<void> {
    return run(async () => adopt(await window.api.clearOpenCodeServerPassword()))
  }

  /**
   * The section as Settings › Integrations draws it (`OpenCodeSettings.vue`, unchanged for the person): the switch is
   * on while the Host's integration is on; no OS secret store is today's `encryption-unavailable` reason.
   */
  const view = computed((): OpenCodeSettings => ({
    pluginEnabled: settings.value.permissions !== 'off',
    passwordConfigured: settings.value.passwordConfigured,
    ...(settings.value.secretBackend === 'unavailable'
      ? { passwordUnavailableReason: 'encryption-unavailable' as const }
      : {})
  }))

  return {
    settings,
    view,
    failure,
    applying,
    sync,
    /** Subscribes, then reads the snapshot; answers whether the state is now fed by the Host. */
    start: () => follower.start(),
    stop: () => follower.stop(),
    setPermissions,
    setPluginEnabled,
    savePassword,
    clearPassword
  }
}
