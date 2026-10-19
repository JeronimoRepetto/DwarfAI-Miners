import { ref } from 'vue'
import {
  CHANNELS,
  type HostFrame,
  type HostPreferences,
  type PreferencesView,
  type SnapshotChunk
} from '@dwarfai/contracts'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { DEFAULT_JEV_SETTINGS, type JevPreferences, type JevSettings } from '../types'
import type { AgentModelCatalog, AgentProviderOption } from '../types'
import { useHostConnection } from './useHostConnection'
import { launchSourcesOf } from '../lib/launch/supplierEntries'

/**
 * State for Settings' Jev API-key control (#509).
 *
 * The same honesty rule `useNotificationSettings` and `usePinnedWindow` hold,
 * for the same reason: `settings` only ever becomes a value that came back
 * from main, because a save or a clear main refused must not be drawn as the
 * key being configured. Main is also the only process that ever sees the
 * plaintext key — this composable's `save` hands the typed value straight to
 * the preload and never keeps a copy — so `settings` is a reading and never
 * an authority, exactly like the switch it sits beside in Settings.
 *
 * No module-scope singleton: Settings is the only consumer, so per-call refs
 * keep tests independent without a clearAll() ritual.
 *
 * AMENDED for the #509 follow-up: `providers`/`catalogs` feed the
 * default-launch pickers, asked the same way `useAgentLaunch.open()` asks —
 * a live per-machine reading rather than something worth holding from
 * startup — but only once `settings.configured` is true, since Settings
 * draws neither picker before then and an unconfigured section has nothing
 * to fill them for.
 */

/**
 * Ask the bridge for one thing, and answer with `fallback` for EITHER way it
 * can fail to — a real rejection, or the member not existing at all on a test
 * double — the same shape `useAgentLaunch`'s own `safelyAsk` holds, copied
 * rather than shared: that one lives beside `launchState.ts` (T3/T4 territory
 * this task does not touch), and a helper this small is cheaper to repeat
 * than to lift into a shared module for one caller each.
 */
async function safelyAsk<T>(ask: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await ask()
  } catch {
    return fallback
  }
}

/**
 * The document, as something the context bridge can actually carry.
 *
 * `window.api` is a contextBridge function, so every argument is structured-
 * CLONED on the way across — and a Vue reactive Proxy is not clonable. The
 * bridge throws `An object could not be cloned` before the preload's own
 * parser, which does build a plain document, is ever reached; the value has
 * to survive the crossing to get there.
 *
 * The section emits `{ ...preferences.value, profile }`, and that spread is
 * SHALLOW: `profile` becomes a primitive while `default` stays the very Proxy
 * it came from in the props. That is why changing the default PROVIDER always
 * worked and changing the profile never did — the provider handler builds a
 * fresh `{ provider }`, the profile handler reuses the Proxy.
 *
 * Rebuilt field by field rather than deep-cloned: `JevLaunchDefault` is flat
 * and every member is a primitive, so this is total, and a member added later
 * is a type error here rather than a value that silently stops crossing.
 *
 * `delegation` (#511) is a plain boolean straight off `preferences`, not off
 * the Proxy `default` sits under, so it never needed the provider/model/
 * effort dance above — copied by value the moment it is read.
 */
function acrossTheBridge(preferences: JevPreferences): JevPreferences {
  const { provider, model, effort } = preferences.default
  return {
    profile: preferences.profile,
    default: {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort })
    },
    delegation: preferences.delegation
  }
}

/** A catalogue that could not be asked: no source, as a call error reads (lib/launch/supplierEntries.ts). */
/*
 * ISSUE-234 (14 §6.4 row `useJevSettings`; ADR-033 items 2–3): from the step-4a switch (ISSUE-235) A-47…A-51 are
 * served from the Host's preferences, so the section is also a read model of the `preferences` snapshot section and of
 * the `preferences.changed` frames above its seq: a change made elsewhere (another window, a Reset) shows here. The
 * Host's `PreferencesView` is read as A-47 reads it (`jevSettings.host.ts` `jevSettingsOf`): the key's own status,
 * never the key (INV-107); no OS secret store is today's `encryption-unavailable`; a stored provider today's rows
 * cannot carry reads as "None".
 */
const TODAY_PROVIDER = CHANNELS['jev:preferences:set'].request.shape.default.shape.provider

function jevSettingsOf(view: PreferencesView): JevSettings {
  const key = view.secrets.find((secret) => secret.name === 'jev-key')
  const preferences: HostPreferences = view.preferences
  const provider = TODAY_PROVIDER.safeParse(preferences.defaultProvider)
  const launchDefault =
    !provider.success || provider.data === undefined
      ? {}
      : {
          provider: provider.data,
          ...(preferences.defaultModel === undefined ? {} : { model: preferences.defaultModel }),
          ...(preferences.defaultEffort === undefined ? {} : { effort: preferences.defaultEffort })
        }
  return {
    ...(view.secretBackend === 'unavailable'
      ? { configured: false, unavailableReason: 'encryption-unavailable' as const }
      : { configured: key?.configured === true }),
    preferences: {
      profile: preferences.routingProfile,
      default: launchDefault,
      delegation: preferences.subagentDelegationOn
    }
  } as JevSettings
}

function preferencesOf(chunks: readonly SnapshotChunk[]): PreferencesView | undefined {
  for (const chunk of chunks) {
    if (chunk.section === 'preferences') return chunk.data as PreferencesView
  }
  return undefined
}

const NO_CATALOGUE = {
  ok: false,
  error: { code: 'INTERNAL', message: 'the catalogue could not be asked', retryable: true }
} as const

export function useJevSettings() {
  // Matches main's DEFAULT_JEV_SETTINGS so the first paint is almost always
  // right; sync() corrects it from the stored verdict after mount.
  const settings = ref<JevSettings>({ ...DEFAULT_JEV_SETTINGS })
  const saving = ref(false)
  const providers = ref<AgentProviderOption[]>([])
  const catalogs = ref<AgentModelCatalog[]>([])

  /**
   * Ask what this machine can launch, for the default-launch pickers. AMENDED for ISSUE-001 (was: today's A-36 and A-37,
   * asked together): from 3a A-36 answers every provider's entry with its models (`SupplierEntryView`, A-37 retired),
   * read into the pickers' own lists (lib/launch/supplierEntries.ts).
   */
  async function loadLaunchSources(): Promise<void> {
    const sources = launchSourcesOf(
      await safelyAsk(() => window.api.listAgentProviders({}), NO_CATALOGUE)
    )
    providers.value = sources.providers
    catalogs.value = sources.catalogs
  }

  /** Adopt the stored verdict; on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      settings.value = await window.api.getJevSettings()
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
      return
    }
    if (settings.value.configured) await loadLaunchSources()
  }

  /**
   * Ask main to enter or replace the key. A second call while one is in
   * flight is ignored — a double-click must not fire two racing writes whose
   * answers could land out of order and leave the section drawn at the older
   * one.
   */
  async function save(key: string): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (saving.value) return
    saving.value = true
    try {
      settings.value = await window.api.setJevApiKey(key)
      // A first key just turned the section on: the default-launch pickers
      // need real options the moment they appear, not on the next reload.
      if (settings.value.configured) await loadLaunchSources()
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      saving.value = false
    }
  }

  /** Ask main to forget the key. Same in-flight guard as save(). */
  async function clear(): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (saving.value) return
    saving.value = true
    try {
      settings.value = await window.api.clearJevApiKey()
    } catch {
      await sync()
    } finally {
      saving.value = false
    }
  }

  /**
   * Ask main to change the routing profile and/or the default launch
   * (#509 follow-up). Same applying-guard/re-sync idiom as `save`/`clear`,
   * and the SAME `saving` flag — TypographySettings' `applying` already
   * locks its two rows together for one section, and this is one section
   * too: the key controls and the preference controls are never expected to
   * be edited in the same instant.
   */
  async function setPreferences(preferences: JevPreferences): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (saving.value) return
    saving.value = true
    try {
      // Main answers with what is STORED plus, when the request did not take,
      // why — so a refusal arrives here as an ordinary value carrying its own
      // `preferencesError`, and nothing has to be inferred from silence.
      settings.value = await window.api.setJevPreferences(acrossTheBridge(preferences))
    } catch (error) {
      /*
       * A rejection means the call itself never landed, so the stored state
       * is whatever it already was: the last known value is still the most
       * honest thing to draw, and the reason goes beside it.
       *
       * This used to `await sync()` instead. That re-read is what turned a
       * failed click into a LOADING one — `sync()` re-queries the launch
       * catalogue, which spawns a provider CLI — and it ran while `saving`
       * was still held, so the control stayed disabled and the next click
       * was eaten by the in-flight guard above. One swallowed failure
       * therefore looked exactly like a control that ignores you.
       */
      settings.value = {
        ...settings.value,
        preferencesError: error instanceof Error ? error.message : String(error)
      }
    } finally {
      saving.value = false
    }
  }

  const model = createReadModel<JevSettings, HostFrame>({
    state: { ...DEFAULT_JEV_SETTINGS },
    replace(data) {
      settings.value = data
    },
    apply(frame) {
      if (frame.name !== 'preferences.changed') return
      settings.value = jevSettingsOf(frame.data as PreferencesView)
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
        const view = preferencesOf(chunks)
        return view === undefined ? settings.value : jevSettingsOf(view)
      },
      settled: () => undefined
    }
  )

  return {
    settings,
    saving,
    providers,
    catalogs,
    sync,
    save,
    clear,
    setPreferences,
    /** Subscribes, then reads the snapshot (ISSUE-234); answers whether the state is now fed by the Host. */
    start: () => follower.start(),
    stop: () => follower.stop()
  }
}
