// A half of `SettingsMirrorBridge` (21 §3, cuts 1–3e): the part of the mirror one later issue owns (the notifications
// half, ISSUE-116, from cut 1; the Jev half, ISSUE-194, from 3a). It names the Host-read preferences it mirrors and
// reads each one's value from the legacy store, which stays the source of truth. Its keys are `HostPreferenceKey`s
// only (14 §3.4): a secret name or an integration id is not one, so a half can never list a secret (ADR-017 item 3)
// or an integration gate (ADR-016 item 5; 18 C-21). The bridge also refuses one at runtime.
import type { HostPreferenceKey, HostPreferences } from '@dwarfai/contracts'

export interface MirrorHalf<K extends HostPreferenceKey = HostPreferenceKey> {
  /** The Host-read preferences this half mirrors; each key belongs to one half only. */
  readonly keys: readonly K[]
  /** The value the legacy store holds for `key` now. */
  readLegacy(key: K): Promise<HostPreferences[K]>
}
