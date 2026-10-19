// ADR-026 Verification, 17 §1.7 "Misc static": console.* outside the logger must fail the lint.
export function report(cause: unknown): void {
  console.warn('[canary] something failed:', cause)
}
