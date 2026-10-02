// The `CapabilityRecordStore` double (16 §4.4): the `capability_records` rows of one provider in
// memory, one per `(providerId, providerVersion)`; recording a version again replaces it; `latest`
// is the newest by measurement date (the `capability_records_latest` index, 09 §4.3); only the
// newest 10 versions per provider stay (09 §7.1). Records are copies both ways. Passes
// runCapabilityRecordStoreContract.
import type { Instant, ProviderId } from '../../../../kernel/domain/values'
import type { ProviderCapabilities } from '../../domain/capabilities'
import type { CapabilityRecordStore } from '../capabilityRecordStore'

/** 09 §7.1: the newest versions kept per provider. */
const CAPABILITY_RECORDS_KEPT = 10

interface StoredRecord {
  version: string
  caps: ProviderCapabilities
  at: Instant
}

export class InMemoryCapabilityRecordStore implements CapabilityRecordStore {
  /** Per provider, newest measurement first. */
  private readonly byProvider = new Map<ProviderId, StoredRecord[]>()

  record(id: ProviderId, version: string, caps: ProviderCapabilities, at: Instant): void {
    const rows = (this.byProvider.get(id) ?? []).filter((row) => row.version !== version)
    rows.push({ version, caps: structuredClone(caps), at })
    // Newest first; on an equal date the later record is the newer one (stable sort).
    rows.reverse().sort((a, b) => b.at - a.at)
    this.byProvider.set(id, rows.slice(0, CAPABILITY_RECORDS_KEPT))
  }

  latest(id: ProviderId): StoredRecord | null {
    const newest = this.byProvider.get(id)?.[0]
    return newest === undefined ? null : structuredClone(newest)
  }

  /** Every version held for a provider (diagnostics and the contract's retention check). */
  versions(id: ProviderId): string[] {
    return (this.byProvider.get(id) ?? []).map((row) => row.version)
  }
}
