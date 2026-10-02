import type { HostPreferenceKey } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createLegacySettingsWriteHub } from './legacySettingsWrites'

// L1 (17 §1.1): the legacy store's write notifications that `SettingsMirrorBridge` subscribes to (21 §3). Today's
// settings handlers report each save through `saved`; every subscriber hears it until it unsubscribes.

describe('legacy settings write notifications (21 §3)', () => {
  it('[ADR-001] each saved Host-read preference reaches every subscriber until it unsubscribes', () => {
    const hub = createLegacySettingsWriteHub()
    const first: HostPreferenceKey[] = []
    const second: HostPreferenceKey[] = []
    const stopFirst = hub.onWrite((key) => first.push(key))
    hub.onWrite((key) => second.push(key))

    hub.saved('systemNotificationsOn')
    stopFirst()
    hub.saved('routingProfile')

    expect(first).toEqual(['systemNotificationsOn'])
    expect(second).toEqual(['systemNotificationsOn', 'routingProfile'])
  })
})
