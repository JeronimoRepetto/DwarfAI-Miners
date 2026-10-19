// The suppliers driven port `DriverRegistry` (05 §3.4, 16 §4.4). Type-only (R2).
import type { ProviderId } from '../../../kernel/domain/values'
import type { ProviderDriver } from './providerDriver'

export interface DriverRegistry {
  // one ProviderDriver (ADR-009 D3) per catalog entry and transport
  drivers(id: ProviderId): readonly ProviderDriver[] // preference order (ADR-009 D4)
}
