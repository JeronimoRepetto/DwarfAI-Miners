// The suppliers driving port `SupplierCatalogueQueries` (05 §3.4, 16 §4.4) over the catalog
// records. Every answer is derived again on each call from the record, the last detection, the
// last probe and the integration gate's current state (no cache, 05 §4):
//
// - effective capabilities = ADR-009 D2 merge of the ceiling with the probe of the selected
//   driver, lowered by the answer-channel gate (15 §2.1 `negotiatedFor`; ADR-011 item 7). A
//   provider whose CLI is not installed, or that no driver could probe, has no evidence and stays
//   at its fail-closed values (INV-44);
// - `entry(id)`: the supplier's own models, efforts and the permission modes it can honour
//   (`offeredModes`, ADR-011 item 1; INV-42), with its `answerChannel` (06 §0.2);
// - `launchable()`: the installed entries whose effective `launch` is true, a gated provider absent
//   in a public build (INV-41; ADR-009 D4–D6). It re-checks installation and probes the installed
//   CLIs that are new or changed; a probe slower than the detection budget leaves the provider out
//   of this answer and lands for the next one (ADR-009 D5, AMENDMENT-10: nothing is pushed).
//
// The record's own data only: no provider id is special (INV-40, R12).
import type { IntegrationId, IntegrationState, ProviderId } from '../../../kernel/domain/values'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import { merge, negotiatedFor } from '../domain/mergeCapabilities'
import { answerChannelOf, offeredModes } from '../domain/offeredModes'
import type { CatalogRecord } from '../domain/profile'
import type { IntegrationGateReader } from '../ports/integrationGateReader'
import { DETECTION_BUDGET_MS, type InstallDetection } from './detection'
import type { CapabilityProbing } from './probe'

/** 06 §0.2 `SupplierEntry` (entity, identity `providerId`). */
export interface SupplierEntry {
  providerId: ProviderId
  label: string
  models: string[]
  efforts: string[]
  permissionModes: string[]
  installed: boolean
  publicLaunch: 'enabled' | 'gated'
  answerChannel: 'available' | 'gated-off' | 'none'
  gatingIntegration?: IntegrationId
}

// 05 §3.4 driving ports.
export interface SupplierCatalogueQueries {
  launchable(): Promise<SupplierEntry[]> // installed, launch-enabled (Antigravity launch gated, OQ-15)
  entry(id: ProviderId): SupplierEntry | null // models, efforts, permission modes it can honor (OQ-05)
  capabilities(id: ProviderId): ProviderCapabilities
}

export interface SupplierCatalogueDeps {
  /** The records of this build (`recordsForBuild`); "Other…" is never one of them (INV-43). */
  readonly records: readonly CatalogRecord[]
  /** The build-time flag of ADR-009 D6: a public build offers no `publicLaunch: 'gated'` entry. */
  readonly publicBuild: boolean
  /** The one installed detection behind every `detect()` (ADR-009 D5). */
  readonly detection: InstallDetection
  /** Each driver's `probe()` on first detection and on a version or mtime change (15 §1.3). */
  readonly probing: CapabilityProbing
  /** The answer-channel gate: `preferences.integrationState` through a bridge (ADR-011 item 7). */
  readonly gate: IntegrationGateReader
  /** Bounds the probe round of one `launchable()` by the detection budget. */
  readonly scheduler: Scheduler
}

export function createSupplierCatalogue(deps: SupplierCatalogueDeps): SupplierCatalogueQueries {
  const byId = new Map<ProviderId, CatalogRecord>()
  for (const record of deps.records) byId.set(record.profile.id, record)

  /** `installDetection: 'none'` (the simulated provider) resolves no CLI: present by itself. */
  const isInstalled = async (record: CatalogRecord): Promise<boolean> =>
    record.ceiling.installDetection === 'none' ||
    (record.profile.binaries.length > 0 &&
      (
        await deps.detection.detect({
          providerId: record.profile.id,
          binaries: record.profile.binaries
        })
      ).kind === 'installed')

  /** What the last detection said, without checking again (`entry` is synchronous). */
  const installedNow = (record: CatalogRecord): boolean =>
    record.ceiling.installDetection === 'none' ||
    deps.detection.last({ providerId: record.profile.id, binaries: record.profile.binaries })
      ?.kind === 'installed'

  /** The gating integration's state now, or null when the entry is not gated. */
  const gateOf = (record: CatalogRecord): IntegrationState | null => {
    const gate = record.profile.answerChannelGate
    return gate === undefined ? null : deps.gate.state(gate)
  }

  /** 15 §2.1: `merge(ceiling, negotiatedFor(...))`; no evidence without an installed, probed CLI. */
  const effective = (record: CatalogRecord): ProviderCapabilities => {
    const probed = installedNow(record) ? deps.probing.selected(record.profile.id) : null
    return merge(record.ceiling, negotiatedFor(probed === null ? [] : [probed], gateOf(record)))
  }

  const toEntry = (record: CatalogRecord): SupplierEntry => {
    const { profile } = record
    const caps = effective(record)
    const gate = gateOf(record)
    const modes = record.modes ?? { specs: [], denyPolicyVerified: false }
    return {
      providerId: profile.id,
      label: profile.label,
      models: profile.models.map((model) => model.id),
      efforts: [...profile.efforts],
      permissionModes: offeredModes(profile, caps, modes).map((mode) => mode.id),
      installed: installedNow(record),
      publicLaunch: profile.publicLaunch,
      answerChannel: answerChannelOf(caps, gate),
      ...(profile.answerChannelGate !== undefined
        ? { gatingIntegration: profile.answerChannelGate }
        : {})
    }
  }

  /** Probes the installed records within the detection budget; a slower probe lands later. */
  const probeWithinBudget = async (records: readonly CatalogRecord[]): Promise<void> => {
    let timer: { cancel(): void } | undefined
    const budget = new Promise<void>((resolve) => {
      timer = deps.scheduler.after(DETECTION_BUDGET_MS, resolve)
    })
    const round = Promise.all(
      records.map((record) => deps.probing.refresh(record.profile.id).catch(() => undefined))
    ).then(() => undefined)
    await Promise.race([round, budget])
    timer?.cancel()
  }

  return {
    // Re-checked on every call, that is on every Add-panel open (ADR-009 D5). A gated provider in a
    // public build, a provider whose CLI does not resolve and a provider no driver can launch are
    // simply absent: no disabled entry, no reason (US-RES-005.AC01-AC02). "Other…" is never a
    // record, so never an entry (INV-43).
    async launchable() {
      const offered = deps.records.filter(
        (record) => !(deps.publicBuild && record.profile.publicLaunch === 'gated')
      )
      const installed = await Promise.all(offered.map((record) => isInstalled(record)))
      const present = offered.filter((_, at) => installed[at] === true)
      await probeWithinBudget(present)
      return present.filter((record) => effective(record).launch).map(toEntry)
    },
    entry(id) {
      const record = byId.get(id)
      return record === undefined ? null : toEntry(record)
    },
    capabilities(id) {
      const record = byId.get(id)
      return record === undefined ? structuredClone(FAIL_CLOSED_CAPABILITIES) : effective(record)
    }
  }
}
