import { describe, expect, it } from 'vitest'
import { decideUpgrade, type HostAnswerFacts, type UiBuildFacts } from './upgradeDecision'

// L1 (17 §1.1): the ADR-002 D8 decision table the UI applies after `hello`, one row per case
// (14 §1.3: `protocolVersion` only tells compat apart, never a feature gate). TC-032-01, TC-032-03,
// TC-032-04 (decision half).

const UI: UiBuildFacts = { protocolVersion: 7, endpointGeneration: 1, appVersion: '0.21.0' }

function hostSays(protocolVersion: number, endpointGeneration = 1): HostAnswerFacts {
  return { kind: 'hello-ok', protocolVersion, endpointGeneration, hostVersion: '0.20.0' }
}

describe('the upgrade decision table (ADR-002 D8)', () => {
  it('[ADR-002] the same protocolVersion attaches normally', () => {
    expect(decideUpgrade(UI, hostSays(7))).toBe('attach')
    // Different app versions with one protocol: nothing on the wire changed, so a normal attach.
    expect(decideUpgrade({ ...UI, appVersion: '0.21.1' }, hostSays(7))).toBe('attach')
  })

  it('[ADR-002, FM-131] a newer UI of the same generation attaches in compat mode and requests the upgrade', () => {
    expect(decideUpgrade(UI, hostSays(6))).toBe('attach-compat-and-request-upgrade')
    expect(decideUpgrade(UI, hostSays(1))).toBe('attach-compat-and-request-upgrade')
  })

  it('[ADR-002, FM-132] a different generation shows the blocking notice and drains only after confirmation', () => {
    // The older-generation Host refuses this UI's hello (UC-026), or answers an older generation.
    expect(
      decideUpgrade({ ...UI, endpointGeneration: 2 }, { kind: 'incompatible-generation' })
    ).toBe('blocking-notice-then-upgrade-drain')
    expect(decideUpgrade({ ...UI, endpointGeneration: 2 }, hostSays(6, 1))).toBe(
      'blocking-notice-then-upgrade-drain'
    )
  })

  it('[ADR-002, FM-133] an older UI never requests an upgrade, shows incompatible and offers only stop-all', () => {
    expect(decideUpgrade(UI, hostSays(8))).toBe('incompatible-offer-stop-all')
    // A newer generation Host that still answers this UI's generation is newer as well.
    expect(decideUpgrade(UI, hostSays(8, 2))).toBe('incompatible-offer-stop-all')
    expect(decideUpgrade(UI, hostSays(6, 2))).toBe('incompatible-offer-stop-all')
  })
})
