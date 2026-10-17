// layer: L1
// L1 (17 §1.1): the domain's secret names are the kernel's `SecretName` (ADR-017 item 1), checked at
// compile time because R1 keeps the domain from importing the kernel port (secretStatus.ts).
import { describe, expectTypeOf, it } from 'vitest'
import type { SecretName } from '../../../kernel/ports/secretReader'
import type { SecretStatus, SecretStatusName } from './secretStatus'

describe('SecretStatus (06 §14.2)', () => {
  it('[ADR-017] names exactly the kernel SecretName values and carries a configured flag only', () => {
    expectTypeOf<SecretStatusName>().toEqualTypeOf<SecretName>()
    expectTypeOf<keyof SecretStatus>().toEqualTypeOf<'name' | 'configured'>()
  })
})
