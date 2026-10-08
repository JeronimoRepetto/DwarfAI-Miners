// The permission answer domain (ADR-010 item 3, INV-73; PO #29): Allow or Deny, nothing else.
// Drivers map the two to the provider's once-options (ADR-009 D3, HR A2); the Host never offers,
// accepts or maps to an "always" or session-scope decision. "Other thing…" is not a decision: it is
// an ordinary message (ADR-010 item 2, 07 S6.05). Pure (05 §2.2, R1).

/** The only two decisions a permission ask takes (ADR-010 item 5 `answerPermission`). */
export type PermissionDecision = 'allow' | 'deny'

/**
 * What the reporter found in the provider's option set; the shape is the `options` field of
 * suppliers' `AskInput` permission arm (15 §1.2), read here only for `hasAllowOnce`.
 */
export interface PermissionOptionFlags {
  readonly hasAllowOnce: boolean
}

const DECISIONS: readonly PermissionDecision[] = Object.freeze(['allow', 'deny'])

/** The decisions a permission card offers: exactly Allow and Deny (TC-126-02). */
export function permissionDecisions(): readonly PermissionDecision[] {
  return DECISIONS
}

/** The gate for a submitted decision: anything but `allow` or `deny` is never accepted. */
export function isPermissionDecision(value: string): value is PermissionDecision {
  return value === 'allow' || value === 'deny'
}

/**
 * A permission is a card ask only when the provider offers a one-time allow (OQ-42 B): without it
 * Allow could only map to a broader option, which INV-73 forbids, so the request takes the
 * no-channel handling instead (ADR-010 item 3, ADR-011).
 */
export function hasAllowOnce(options: PermissionOptionFlags): boolean {
  return options.hasAllowOnce
}
