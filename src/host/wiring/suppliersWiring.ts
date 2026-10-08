// The suppliers module's wiring (16 §8.1–§8.3; 05 §3.4, §4), run by boot step 4 (16 §8.2) over the
// adapters the composition root built (`host/main.ts`, the only file that `new`s them, R6):
//
// - `catalogIds` is `CATALOG_PROVIDER_IDS`, read here because only `host/main.ts` and `host/wiring`
//   read `contracts` (R9; ISSUE-143 gap 2);
// - the answer-channel gate is the `IntegrationGateReader` bridge to preferences
//   (bridges/integrationGateReader.ts), which boot step 3 wired (ISSUE-226);
// - driver events leave through the `SuppliedEventSink`. Their routes to conversation, asking, crew
//   and ledger are added by those consumers' wiring issues (05 §4); no session can be launched
//   before the SessionStarter bridge (later: ISSUE-162), so until then nothing reaches the sink;
// - one installed detection runs at start, unawaited (ADR-009 D5): a first `--version` can take
//   longer than the 500 ms budget (a cold Windows start), and without it every CLI would read "not
//   installed" at the first Add-panel open. Its answers only land in the detection cache; nothing
//   is pushed (AMENDMENT-10). A rejection is logged (19 §9.1 `uncaught`), never left unhandled,
//   since the Host never exits on its own (ADR-002 D1, D7). Its completion is `bootDetection`
//   (ISSUE-222): the first-run step is evaluated right after it (07 S41.09), so a check slower than
//   the budget is waited for there, and only there.
import { CATALOG_PROVIDER_IDS } from '@dwarfai/contracts'
import type { HostEpoch } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { Scheduler } from '../kernel/ports/scheduler'
import {
  createSuppliers,
  type CapabilityRecordStore,
  type InstallResolver,
  type IntegrationGateReader,
  type SuppliedEventSink,
  type Suppliers,
  type SuppliersEvent
} from '../modules/suppliers'
import { errorCode } from './boot'

export interface SuppliersWiringDeps {
  /** ADR-009 D6: the one build-time flag (`isPublicBuild`). */
  publicBuild: boolean
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  fs: Pick<FileSystem, 'stat'>
  log: DiagnosticsLog
  /** The one `CliInstallResolver` (`createHostInstallResolver`, ADR-009 D5). */
  installResolver: InstallResolver
  /** `SqliteCapabilityRecordStore` over the Host's connection (NFR-OBS-04). */
  capabilityRecords: CapabilityRecordStore
  /** The answer-channel gate: the bridge to `PreferencesQueries.integrationState` (16 §4.4). */
  integrationGate: IntegrationGateReader
  /** The Host's event bus, where `ProviderCapabilitiesRecorded` goes (08 §0). */
  bus: Pick<DomainEventBus<SuppliersEvent>, 'publish'>
  hostEpoch: HostEpoch
  /** The SimulatedDriver's seed (15 §4.12), used by development builds only. */
  simulatedSeed: string
}

/**
 * ADR-009 D6: whether this is a public build. A packaged Host is the release build (ADR-005 item
 * 6, `buildKindOf`), so it is public: it carries no simulated provider and offers no gated
 * provider on a launch surface. Development and test builds keep both (15 §4.12).
 */
export function isPublicBuild(kind: 'release' | 'dev' | 'test'): boolean {
  return kind === 'release'
}

/** No consumer routes a driver event yet (05 §4: each route arrives with its consumer's wiring). */
const unroutedSuppliedEvents: SuppliedEventSink = { deliver: () => undefined }

export interface WiredSuppliers extends Suppliers {
  /**
   * The start-up detection's completion (07 S41.09: the first-run step is evaluated right after
   * it): `detected` once every CLI check of the start-up pass has answered and its answer is in the
   * detection cache, even a check slower than the 500 ms budget; `failed` when the pass itself
   * failed (logged). Never rejects. Nothing else in the boot waits for it.
   */
  readonly bootDetection: Promise<'detected' | 'failed'>
}

/**
 * The resolver the suppliers module is given, with the resolves still running counted: the
 * start-up pass's budget can run out before a check answers (that check goes on in the background,
 * detection.ts), so the boot detection waits for them.
 */
function trackResolves(resolver: InstallResolver): {
  resolver: InstallResolver
  settled(): Promise<void>
} {
  const running = new Set<Promise<unknown>>()
  return {
    resolver: {
      resolve: (binaries) => {
        const answer = resolver.resolve(binaries)
        running.add(answer)
        const done = (): void => void running.delete(answer)
        answer.then(done, done)
        return answer
      }
    },
    async settled() {
      while (running.size > 0) await Promise.allSettled([...running])
    }
  }
}

export function wireSuppliers(deps: SuppliersWiringDeps): WiredSuppliers {
  const resolves = trackResolves(deps.installResolver)
  const suppliers = createSuppliers({
    catalogIds: CATALOG_PROVIDER_IDS,
    publicBuild: deps.publicBuild,
    clock: deps.clock,
    scheduler: deps.scheduler,
    simulatedSeed: deps.simulatedSeed,
    sink: unroutedSuppliedEvents,
    installResolver: resolves.resolver,
    fs: deps.fs,
    capabilityRecords: deps.capabilityRecords,
    integrationGate: deps.integrationGate,
    bus: deps.bus,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  // The start-up pass, then every check it left running, then one more pass over the filled cache
  // (a check that answered late is read from the cache; an installed one is not resolved again).
  const bootDetection = suppliers.catalogue
    .launchable()
    .then(() => resolves.settled())
    .then(() => suppliers.catalogue.launchable())
    .then(
      () => 'detected' as const,
      (error: unknown) => {
        deps.log.record({
          level: 'error',
          event: 'uncaught',
          subsystem: 'suppliers',
          errCode: errorCode(error)
        })
        return 'failed' as const
      }
    )
  return { ...suppliers, bootDetection }
}
