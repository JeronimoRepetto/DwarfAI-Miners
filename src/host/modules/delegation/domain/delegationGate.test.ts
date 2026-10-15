import { describe, expect, it } from 'vitest'
import type { HostPreferences } from '../../preferences/index'
import { allows, type DelegationGateLaunch } from './delegationGate'

// The delegation gate (06 §11 `DelegationGate.allows`; ADR-013 item 4; PO #50): pure, no I/O.

/**
 * Migration 1's `host_preferences` seed row (09 §4.8 `subagent_delegation_on DEFAULT 0`, §4.9),
 * restated here because the database is its one source; the preferences store contract holds the
 * in-memory double equal to it.
 */
const DEFAULT_HOST_PREFERENCES: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

const rootLaunch = (launchedWithLetJevChoose: boolean): DelegationGateLaunch => ({
  launchedWithLetJevChoose,
  delegated: false
})

describe('delegationGate', () => {
  it('[US-DLG-001.AC05, INV-80] only the setting on and a launch that used Let Jev choose together open the gate; either alone is refused', () => {
    const table = [
      { setting: false, letJevChoose: false, open: false },
      { setting: true, letJevChoose: false, open: false },
      { setting: false, letJevChoose: true, open: false },
      { setting: true, letJevChoose: true, open: true }
    ]
    const seen = table.map(({ setting, letJevChoose }) => ({
      setting,
      letJevChoose,
      open: allows({ subagentDelegationOn: setting }, rootLaunch(letJevChoose))
    }))
    expect(seen).toEqual(table)
  })

  it('[US-DLG-001.AC02, INV-80] with the setting turned on a dwarf launched with Let Jev choose may delegate', () => {
    const turnedOn: HostPreferences = { ...DEFAULT_HOST_PREFERENCES, subagentDelegationOn: true }
    expect(allows(turnedOn, rootLaunch(true))).toBe(true)
  })

  it("[INV-81] a delegated worker's launch never opens the gate, whatever the setting", () => {
    for (const setting of [false, true]) {
      for (const letJevChoose of [false, true]) {
        expect(
          allows(
            { subagentDelegationOn: setting },
            { launchedWithLetJevChoose: letJevChoose, delegated: true }
          ),
          `setting ${String(setting)}, Let Jev choose ${String(letJevChoose)}`
        ).toBe(false)
      }
    }
  })

  it('[US-DLG-001.AC01] default Host preferences keep the gate closed', () => {
    expect(DEFAULT_HOST_PREFERENCES.subagentDelegationOn).toBe(false)
    expect(allows(DEFAULT_HOST_PREFERENCES, rootLaunch(true))).toBe(false)
    expect(allows(DEFAULT_HOST_PREFERENCES, rootLaunch(false))).toBe(false)
  })
})
