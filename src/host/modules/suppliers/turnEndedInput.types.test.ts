import { describe, expectTypeOf, it } from 'vitest'
import type { TurnEnded } from '../../kernel/domain/sharedContracts'
import type { DriverEvent, TurnEndedInput } from './ports/providerDriver'

// Checked by `pnpm typecheck` (tsc includes test files); the runtime body is empty.
describe('driver-side turn.ended payload (ADR-009 D3, amended 2026-10-02)', () => {
  it('[ADR-009] a driver turn.ended payload has no dwarfId', () => {
    type Payload = Extract<DriverEvent, { t: 'turn.ended' }>['end']

    expectTypeOf<Payload>().toEqualTypeOf<Omit<TurnEnded, 'dwarfId'>>()
    expectTypeOf<TurnEndedInput>().toEqualTypeOf<Omit<TurnEnded, 'dwarfId'>>()
    expectTypeOf<'dwarfId' extends keyof Payload ? true : false>().toEqualTypeOf<false>()
  })
})
