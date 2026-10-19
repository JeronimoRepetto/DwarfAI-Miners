// The `AttentionSettings` bridge (05 §1.3 attention → preferences, §3.11; 16 §4.11, §8.3): the
// attention policy reads the one Host-owned preference that gates level 3, `systemNotificationsOn`
// (ADR-018 item 2), through it, so attention never imports preferences (R4).
//
// It reads `PreferencesQueries.get` on every call (no cache, 05 §4): a `preferences.set` that turns
// the preference off stops the next notification at once (ISSUE-116 mirrors the UI toggle here).
// The UI-main preference `notificationSoundsOn` is never read here (ADR-018 item 8, ADR-024).
import type { AttentionSettings } from '../../modules/attention'
import type { PreferencesQueries } from '../../modules/preferences'

export function preferencesAttentionSettings(
  queries: Pick<PreferencesQueries, 'get'>
): AttentionSettings {
  return { systemNotificationsOn: () => queries.get().systemNotificationsOn }
}
