// The suppliers driven port `CapabilityRecordStore` (05 §3.4, 16 §4.4; frozen): measured provider
// behaviour with the provider version and the date (NFR-OBS-04, AQ-30). One record per
// `(providerId, providerVersion)`: recording the same version again replaces it; `latest` is the
// newest measured record; the newest 10 versions per provider are kept (09 §7.1). Adapters:
// `SqliteCapabilityRecordStore` (ISSUE-148) and the `InMemoryCapabilityRecordStore` double, both
// held to `runCapabilityRecordStoreContract`. Type-only (R2).
import type { Instant, ProviderId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from '../domain/capabilities'

export interface CapabilityRecordStore {
  // measured behavior with provider version + date (NFR-OBS-04)
  record(id: ProviderId, version: string, caps: ProviderCapabilities, at: Instant): void
  latest(id: ProviderId): { version: string; caps: ProviderCapabilities; at: Instant } | null
}
