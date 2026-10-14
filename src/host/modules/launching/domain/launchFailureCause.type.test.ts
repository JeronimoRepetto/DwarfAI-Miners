import { describe, expectTypeOf, it } from 'vitest'
import type { LaunchFailure, LaunchFailureCause } from '../../../kernel/domain/sharedContracts'

// Checked by `pnpm typecheck` (tsc includes test files); the runtime body is empty.
describe('LaunchFailureCause (ADR-020 item 1)', () => {
  it('[INV-52] a sixth cause literal fails to compile', () => {
    expectTypeOf<LaunchFailureCause>().toEqualTypeOf<
      | 'not-installed'
      | 'exited-at-once'
      | 'could-not-start'
      | 'jev-unreachable'
      | 'jev-could-not-choose'
    >()

    // @ts-expect-error `effort-ceiling` is a Jev fallback reason, never a launch cause (ADR-020 item 2)
    const sixth: LaunchFailureCause = 'effort-ceiling'
    // @ts-expect-error `handed-back` is an end state, not a cause (ADR-020 item 1)
    const endState: LaunchFailure['cause'] = 'handed-back'
    void sixth
    void endState
  })
})
