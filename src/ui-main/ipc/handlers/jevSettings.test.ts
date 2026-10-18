// layer: L2
// L2 (17 §1.2): A-47's mapping from the Host's `PreferencesView` to today's `JevSettings` (14 §2.1 A-47 adapter:
// `HostPreferences` + `SecretStatus('jev-key')` + `SecretBackend`; ADR-017 item 3: the key never crosses).
import { describe, expect, it } from 'vitest'
import { CHANNELS, type PreferencesView } from '@dwarfai/contracts'
import { jevSettingsOf } from './jevSettings.host'

const VIEW: PreferencesView = {
  preferences: {
    subagentDelegationOn: true,
    routingProfile: 'premium',
    defaultProvider: 'claude',
    defaultModel: 'opus',
    defaultEffort: 'high',
    systemNotificationsOn: false,
    openCodePermissionsOn: true
  },
  secrets: [
    { name: 'opencode-password', configured: false },
    { name: 'jev-key', configured: true }
  ],
  secretBackend: 'os-secret-store',
  integrations: [],
  welcome: { due: false, legacyFound: [], offered: [] }
}

describe('getJevSettings from the Host (14 §2.1 A-47)', () => {
  it("[ADR-017] getJevSettings carries the key's configured flag and never a key", () => {
    const answer = jevSettingsOf(VIEW)
    expect(answer).toEqual({
      configured: true,
      preferences: {
        profile: 'premium',
        default: { provider: 'claude', model: 'opus', effort: 'high' },
        delegation: true
      }
    })
    // Today's shape, strictly: no key, no validity flag, no other secret's status, no preference Settings does not own.
    expect(CHANNELS['jev:settings:get'].response.parse(answer)).toEqual(answer)
    expect(Object.keys(answer).sort()).toEqual(['configured', 'preferences'])

    // The flag is the Jev key's own: another secret's status never answers for it.
    const noKey = { ...VIEW, secrets: [{ name: 'opencode-password' as const, configured: true }] }
    expect(jevSettingsOf(noKey).configured).toBe(false)
    // No OS secret store: never configured, with today's reason (ADR-017 item 5).
    expect(jevSettingsOf({ ...VIEW, secretBackend: 'unavailable' })).toEqual({
      configured: false,
      unavailableReason: 'encryption-unavailable',
      preferences: answer.preferences
    })
  })
})
