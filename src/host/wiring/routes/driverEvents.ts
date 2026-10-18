// The routes of a launched session's driver events (05 §4; 08 §4; 15 §1.4; 16 §8.3; ISSUE-182):
// suppliers delivers every event of a bound session, in the driver's order, with the dwarf it is
// bound to (`SuppliedEventSink`, ADR-015 item 7); each route turns one into the target module's
// command, through that module's public API only (R4, R15).
//
// - `message` → conversation `ingest([record], 'live-stream')` (05 §4 "driver stream entries"); an
//   echo of a message the person sent carries the receipt's correlation (`echoOf`) and merges into
//   that row, so it never shows a second bubble (INV-60; ISSUE-166 holds an echo that arrives
//   before the send's receipt). Then crew `recordActivity('message')` (S1.06), as observation's
//   activity route does for an observed session (routes/crew.ts).
// - `activity` → crew `recordActivity('message')` (S1.06): the dwarf is active. Its steps reach the
//   feed folded into entries (`ConversationEntry.activity`, US-MSG-004), never on their own.
// - `status: 'working'` → crew `recordActivity('turn-started')` (S1.08); `idle` moves nothing: the
//   turn's end is the driver's `turn.ended`.
// - `turn.ended` → conversation `recordTurnEnd` (ADR-021; 05 §4), which publishes the one
//   `TurnEnded` the cut-1 routes take to crew and attention (routes/cut1Routes.ts).
// - `usage` → ledger `creditUsage(o, 'driver')` (05 §4; 11 F2: the driver path).
// - `ask.opened` → asking `open(dwarfId, ask)` with the driver's own channel (`driver`), and
//   `ask.resolved` → asking `resolveExternally` (05 §4; ADR-010 item 5). The answer goes back through
//   the `driver` answer channel (bridges/driverAskChannel.ts).
// - `exited` → the `DriverSessionExited` route (routes/launching.ts `routeSessionExits`).
// - `error` → mines `checkFolder` for the dwarf's mine (05 §4 `DriverErrorReported`; AMENDMENT-2,
//   SC-AR-04), and the cause class is logged (never its detail).
// - `subagent` is not routed: launched sessions report their subagents from the transcript
//   (15 §3 `subagents: 'transcript'`), which observation reads.
//
// A route that throws is logged (`uncaught`, its error code only) and the next event is routed:
// the sink is suppliers' FIFO, and one module's failure never stops another's (16 §2.3).
import type { DwarfId, MineId } from '../../kernel/domain/values'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { AskBroker } from '../../modules/asking'
import type { ConversationCommands } from '../../modules/conversation'
import type { CrewCommands } from '../../modules/crew'
import type { LedgerCommands } from '../../modules/ledger'
import type { MinesCommands } from '../../modules/mines'
import type { SuppliedEventSink } from '../../modules/suppliers'
import { errorCode } from '../boot'

export interface DriverEventRouteDeps {
  conversation: Pick<ConversationCommands, 'ingest' | 'recordTurnEnd'>
  crew: {
    commands: Pick<CrewCommands, 'recordActivity'>
    /** The dwarf's mine, for the folder check of a driver error. */
    queries: { get(dwarfId: DwarfId): { mineId: MineId } | null }
  }
  asking: Pick<AskBroker, 'open' | 'resolveExternally'>
  ledger: Pick<LedgerCommands, 'creditUsage'>
  mines: Pick<MinesCommands, 'checkFolder'>
  /** The `DriverSessionExited` route (routes/launching.ts `routeSessionExits`). */
  exits: SuppliedEventSink
  log: DiagnosticsLog
}

export function routeDriverEvents(deps: DriverEventRouteDeps): SuppliedEventSink {
  const { conversation, crew, asking, ledger, mines, exits, log } = deps
  const failed = (error: unknown): void =>
    log.record({ level: 'error', event: 'uncaught', subsystem: 'host', errCode: errorCode(error) })
  const route: SuppliedEventSink['deliver'] = (delivery) => {
    const { dwarfId, event } = delivery
    switch (event.t) {
      case 'message':
        conversation.ingest(dwarfId, [event.record], 'live-stream')
        crew.commands.recordActivity(dwarfId, 'message')
        return
      case 'activity':
        crew.commands.recordActivity(dwarfId, 'message')
        return
      case 'status':
        if (event.value === 'working') crew.commands.recordActivity(dwarfId, 'turn-started')
        return
      case 'turn.ended':
        conversation.recordTurnEnd(event.end)
        return
      case 'usage':
        ledger.creditUsage(event.observation, 'driver')
        return
      case 'ask.opened':
        asking.open(dwarfId, event.ask)
        return
      case 'ask.resolved':
        asking.resolveExternally(dwarfId, event.providerRequestId, event.by)
        return
      case 'exited':
        exits.deliver(delivery)
        return
      case 'error': {
        log.record({
          level: 'warn',
          event: 'driver.error',
          subsystem: 'suppliers',
          causeClass: event.cause.kind
        })
        const mineId = crew.queries.get(dwarfId)?.mineId
        if (mineId !== undefined) void mines.checkFolder(mineId).catch(failed)
        return
      }
      case 'subagent':
        return
    }
  }
  return {
    deliver: (delivery) => {
      try {
        route(delivery)
      } catch (error) {
        failed(error)
      }
    }
  }
}
