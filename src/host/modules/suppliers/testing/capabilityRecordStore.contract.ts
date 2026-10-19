// `runCapabilityRecordStoreContract` (16 §2.8, §4.4): what every `CapabilityRecordStore` — the
// `InMemoryCapabilityRecordStore` double now and `SqliteCapabilityRecordStore` (ISSUE-148) — must
// do: `latest` answers the newest measured record, recording a version again replaces its record
// (one per `(providerId, providerVersion)`), and only the newest 10 versions per provider are kept
// (09 §7.1). The port cannot list what it holds, so each adapter hands the suite a read of the
// versions it keeps (a table query for SQLite).
import { describe, expect, it } from 'vitest'
import type { Instant, ProviderId } from '../../../kernel/domain/values'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type { CapabilityRecordStore } from '../ports/capabilityRecordStore'

/** 09 §7.1: the newest versions kept per provider. */
const CAPABILITY_RECORDS_KEPT = 10

export interface CapabilityRecordStoreUnderTest {
  readonly store: CapabilityRecordStore
  /** The versions the adapter holds for one provider, in any order. */
  heldVersions(id: ProviderId): string[]
}

export type MakeCapabilityRecordStore = () => CapabilityRecordStoreUnderTest

const caps = (fidelity: 0 | 1 | 2): ProviderCapabilities => ({
  ...FAIL_CLOSED_CAPABILITIES,
  launch: true,
  usage: { fidelity, rateLimits: false }
})

export function runCapabilityRecordStoreContract(
  name: string,
  make: MakeCapabilityRecordStore
): void {
  describe(`CapabilityRecordStore contract: ${name}`, () => {
    it('[NFR-OBS-04] latest returns the newest measured version and the store keeps the newest 10 versions', () => {
      const { store, heldVersions } = make()
      expect(store.latest('alpha')).toBeNull()

      // Twelve versions measured in this order; the measurement date decides "newest", not the
      // version string (1.10.0 sorts before 1.9.0 as text).
      const measured: [string, Instant][] = []
      for (let minor = 0; minor < CAPABILITY_RECORDS_KEPT + 2; minor += 1) {
        measured.push([`1.${minor}.0`, 1_000 + minor * 10])
      }
      for (const [version, at] of measured) store.record('alpha', version, caps(1), at)
      store.record('bravo', '9.9.9', caps(2), 5)

      expect(store.latest('alpha')).toEqual({ version: '1.11.0', caps: caps(1), at: 1_110 })
      expect(heldVersions('alpha').sort()).toEqual(
        measured
          .slice(-CAPABILITY_RECORDS_KEPT)
          .map(([version]) => version)
          .sort()
      )
      // Retention is per provider: another provider's records are untouched.
      expect(store.latest('bravo')).toEqual({ version: '9.9.9', caps: caps(2), at: 5 })
      expect(heldVersions('bravo')).toEqual(['9.9.9'])
    })

    it('[NFR-OBS-04] recording a version again replaces its record with the new measurement', () => {
      const { store, heldVersions } = make()
      store.record('alpha', '2.0.0', caps(0), 100)
      store.record('alpha', '2.1.0', caps(1), 200)

      store.record('alpha', '2.0.0', caps(2), 300) // the same version, measured again later

      expect(heldVersions('alpha').sort()).toEqual(['2.0.0', '2.1.0'])
      expect(store.latest('alpha')).toEqual({ version: '2.0.0', caps: caps(2), at: 300 })
    })

    it('[NFR-OBS-04] a stored record is a copy: changing the caller object later changes nothing', () => {
      const { store } = make()
      const measured = caps(1)
      store.record('alpha', '3.0.0', measured, 10)
      measured.launch = false

      const latest = store.latest('alpha')
      expect(latest?.caps.launch).toBe(true)
      if (latest !== null) latest.caps.launch = false
      expect(store.latest('alpha')?.caps.launch).toBe(true)
    })
  })
}
