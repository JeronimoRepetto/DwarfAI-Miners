// ADR-011 item 1: the permission modes offered for a launch target are the catalog's modes
// (`ProviderProfile.permissionModes`, a ceiling, in catalog order) filtered by the effective
// `permission` capability, and the entry's answer channel (06 §0.2; ADR-011 item 7):
//
// - `interactive` → every catalog mode, the interactive one ("Ask first") first;
// - `policy-only` → only the modes the provider enforces without asking; never "Ask first";
// - `none` → the policy-only modes only behind a verified non-interactive deny policy, else none.
//
// The first offered mode is the preselected one (US-LAUNCH-001 order). A mode id the catalog lists
// without a spec is never offered (fail closed). Every input is data: no provider id is read
// (R12, INV-40). Pure: no I/O, no clock read (05 §2.2, R1).
import type { IntegrationState } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from './capabilities'
import type { PermissionModeCatalog, PermissionModeSpec, ProviderProfile } from './profile'

export type { PermissionModeCatalog }

export function offeredModes(
  profile: ProviderProfile,
  caps: ProviderCapabilities,
  catalog: PermissionModeCatalog
): PermissionModeSpec[] {
  const listed = profile.permissionModes.flatMap((id) => {
    const found = catalog.specs.find((spec) => spec.id === id)
    return found === undefined ? [] : [found]
  })
  const policyOnly = listed.filter((spec) => spec.needs === 'policy-only')
  switch (caps.permission) {
    case 'interactive':
      return [...listed.filter((spec) => spec.needs === 'interactive'), ...policyOnly]
    case 'policy-only':
      return policyOnly
    case 'none':
      return catalog.denyPolicyVerified ? policyOnly : []
  }
}

/**
 * 06 §0.2 `SupplierEntry.answerChannel`: `gated-off` while the entry's gating integration is not
 * `on-verified` (ADR-011 item 7, Q23); otherwise `available` iff the effective capabilities can
 * carry an answer, else `none`. `gate` is the gating integration's state, `null` when not gated.
 */
export function answerChannelOf(
  caps: ProviderCapabilities,
  gate: IntegrationState | null
): 'available' | 'gated-off' | 'none' {
  if (gate !== null && gate !== 'on-verified') return 'gated-off'
  return caps.permission === 'interactive' || caps.question !== 'none' ? 'available' : 'none'
}
