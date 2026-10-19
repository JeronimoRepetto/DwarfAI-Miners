import { ref } from 'vue'
import type { HostFrame, PreferencesView, SnapshotChunk } from '@dwarfai/contracts'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { DEFAULT_NOTIFICATIONS_ENABLED } from '../types'
import { useHostConnection } from './useHostConnection'

/**
 * State for Settings' notifications switch (#316).
 *
 * The same honesty rule `usePinnedWindow` enforces for the pin, and for the
 * same reason: `enabled` only ever changes to a value that came back from main,
 * because a press main refused or could not store must not be drawn as the
 * state in force. Main is also the only process that acts on this — it is main
 * that raises the notification — so the renderer's copy is a reading and never
 * an authority.
 *
 * No module-scope singleton: Settings is the only consumer, so per-call refs
 * keep tests independent without a clearAll() ritual.
 *
 * ISSUE-234 (14 §6.4 row `useNotificationSettings`; ADR-033 items 2–3): from the step-4a switch (ISSUE-235) A-42/A-43
 * read and write the Host-owned `systemNotificationsOn`, so the switch is also a read model of the `preferences`
 * snapshot section and of the `preferences.changed` frames above its seq: a change made in another window shows here.
 */
export function useNotificationSettings() {
  // Matches main's DEFAULT_NOTIFICATIONS_ENABLED so the first paint is almost
  // always right; sync() corrects it from the stored preference after mount.
  const enabled = ref(DEFAULT_NOTIFICATIONS_ENABLED)
  const applying = ref(false)

  /** Adopt the stored switch; on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      enabled.value = await window.api.getNotificationsEnabled()
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  /**
   * Ask main for a state. A second press while one is in flight is ignored — a
   * double-click must not fire two racing writes whose answers could land out
   * of order and leave the switch drawn at the older one.
   */
  async function set(next: boolean): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (applying.value) return
    applying.value = true
    try {
      enabled.value = await window.api.setNotificationsEnabled(next)
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  const model = createReadModel<{ on: boolean }, HostFrame>({
    state: { on: DEFAULT_NOTIFICATIONS_ENABLED },
    replace(data) {
      enabled.value = data.on
    },
    apply(frame) {
      if (frame.name !== 'preferences.changed') return
      enabled.value = (frame.data as PreferencesView).preferences.systemNotificationsOn
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
      dataOf: (chunks: readonly SnapshotChunk[]) => {
        const chunk = chunks.find((each) => each.section === 'preferences')
        return {
          on:
            chunk === undefined
              ? enabled.value
              : (chunk.data as PreferencesView).preferences.systemNotificationsOn
        }
      },
      settled: () => undefined
    }
  )

  return {
    enabled,
    applying,
    sync,
    set,
    /** Subscribes, then reads the snapshot (ISSUE-234); answers whether the switch is now fed by the Host. */
    start: () => follower.start(),
    stop: () => follower.stop()
  }
}
