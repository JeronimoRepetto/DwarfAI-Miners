// The Host's seam-B Dispatcher as main.ts composes it (05 §2.3, 14 §2.3): built once, with the
// transport's own methods registered — `ping` (B-M02), `events.subscribe` (B-M03),
// `session.snapshot` (B-M04), `host.shutdown` (B-M05) and `host.upgrade.request` (B-M06). The
// snapshot serves the sections of the SectionRegistry main.ts owns; the Host's own `meta` section
// is registered here, over the SnapshotMetaSource main.ts binds, and each module section joins
// that registry with its module. Each module method joins it here, in the wiring, with the issue
// that serves it, so that a composition test proves what production serves.
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { StopAllPort } from '../kernel/ports/stopAll'
import type { ConnectionRegistry } from '../transport/connectionRegistry'
import { Dispatcher, type DispatcherDeps } from '../transport/dispatcher'
import type { CleanExit } from '../transport/lifecycle/cleanExit'
import type { UpgradeDrain } from '../transport/lifecycle/drain'
import { registerEventsSubscribe } from '../transport/methods/eventsSubscribe'
import { registerHostShutdown } from '../transport/methods/hostShutdown'
import {
  registerHostUpgradeRequest,
  type UpgradeTargetRule
} from '../transport/methods/hostUpgradeRequest'
import { registerPing } from '../transport/methods/ping'
import { registerSessionSnapshot } from '../transport/methods/sessionSnapshot'
import { metaSection, type SnapshotMetaSource } from '../transport/snapshot/metaSection'
import type { SectionRegistry } from '../transport/snapshot/sectionRegistry'
import { SnapshotService } from '../transport/snapshot/snapshotService'

export interface HostDispatcherDeps extends DispatcherDeps {
  /** What `host.shutdown {stop-all}` asks to end every owned session (empty-owner until ISSUE-175). */
  stopAll: StopAllPort
  /** The Host's clean exit (composeHostLifecycle). */
  lifecycle: CleanExit
  /** Where `events.subscribe` finds the calling connection's frame delivery. */
  connections: ConnectionRegistry
  /** This boot's epoch (mintBootEpoch). */
  epoch: string
  /** The upgrade drain both `host.upgrade.request` and `host.shutdown {upgrade-drain}` start. */
  drain: UpgradeDrain
  /** The 14 §1.10 `targetDir` rule, bound to this Host's versioned-copy root. */
  upgradeTarget: UpgradeTargetRule
  /** Mints each snapshot's id. */
  ids: IdGenerator
  /** The snapshot sections the Host serves; the module sections join it from main.ts. */
  sections: SectionRegistry
  /** Where the `meta` section reads its values (main.ts binds the boot-state source). */
  snapshotMeta: SnapshotMetaSource
}

/** The production Dispatcher, with every method the Host serves registered. */
export function createHostDispatcher(deps: HostDispatcherDeps): Dispatcher {
  const dispatcher = new Dispatcher(deps)
  registerPing(dispatcher, deps.clock)
  registerEventsSubscribe(dispatcher, deps)
  deps.sections.registerSection('meta', ['ui'], metaSection(deps.snapshotMeta))
  registerSessionSnapshot(dispatcher, {
    sections: deps.sections,
    service: new SnapshotService({
      sections: deps.sections,
      ids: deps.ids,
      scheduler: deps.scheduler,
      epoch: deps.epoch,
      currentSeq: (clientId) => deps.connections.currentSeq(clientId)
    })
  })
  registerHostShutdown(dispatcher, deps)
  registerHostUpgradeRequest(dispatcher, { drain: deps.drain, target: deps.upgradeTarget })
  return dispatcher
}
