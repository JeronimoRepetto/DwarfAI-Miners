// layer: L6
// Type-level (17 §1.6; 14 §3.6, frozen): the outcome line the Host core holds (conversation's
// domain copy of 06 §9.2, R9: the core never imports `contracts`) and the one `DwarfWire.outcome`
// carries are the same type, so `toOutcomeLineWire` copies a field only where both sides have it
// and a field either side grows fails `pnpm typecheck` here.
import { describe, expectTypeOf, it } from 'vitest'
import type {
  DwarfWire,
  OutcomeLine as OutcomeLineWire,
  OutcomeLinePart as OutcomeLinePartWire
} from '@dwarfai/contracts'
import type { OutcomeLine, OutcomeLinePart } from '../../modules/conversation'

describe('the outcome line across seam B (ISSUE-108)', () => {
  it('[INV-67] the domain OutcomeLine and the wire OutcomeLine of DwarfWire.outcome are equal types', () => {
    expectTypeOf<OutcomeLine>().toEqualTypeOf<OutcomeLineWire>()
    expectTypeOf<OutcomeLinePart>().toEqualTypeOf<OutcomeLinePartWire>()
    expectTypeOf<NonNullable<DwarfWire['outcome']>>().toEqualTypeOf<OutcomeLineWire>()
  })
})
