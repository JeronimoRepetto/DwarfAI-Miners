// The supplier the failure notice names (US-LAUNCH-006.AC10, AC11; ADR-020 D1 `supplierLabel`).
// Pure (05 §2.2, R1). A chip's label is data from the supplier catalog: this file never compares a
// provider id (R12).

/** A supplier choice as the pickers show it. */
export type SupplierChoice =
  | { kind: 'chip'; label: string } // a supplier chip, with its own label
  | { kind: 'custom-command' } // "Other…"

export interface SupplierLabelFacts {
  /** What the person has checked; `null` when nothing was chosen. */
  checked: SupplierChoice | null
  /**
   * Present when Jev is on: `pick` is Jev's pick, or the supplier Jev was about to pick when Jev
   * itself is the cause and had not yet answered; `changedByPerson` is true once the person changed it.
   */
  jev?: { pick: SupplierChoice | null; changedByPerson: boolean }
}

/** US-LAUNCH-006.AC10 copy for "Other…". */
export const CUSTOM_COMMAND_LABEL = 'The custom command'

/** US-LAUNCH-006.AC10 copy when no supplier was chosen at all. */
export const NO_SUPPLIER_LABEL = 'The supplier'

/**
 * AC10: the checked chip's own label, "The custom command" for "Other…", "The supplier" when none
 * was chosen. AC11: with Jev on, Jev's pick (or its intended pick) unless the person changed it.
 */
export function supplierLabel(facts: SupplierLabelFacts): string {
  const { checked, jev } = facts
  const named = jev === undefined || jev.changedByPerson ? checked : jev.pick
  if (named === null) return NO_SUPPLIER_LABEL
  return named.kind === 'chip' ? named.label : CUSTOM_COMMAND_LABEL
}
