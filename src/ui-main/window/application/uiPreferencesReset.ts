// The Reset metrics UI step (ADR-024 item 8; ADR-023 item 4 step 5; 07 S13.04, S13.09, S40.10; 14 §4.3 rule 4): UI
// main's share of the saga's `ui-prefs` step. It runs on the Host's `ui.resetPreferences {epoch}` frame (B-F26), and
// at attach when the snapshot's `meta.resetEpoch` is newer than the epoch UI main applied last (a UI that was not
// attached when the reset ran, S13.09).
//
// - Every persisted UI store returns to its defaults; the session store is emptied but for its drafts (INV-113).
// - "Start with the system" returns to ON and is applied through machine 40 (S40.10): a refused entry leaves it at the
//   real state, logged, and the reset still completes. `asked` is the frame's: the person ran the reset from a window.
// - The epoch is stored as `resetEpochApplied`, every window is told (A-N12 `{epoch}`), and then the Host gets
//   `ui.resetPreferences.ack {epoch}` (B-M09). Each window re-reads A-N17 and A-N20 on A-N12 (14 §3.9, AMENDMENT-1);
//   no session patch is pushed.
// - An epoch already applied changes nothing and is acknowledged once more, so the saga never waits on it: the Host's
//   frame may arrive after the attach-time check applied the same epoch (B-M09 is idempotent by its shape).
// - A store that cannot be written logs it itself (`uiprefs.write-failed`); the reset goes on, so the ack is always
//   sent. A refused ack is not retried: a detached UI counts as acked (07 §24 I-14), and the next attach compares the
//   epochs again.
import { HOST_FRAME_SCHEMAS } from '@dwarfai/contracts'
import { defaultsOf, UI_PREFERENCE_DEFAULTS } from '../domain/uiPreferenceValues'
import type { HostClient, HostEvent } from '../ports/hostClient'
import type {
  UiPreferenceStore,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../ports/uiPreferenceStore'
import type { StartWithSystem } from './startWithSystem'
import type { UiSession } from './uiSession'

/** What started a reset: the Host's `ui.resetPreferences` frame, or a newer `meta.resetEpoch` at attach. */
export type UiPreferencesResetTrigger = 'frame' | 'attach'

export interface UiPreferencesResetDeps {
  store: UiPreferenceStore
  session: Pick<UiSession, 'clearExceptDrafts'>
  /** "Start with the system" (machine 40); absent while S-027-4 has not passed on this OS (loginEntryGate.ts). */
  startWithSystem?: Pick<StartWithSystem, 'reset'>
  /** A-N12 `onUiPreferencesReset` to every window, shown or hidden (ipc/handlers/uiPreferencesReset.ts). */
  push(reset: { epoch: number }): void
  host: Pick<HostClient, 'call' | 'subscribe'>
}

export interface UiPreferencesReset {
  /** Resets for `epoch` unless it is already applied, then acknowledges it. */
  apply(epoch: number, trigger: UiPreferencesResetTrigger): void
  /** Hears the Host's frames and snapshots; answers the unsubscribe. */
  listen(): () => void
}

/**
 * The stores this step returns to their defaults by writing them: every one but `startWithSystem`, which machine 40
 * applies, and `resetEpochApplied`, which takes the new epoch.
 */
const PLAIN_KEYS = (Object.keys(UI_PREFERENCE_DEFAULTS) as UiPreferenceStoreKey[]).filter(
  (key) => key !== 'startWithSystem' && key !== 'resetEpochApplied'
)

/** The epoch a Host event asks UI main to reach, or null for any other event. */
function epochOf(event: HostEvent): { epoch: number; trigger: UiPreferencesResetTrigger } | null {
  if (event.kind === 'frame') {
    if (event.frame.name !== 'ui.resetPreferences') return null
    const data = HOST_FRAME_SCHEMAS['ui.resetPreferences'].safeParse(event.frame.data)
    return data.success ? { epoch: data.data.epoch, trigger: 'frame' } : null
  }
  for (const chunk of event.snapshot.chunks) {
    if (chunk.section === 'meta') return { epoch: chunk.data.resetEpoch, trigger: 'attach' }
  }
  return null
}

export function createUiPreferencesReset(deps: UiPreferencesResetDeps): UiPreferencesReset {
  const { store, session, startWithSystem, push, host } = deps

  /** Writes `key`; a failed write was logged by the store and leaves the reset going. */
  function write<K extends UiPreferenceStoreKey>(key: K, value: UiPreferenceStoreMap[K]): void {
    try {
      store.save(key, value)
    } catch {
      // `uiprefs.write-failed` is the store's record.
    }
  }

  function apply(epoch: number, trigger: UiPreferencesResetTrigger): void {
    if (epoch > store.load('resetEpochApplied')) {
      for (const key of PLAIN_KEYS) write(key, defaultsOf(key))
      session.clearExceptDrafts()
      startWithSystem?.reset(trigger === 'frame')
      write('resetEpochApplied', epoch)
      push({ epoch })
    }
    host.call('ui.resetPreferences.ack', { epoch }).catch(() => {
      // Not retried: a detached UI counts as acked, and the next attach compares the epochs again.
    })
  }

  return {
    apply,
    listen: () =>
      host.subscribe((event) => {
        const asked = epochOf(event)
        // A snapshot whose epoch is not newer is the ordinary attach: nothing to apply, nothing to acknowledge.
        if (asked === null) return
        if (asked.trigger === 'attach' && asked.epoch <= store.load('resetEpochApplied')) return
        apply(asked.epoch, asked.trigger)
      })
  }
}
