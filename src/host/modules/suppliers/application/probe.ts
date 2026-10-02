// Runtime capability probing (15 §1.3 row `probe(install)`, §2.3; ADR-009 D3–D5; AQ-30): for each
// driver of a provider, in the profile's preference order, `detect()` and, only when it answers
// `installed` (never `quarantined`), `probe(install)` — on the first detection and again whenever
// the install's `version` or `statMtimeMs` changes (FM-134). A probe runs only the CLI's own
// `--version` / `--help` (the driver's obligation, ADR-009 D4): this use case never launches,
// resumes or adopts a session and reads no file.
//
// A probe that has not answered within PROBE_TIMEOUT_MS, or that breaks its "never throws" rule,
// yields the fail-closed value of every field: the use case cannot know which fields a driver
// probes, and failing all of them closed is never above the fail-closed value of a probed one.
//
// Selection (ADR-009 D4): the first driver whose probe reports `launch: true`, else the first
// probed driver. After every probe round that measured something, the selected driver's
// measurement is recorded with the provider version and the date (NFR-OBS-04) and
// `ProviderCapabilitiesRecorded` is published. The record port is keyed by provider and version
// (16 §4.4, 09 `capability_records`): one record per round, the selected driver's, so a vanished
// flag shows as the next driver's values in the new record.
//
// No provider id is read (R12). Every timeout is a task on the injected Scheduler (16 §2.6).
import type { EventId, HostEpoch, ProviderId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type { SuppliersEvent } from '../domain/events'
import type { CapabilityRecordStore } from '../ports/capabilityRecordStore'
import type { DriverRegistry } from '../ports/driverRegistry'
import type { InstalledProvider, ProviderDriver } from '../ports/providerDriver'

/** 15 §0: the bound on a CLI's own `--version` / `--help` probe. */
export const PROBE_TIMEOUT_MS = 5_000

/** The provider version recorded when the CLI did not answer `--version` (`InstalledProvider.version` null). */
export const UNKNOWN_PROVIDER_VERSION = 'unknown'

export interface CapabilityProbingDeps {
  readonly registry: DriverRegistry
  readonly store: CapabilityRecordStore
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly bus: Pick<DomainEventBus<SuppliersEvent>, 'publish'>
  readonly ids: IdGenerator
  readonly hostEpoch: HostEpoch
}

export interface CapabilityProbing {
  /** Detects every driver of the provider and probes the installed ones that are new or changed. */
  refresh(id: ProviderId): Promise<void>
  /** The selected driver's last measurement, or null when no driver of the provider is probed. */
  selected(id: ProviderId): ProviderCapabilities | null
}

interface Measured {
  readonly key: string
  readonly install: InstalledProvider
  readonly caps: ProviderCapabilities
}

export function createCapabilityProbing(deps: CapabilityProbingDeps): CapabilityProbing {
  const measured = new Map<ProviderDriver, Measured>()
  const running = new Map<ProviderId, Promise<void>>()

  /** The driver's probe within PROBE_TIMEOUT_MS; never rejects. */
  async function probeWithin(driver: ProviderDriver, install: InstalledProvider) {
    let timer: { cancel(): void } | undefined
    const late = new Promise<null>((resolve) => {
      timer = deps.scheduler.after(PROBE_TIMEOUT_MS, () => resolve(null))
    })
    try {
      const caps = await Promise.race([driver.probe(structuredClone(install)), late])
      return caps === null ? FAIL_CLOSED_CAPABILITIES : caps
    } catch {
      return FAIL_CLOSED_CAPABILITIES
    } finally {
      timer?.cancel()
    }
  }

  async function detected(driver: ProviderDriver): Promise<InstalledProvider | null> {
    try {
      const answer = await driver.detect()
      return answer.kind === 'installed' ? answer.install : null
    } catch {
      return null // detect() never throws (15 §1.3); a broken one is "not installed"
    }
  }

  function selectedOf(id: ProviderId): Measured | null {
    const probed = deps.registry.drivers(id).flatMap((driver) => {
      const m = measured.get(driver)
      return m === undefined ? [] : [m]
    })
    return probed.find((m) => m.caps.launch) ?? probed[0] ?? null
  }

  async function round(id: ProviderId): Promise<void> {
    let probedNow = false
    for (const driver of deps.registry.drivers(id)) {
      const install = await detected(driver)
      if (install === null) {
        measured.delete(driver)
        continue
      }
      const key = JSON.stringify([install.binaryPath, install.version, install.statMtimeMs])
      if (measured.get(driver)?.key === key) continue
      const caps = structuredClone(await probeWithin(driver, install))
      measured.set(driver, { key, install, caps })
      probedNow = true
    }
    const chosen = probedNow ? selectedOf(id) : null
    if (chosen !== null) record(id, chosen)
  }

  function record(id: ProviderId, chosen: Measured): void {
    const providerVersion = chosen.install.version ?? UNKNOWN_PROVIDER_VERSION
    const at = deps.clock.now()
    deps.store.record(id, providerVersion, chosen.caps, at)
    deps.bus.publish({
      type: 'ProviderCapabilitiesRecorded',
      v: 1,
      id: deps.ids.uuidv7() as EventId,
      at,
      hostEpoch: deps.hostEpoch,
      payload: { providerId: id, providerVersion, capabilities: structuredClone(chosen.caps) }
    })
  }

  return {
    refresh(id) {
      const inFlight = running.get(id)
      if (inFlight !== undefined) return inFlight
      const started = round(id).finally(() => running.delete(id))
      running.set(id, started)
      return started
    },
    selected(id) {
      const chosen = selectedOf(id)
      return chosen === null ? null : structuredClone(chosen.caps)
    }
  }
}
