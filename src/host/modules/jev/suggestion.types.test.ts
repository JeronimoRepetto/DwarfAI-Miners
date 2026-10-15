import { describe, expectTypeOf, it } from 'vitest'
import type {
  JevFallbackReason as WireJevFallbackReason,
  JevRoutingProfile as WireJevRoutingProfile,
  JevSuggestion as WireJevSuggestion
} from '../../../contracts/wire/imported'
import type { JevFallbackReason, JevRoutingProfile, JevSuggestion } from './domain/suggestion'

// Checked by `pnpm typecheck` (tsc includes test files): the domain's 06 §12 copies and the seam-A
// wire copies (`JevSuggestionView = JevSuggestion`, 14 §3.6) are the same types, so a drift of
// either fails to compile. Kept outside `domain/`, which never imports `contracts` (R1).
describe('the jev value objects match the wire (06 §12; 14 §3.6)', () => {
  it('[INV-87] JevSuggestion is field for field the wire JevSuggestion', () => {
    expectTypeOf<JevSuggestion>().toEqualTypeOf<WireJevSuggestion>()
  })

  it('[ADR-028] JevFallbackReason, effort-ceiling included, and JevRoutingProfile match the wire', () => {
    expectTypeOf<JevFallbackReason>().toEqualTypeOf<WireJevFallbackReason>()
    expectTypeOf<JevRoutingProfile>().toEqualTypeOf<WireJevRoutingProfile>()
  })
})
