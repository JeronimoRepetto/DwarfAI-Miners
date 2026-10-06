// The attention module's wiring (05 §3.11, §4; 16 §4.11, §8.2, §8.3), in two parts, as
// preferencesWiring.ts and routes/mines.ts:
//
// - `serveAttention`, run by the composition root before the boot binds the endpoint: B-M07
//   `presence` (`ui` only) and B-M08 `attention.clicked` (`notifier` only) on the Host dispatcher
//   (transport/methods/presence.ts, attentionClicked.ts; roles.ts), so every `hello.ok` lists them
//   beside the attention frames `ATTENTION_FRAMES` (14 §1.3; ADR-003 item 12). They forward to the
//   one instance boot step 4 constructs; until then the dispatcher answers HOST_NOT_READY before
//   any handler runs (14 §3.3). A `ui` connection that leaves the registry is handed on as
//   `presenceChanged(client, 'detached')` (05 §4 row "Presence (transport) → attention
//   `presenceChanged`"); before step 4 there is no presence to forget, so nothing is forwarded.
// - `wire`, run by boot step 4, after step 1 bound the endpoint (the transport is listening), over
//   the adapters the composition root built (`host/main.ts`, the only file that `new`s them, R6):
//   `SqliteAttentionLedger`, `TransportLevel3Sink` and `AppBackgroundNotifierLauncher`. It
//   constructs `createAttention` over the `AttentionSettings` bridge to preferences
//   (bridges/attentionSettings.ts) and the PO #44 titles of the copy dictionary (`level3Titles`;
//   module code never imports contracts, R9), and the tray notifier supervisor (machine 12C),
//   fed with every client the connection registry attaches or detaches: those attached before
//   step 4 first, then each later one. Its `drawPending` is `Attention.notifierAttached`: a
//   `notifier` attaching receives every standing notification again (14 §2.3; S12.C03). That is
//   the one draw path: `registerNotifierAttached` (TransportLevel3Sink.ts) is not composed, or an
//   attaching notifier would be sent each standing notification twice.
//
// The 05 §4 route of this wiring:
// - `HostPreferencesChanged` (preferences) → `AttentionInputs.preferencesChanged`: the gated facts
//   are re-checked against the bridge, so turning `systemNotificationsOn` on opens their gate
//   (07 S17.03; the input of the amended 16 §4.11 `AttentionInputs`, ISSUE-109). Package gap: 05 §4
//   lists no row for it; the amended input has no other feeder, so the wiring composes it here.
//
// The Reset saga's attention step is registered by preferencesWiring.ts (resetParticipants.ts,
// ISSUE-118, ISSUE-226), in the saga's one `db` transaction.
//
// Not routed here (ISSUE-120): `ask.opened` / `ask.closed`, `TurnEnded` (`onFact` only when
// `reliability === 'reliable' && !cancelledFromApp`) and `DwarfDeparted` → attention, with the names
// resolved at emit time; the carry-over drop of a person-initiated turn. The 24-hour sweep of
// withdrawn keys (09 §7.1, `Attention.sweep`) is not scheduled yet.
import { t, type HostFrameName } from '@dwarfai/contracts'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import {
  createAttention,
  createNotifierSupervisor,
  type Attention,
  type AttentionEvent,
  type AttentionInputs,
  type AttentionLedger,
  type Level3Sink,
  type Level3TitleFormatter,
  type NotifierLauncher,
  type NotifierPresenceInputs
} from '../../modules/attention'
import type { PreferencesEvent, PreferencesQueries } from '../../modules/preferences'
import type { ConnectionRegistry } from '../../transport/connectionRegistry'
import type { Dispatcher } from '../../transport/dispatcher'
import { registerAttentionClicked } from '../../transport/methods/attentionClicked'
import { registerPresence } from '../../transport/methods/presence'
import { preferencesAttentionSettings } from '../bridges/attentionSettings'

/** The frames the attention wiring publishes, to the `notifier` connection only (14 B-F22, B-F23). */
export const ATTENTION_FRAMES: readonly HostFrameName[] = Object.freeze([
  'attention.notify',
  'attention.withdraw'
])

/** The events the attention wiring routes or projects: one Host bus carries them all (16 §2.3). */
export type AttentionRouteEvent = AttentionEvent | PreferencesEvent

/** The Host bus as the attention wiring uses it: attention publishes; preferences is read. */
export type AttentionWiringBus = DomainEventBus<AttentionEvent> &
  Pick<DomainEventBus<PreferencesEvent>, 'subscribe'>

/** The level-3 titles: the kind's PO #44 copy with the dwarf's display name (ADR-018 item 9). */
export const level3Titles: Level3TitleFormatter = (kind, displayName) => {
  switch (kind) {
    case 'question':
      return t('attention.level3Title.question', { dwarf: displayName })
    case 'permission':
      return t('attention.level3Title.permission', { dwarf: displayName })
    case 'turn-finished':
      return t('attention.level3Title.turnFinished', { dwarf: displayName })
  }
}

/**
 * `AppBackgroundNotifierLauncherDeps.onNotifierAttach` over the connection registry: `listener`
 * runs on each `notifier` attach from now on; returns the unsubscribe.
 */
export function onNotifierAttach(
  connections: Pick<ConnectionRegistry, 'onAttach'>
): (listener: () => void) => () => void {
  return (listener) =>
    connections.onAttach((connection) => {
      if (connection.role === 'notifier') listener()
    })
}

export interface AttentionServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M07 and B-M08 join. */
  dispatcher: Dispatcher
  /** The connection registry: its detaches reach the presence union and the supervisor. */
  connections: ConnectionRegistry
}

export interface AttentionWiringDeps {
  /** `SqliteAttentionLedger` over the Host database. */
  ledger: AttentionLedger
  /** `TransportLevel3Sink` over the connection registry. */
  sink: Level3Sink
  /** `AppBackgroundNotifierLauncher`: the app's own executable, `--background`. */
  launcher: NotifierLauncher
  /** What the `AttentionSettings` bridge reads (the preferences module, wired by step 3). */
  preferences: Pick<PreferencesQueries, 'get'>
  /** The Host's transaction runner (16 §2.2). */
  transactions: TransactionRunner
  /** The Host's one event bus (16 §2.3). */
  bus: AttentionWiringBus
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

export interface WiredAttention {
  /** The one instance: ISSUE-120 routes the other modules' events into its `inputs`. */
  attention: Attention
  /** Machine 12C, fed by the connection registry. */
  notifier: NotifierPresenceInputs
}

export interface ServedAttention {
  /** Boot step 4: constructs and wires the module the served members forward to. */
  wire(deps: AttentionWiringDeps): WiredAttention
}

/** Serves B-M07 and B-M08 before the module exists; `wire` constructs it at boot step 4. */
export function serveAttention(serve: AttentionServeDeps): ServedAttention {
  const { dispatcher, connections } = serve
  let wired: Attention | undefined
  const current = (): Attention => {
    if (wired === undefined) throw new HostInvariantError('attention is served from boot step 4 on')
    return wired
  }
  const served: Pick<AttentionInputs, 'presenceChanged' | 'clicked'> = {
    presenceChanged: (client, presence) => {
      // A `ui` detach before step 4: no report was ever taken, so there is nothing to forget.
      if (wired === undefined && presence === 'detached') return
      current().inputs.presenceChanged(client, presence)
    },
    clicked: (key) => current().inputs.clicked(key)
  }
  registerPresence(dispatcher, { attention: served, connections })
  registerAttentionClicked(dispatcher, { attention: served })
  return {
    wire: (deps) => {
      if (wired !== undefined) throw new HostInvariantError('attention is wired once')
      const attention = createAttention({
        settings: preferencesAttentionSettings(deps.preferences),
        ledger: deps.ledger,
        transactions: deps.transactions,
        bus: deps.bus,
        sink: deps.sink,
        clock: deps.clock,
        ids: deps.ids,
        hostEpoch: deps.hostEpoch,
        titles: level3Titles
      })
      wired = attention
      deps.bus.subscribe('HostPreferencesChanged', () => attention.inputs.preferencesChanged())

      const notifier = createNotifierSupervisor({
        launcher: deps.launcher,
        scheduler: deps.scheduler,
        clock: deps.clock,
        log: deps.log,
        drawPending: () => attention.notifierAttached()
      })
      // Those attached before step 4 first; the registry's listeners take every later change.
      for (const connection of connections.connections()) notifier.clientAttached(connection)
      connections.onAttach((connection) => notifier.clientAttached(connection))
      connections.onDetach((connection) => notifier.clientDetached(connection))
      return { attention, notifier }
    }
  }
}
