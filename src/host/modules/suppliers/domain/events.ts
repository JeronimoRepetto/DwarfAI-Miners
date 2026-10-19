// The suppliers module's domain events (08 §0), over the kernel envelope (08 §1.2).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { ProviderId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from './capabilities'

/** A probe measured a provider's behaviour at a version (08 §0; NFR-OBS-04); state, keyed `(providerId, providerVersion)`. */
export type ProviderCapabilitiesRecorded = DomainEvent<
  'ProviderCapabilitiesRecorded',
  { providerId: ProviderId; providerVersion: string; capabilities: ProviderCapabilities }
>

export type SuppliersEvent = ProviderCapabilitiesRecorded
