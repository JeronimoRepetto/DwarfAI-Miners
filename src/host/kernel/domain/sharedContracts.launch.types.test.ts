import { describe, expectTypeOf, it } from 'vitest'
import type { JevFallbackReason, LaunchFailure, LaunchFailureCause } from './sharedContracts'

// Checked by `pnpm typecheck` (tsc includes test files); the runtime body is empty. The shapes
// below are written by hand from their owners, so a drift of the kernel copy fails to compile.

/** ADR-020 D2 list plus `'effort-ceiling'` (06 §12; ADR-028 D2). */
type OwnerJevFallbackReason =
  | 'unreachable'
  | 'timeout'
  | 'rate-limited'
  | 'invalid-response'
  | 'no-key'
  | 'unauthorized'
  | 'low-confidence'
  | 'budget-exceeded'
  | 'no-launchable-provider'
  | 'effort-ceiling'

/** ADR-020 item 1 (D1). */
interface OwnerLaunchFailure {
  cause: LaunchFailureCause
  supplierLabel: string
  jevReason?: OwnerJevFallbackReason
  reasonSentence?: string
  actions: ReadonlyArray<'retry' | 'pick-manually'>
  toolOutputTail?: string
}

describe('kernel launch contracts (ADR-020 item 1; 06 §12)', () => {
  it('[ADR-020] LaunchFailure is field for field the ADR-020 D1 shape', () => {
    expectTypeOf<LaunchFailure>().toEqualTypeOf<OwnerLaunchFailure>()
  })

  it('[ADR-020] JevFallbackReason is the ADR-020 D2 list plus effort-ceiling, and no other', () => {
    expectTypeOf<JevFallbackReason>().toEqualTypeOf<OwnerJevFallbackReason>()
  })
})
