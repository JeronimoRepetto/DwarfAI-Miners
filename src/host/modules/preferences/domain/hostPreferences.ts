// The Host's preferences aggregate (06 §14.2 `HostPreferences`, INV-105; 05 §3.12): one singleton per
// machine, read by the Host itself (delegation gate, routing profile, default launch, system
// notifications). `openCodePermissionsOn` is derived from the OpenCode integration, never stored
// (06 §14.2; 09 D-06), so it is not a writable key (14 §3.4 `HostPreferenceKey`). Secrets are never
// preferences: they live only behind the `SecretStore` port (ADR-017). `notificationSoundsOn` is a
// UI-main preference, not this one (ADR-024).
//
// Pure: no I/O, no clock (05 §2.2, R1).

/** A catalog provider id (06 §0.1 `ProviderId`): an open string, validated at the transport (R12). */
export type ProviderId = string

/** 06 §12 `JevRoutingProfile`. */
export type JevRoutingProfile = 'economy' | 'balanced' | 'premium'

/** 06 §14.2 `HostPreferences`. A missing `defaultProvider` is "None" (09 §4.9; OQ-72 A). */
export interface HostPreferences {
  subagentDelegationOn: boolean
  routingProfile: JevRoutingProfile
  defaultProvider?: ProviderId
  defaultModel?: string
  defaultEffort?: string
  systemNotificationsOn: boolean
  openCodePermissionsOn: boolean
}

/** 14 §3.4 `HostPreferenceKey`: the writable keys (`openCodePermissionsOn` is derived, 06). */
export type HostPreferenceKey =
  | 'subagentDelegationOn'
  | 'routingProfile'
  | 'defaultProvider'
  | 'defaultModel'
  | 'defaultEffort'
  | 'systemNotificationsOn'

// The defaults are migration 1's seed row (09 §4.9): delegation off, routing balanced, system
// notifications on, no default provider, OpenCode permissions off. The database is their one
// source; the in-memory double restates them, held equal by the store contract.

/**
 * The 09 §4.8 rule — a default model or effort exists only with a default provider — applied to a
 * write: `current` with `key` set to `value`, kept within the rule: without a default provider
 * there is no default model or effort, so clearing the provider clears both, and a model or an
 * effort set while no provider is chosen is not kept. What is stored is the answer (INV-105).
 */
export function withPreference<K extends HostPreferenceKey>(
  current: HostPreferences,
  key: K,
  value: HostPreferences[K]
): HostPreferences {
  const next = { ...current, [key]: value }
  if (next.defaultProvider !== undefined) return compact(next)
  return compact({ ...next, defaultModel: undefined, defaultEffort: undefined })
}

/** Whether `a` and `b` hold the same values (a setter that stores the same value publishes nothing). */
export function samePreferences(a: HostPreferences, b: HostPreferences): boolean {
  return (
    a.subagentDelegationOn === b.subagentDelegationOn &&
    a.routingProfile === b.routingProfile &&
    a.defaultProvider === b.defaultProvider &&
    a.defaultModel === b.defaultModel &&
    a.defaultEffort === b.defaultEffort &&
    a.systemNotificationsOn === b.systemNotificationsOn &&
    a.openCodePermissionsOn === b.openCodePermissionsOn
  )
}

/** `preferences` without the optional keys whose value is undefined (absent = "None"). */
function compact(preferences: HostPreferences): HostPreferences {
  const out: HostPreferences = {
    subagentDelegationOn: preferences.subagentDelegationOn,
    routingProfile: preferences.routingProfile,
    systemNotificationsOn: preferences.systemNotificationsOn,
    openCodePermissionsOn: preferences.openCodePermissionsOn
  }
  if (preferences.defaultProvider !== undefined) out.defaultProvider = preferences.defaultProvider
  if (preferences.defaultModel !== undefined) out.defaultModel = preferences.defaultModel
  if (preferences.defaultEffort !== undefined) out.defaultEffort = preferences.defaultEffort
  return out
}
