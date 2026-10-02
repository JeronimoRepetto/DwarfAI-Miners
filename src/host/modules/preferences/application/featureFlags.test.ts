// layer: L2
// L2 (17 §1.2): `PreferencesQueries.featureFlags` answers the flags read once at construction
// (16 §4.12, INV-110, NFR-PERS-16). That no seam member takes a flag (US-GUILD-002.AC03) is proven
// by the registry scan in host/wiring/featureFlagReader.test.ts: an application test may not import
// `contracts` (R3/R9 lint), and `host/wiring` may.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { PreferencesEvent } from '../domain/events'
import { FakeFeatureFlagReader } from '../ports/fakes/FakeFeatureFlagReader'
import { InMemoryPreferencesStore } from '../ports/fakes/InMemoryPreferencesStore'
import { PreferencesService } from './preferencesService'

function serviceOver(flags: FakeFeatureFlagReader): PreferencesService {
  return new PreferencesService({
    store: new InMemoryPreferencesStore(),
    transactions: { inTransaction: (work) => work() },
    bus: new RecordingEventBus<PreferencesEvent>(),
    clock: new FakeClock(1_750_000_000_000),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0211',
    featureFlags: flags
  })
}

describe('PreferencesQueries.featureFlags', () => {
  it('[US-GUILD-002.AC03, INV-110, NFR-PERS-16] a changed environment or config file after start changes nothing until the next start', () => {
    const reader = new FakeFeatureFlagReader({ guildAreasEnabled: true })
    const preferences = serviceOver(reader)

    expect(preferences.featureFlags()).toStrictEqual({
      guildAreasEnabled: true,
      boostEnabled: false
    })

    // What a re-read would now find: the environment or the file changed while the Host runs.
    reader.set({ guildAreasEnabled: false, boostEnabled: true })

    expect(preferences.featureFlags()).toStrictEqual({
      guildAreasEnabled: true,
      boostEnabled: false
    })
    expect(reader.reads).toBe(1)

    // The next start reads the new values.
    expect(serviceOver(reader).featureFlags()).toStrictEqual({
      guildAreasEnabled: false,
      boostEnabled: true
    })
  })
})
