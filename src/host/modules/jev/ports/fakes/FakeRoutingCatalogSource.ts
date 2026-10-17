// The `RoutingCatalogSource` double (16 §4.9 "FakeRoutingCatalogSource"): the launchable suppliers a
// test sets, answered in the order given and read fresh on every call, the way the real bridge reads
// `suppliers.launchable()` (16 §4.9 "bridge → suppliers"; ISSUE-196 builds it). It counts its reads,
// so a test can prove the advisor asks per suggestion. Test-only: production code never imports it
// (R14).
import type { SupplierEntry } from '../../../suppliers'
import type { RoutingCatalogSource } from '../jevRouter'

export class FakeRoutingCatalogSource implements RoutingCatalogSource {
  private entries: SupplierEntry[]
  /** How many times `launchable()` was read. */
  reads = 0

  constructor(entries: readonly SupplierEntry[] = []) {
    this.entries = entries.map((entry) => ({ ...entry }))
  }

  /** Replaces what the next `launchable()` answers. */
  setLaunchable(entries: readonly SupplierEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }))
  }

  launchable(): Promise<SupplierEntry[]> {
    this.reads += 1
    return Promise.resolve(this.entries.map((entry) => ({ ...entry })))
  }
}
