// The cut-1 cross-epic event routes (05 §4; 08 §2.2, §2.3, §2.6; 16 §8.2, §8.3; ISSUE-120): each is
// one bus subscription that turns one module's event into another module's command, through the
// target module's public API only (R4, R15). Registered by host/main.ts at boot step 4, once every
// cut-1 module is constructed and before step 7's catch-up publishes the first observed event.
//
// - `ObservedTurnEnded` (observation) → conversation `recordTurnEnd`, the end capped first by the
//   session's `turnEnd` capability (`downgrade`, ADR-021 item 2): the observing adapter's declared
//   `ObservedCapabilities`, an omitted field or an unknown provider failing closed to `'none'`
//   (ADR-009 D3). `recordTurnEnd` publishes the one `TurnEnded` per `turn:<dwarfId>:<turnKey>`.
// - `TurnEnded` (conversation) → crew `recordActivity('turn-finished', { at, reliability })`
//   (S1.03, S1.04: a reliable and an inferred end move the status alike, OQ-36 A; owner amendment
//   C), and, in a second subscription, attention `onFact` **only** when `announceable(end)`
//   (`reliability === 'reliable' && !cancelledFromApp`, ADR-021 item 3; INV-102), with the names
//   resolved at emit time beside the fact: crew's `displayName` (`customName ?? baseName`, ADR-018
//   item 9, INV-104) and the mine's name (lead decision 2026-09-30, ISSUE-109). A departed dwarf's
//   late end raises nothing: no fact could be withdrawn after its departure.
// - `SessionActivityObserved{kind:'turn-started'}` (observation) → attention `onFactEnded` for the
//   dwarf's turn-finished keys (07 S17.05: a finished-turn key ends at the next turn start).
// - `DwarfDeparted` (crew), the single departure clean-up trigger (08 §2.2) → attention
//   `onFactEnded` for that dwarf's keys and `dropCarryOver` (09 §7.1), and conversation
//   `recordSessionEnd` at the departure's instant (07 S11.05; AMENDMENT-10).
// - `TranscriptEntriesObserved` → conversation `ingest` is not a subscription: the
//   `ObservedBatchSink` bridge writes the entries inside the batch transaction
//   (bridges/observedBatchSink.ts, AMENDMENT-10; ISSUE-108).
//
// Every attention call goes through `Attention.inputs`, so the `Level3Sink` the module was built
// with (the cut-1 rollback choice, wiring/cut1Rollback.ts, ISSUE-122) is the only way out.
//
// The keys each dwarf was handed to `onFact` are held in memory for this Host life: attention's
// ports read no key by dwarf (16 §4.11), and a key of an earlier Host life is never re-emitted
// (S17.07).
//
// Not routed here, and why:
// - The ask routes (`ObservedAskOpened` / `ObservedAskClosed` → crew `startAsking` / `stopAsking`,
//   attention, conversation `noteAsk`; the cut-1 lead decision of ISSUE-120): observation publishes
//   no ask event yet (no adapter yields an ask record), and crew has no `startAsking` (later:
//   ISSUE-140 routes `ask.opened` / `ask.closed`).
// - Driver events (`DriverTurnEnded`, `DriverSessionExited` → `recordSessionEnd`): no driver session
//   reaches the Host bus in cut 1 (later: EPIC-10, ISSUE-182).
// - `dropCarryOver` on a person-initiated turn: the Host sends no message in cut 1 (later: EPIC-10).
import type { DwarfId, ProviderId } from '../../kernel/domain/values'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import { turnFinishedFact, type Attention } from '../../modules/attention'
import {
  announceable,
  downgrade,
  type ConversationCommands,
  type ConversationEvent,
  type TurnEndCapability
} from '../../modules/conversation'
import type { CrewCommands, CrewEvent, CrewQueries } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import type {
  ObservationAdapter,
  ObservationEvent,
  ObservedSessionStore
} from '../../modules/observation'

/** The Host bus as the cut-1 routes read it. */
export type Cut1RoutesBus = Pick<
  DomainEventBus<ObservationEvent | ConversationEvent | CrewEvent>,
  'subscribe'
>

export interface Cut1RoutesDeps {
  /** The Host's one event bus (16 §2.3). */
  bus: Cut1RoutesBus
  /** The observation adapters the module runs: each session's `turnEnd` capability (ADR-009 D3). */
  observed: readonly Pick<ObservationAdapter, 'providerId' | 'capabilities'>[]
  /** Observation's `ProviderIdentity → DwarfId` index (16 §4.3). */
  sessions: Pick<ObservedSessionStore, 'byIdentity'>
  conversation: Pick<ConversationCommands, 'recordTurnEnd' | 'recordSessionEnd'>
  crew: {
    commands: Pick<CrewCommands, 'recordActivity'>
    queries: Pick<CrewQueries, 'get' | 'displayName'>
  }
  mines: Pick<MinesQueries, 'get'>
  attention: Pick<Attention, 'inputs' | 'dropCarryOver'>
}

/** Subscribes the cut-1 routes on the Host bus (16 §8.2 step 4). */
export function routeCut1Events(deps: Cut1RoutesDeps): void {
  const { bus, conversation, crew, mines, attention } = deps

  /** ADR-009 D3: the observing adapter's declared capability; anything else fails closed. */
  const turnEndOf = (providerId: ProviderId): TurnEndCapability =>
    deps.observed.find((adapter) => adapter.providerId === providerId)?.capabilities().turnEnd ??
    'none'

  /** The attention keys each dwarf was handed this Host life, until they end (S17.05). */
  const keysOf = new Map<DwarfId, Set<string>>()
  const endKeys = (dwarfId: DwarfId, which: (key: string) => boolean): void => {
    const keys = keysOf.get(dwarfId)
    if (keys === undefined) return
    for (const key of [...keys].filter(which)) {
      keys.delete(key)
      attention.inputs.onFactEnded(key)
    }
    if (keys.size === 0) keysOf.delete(dwarfId)
  }

  bus.subscribe('ObservedTurnEnded', ({ payload }) =>
    conversation.recordTurnEnd(downgrade(payload.end, turnEndOf(payload.identity.providerId)))
  )

  // Amended: 05 §3.2 / 16 §4.2 recordActivity end (owner amendment C, 2026-10-06)
  bus.subscribe('TurnEnded', ({ payload: { dwarfId, end } }) =>
    crew.commands.recordActivity(dwarfId, 'turn-finished', {
      at: end.at,
      reliability: end.reliability
    })
  )

  bus.subscribe('TurnEnded', ({ payload: { dwarfId, end } }) => {
    if (!announceable(end)) return
    const dwarf = crew.queries.get(dwarfId)
    if (dwarf === null || dwarf.departed) return
    const mine = mines.get(dwarf.mineId)
    const fact = turnFinishedFact(end, dwarf.mineId)
    if (mine === null || fact === undefined) return
    attention.inputs.onFact(fact, {
      displayName: crew.queries.displayName(dwarfId),
      mineName: mine.name
    })
    keysOf.set(dwarfId, (keysOf.get(dwarfId) ?? new Set<string>()).add(fact.key))
  })

  bus.subscribe('SessionActivityObserved', ({ payload }) => {
    if (payload.kind !== 'turn-started') return
    const dwarfId = deps.sessions.byIdentity(payload.identity)?.dwarfId
    if (dwarfId !== undefined)
      endKeys(dwarfId, (key) => key.startsWith(`${dwarfId}:turn-finished:`))
  })

  bus.subscribe('DwarfDeparted', ({ at, payload: { dwarfId } }) => {
    endKeys(dwarfId, () => true)
    attention.dropCarryOver(dwarfId)
    conversation.recordSessionEnd(dwarfId, at)
  })
}
