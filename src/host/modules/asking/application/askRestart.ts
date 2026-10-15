// The Host boot settlement of the asks a stopped Host left live (07 S6.11, S6.17, S6.18, S6.20; ADR-010 item 11;
// ADR-015 item 4), over machine 6's `reconcileAfterRestart` (domain/askMachine.ts).
//
// - One transaction reads every `open` or `answering` ask (`AskRepository.live`) and saves each one machine 6 moves:
//   a session that did not survive closes it closed-by-death (S6.18); a request no longer pending closes an open ask
//   answered elsewhere (S6.11) and settles an answering one by its delivery evidence (S6.20); a request still pending
//   keeps it (S6.17, S6.20). The facts are the caller's: what the boot knows of each session and request.
// - `AskClosed` per closed ask follows the commit, in arrival order (16 §2.3); a kept ask publishes nothing, and a
//   closed ask is never read (terminal once).
// - No answer channel is called: the provider's request is not the Host's to answer any more.
import type { AskId, DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { isTerminal, type Ask } from '../domain/ask'
import { reconcileAfterRestart, type RestartFacts } from '../domain/askMachine'
import type { AskingEvent } from '../domain/events'
import type { AskRepository } from '../ports/askRepository'

export interface RestartSettlementDeps {
  asks: AskRepository
  transactions: TransactionRunner
  /** Publishes after the commit (16 §2.3). */
  bus: DomainEventBus<AskingEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class AskRestartSettlement {
  constructor(private readonly deps: RestartSettlementDeps) {}

  /** Settles each live ask by `factsOf` it; publishes `AskClosed` for each one that closed. */
  settleAfterRestart(factsOf: (ask: Ask) => RestartFacts): void {
    const { asks, transactions, clock, bus, ids, hostEpoch } = this.deps
    const closed = transactions.inTransaction((): Ask[] => {
      const now = clock.now()
      const moved = asks
        .live()
        .map((ask) => ({ before: ask, after: reconcileAfterRestart(ask, factsOf(ask), now).ask }))
        .filter(({ before, after }) => after.state !== before.state)
        .map(({ after }) => after)
      for (const ask of moved) asks.save(ask)
      return moved.filter((ask) => isTerminal(ask.state))
    })
    for (const ask of closed) {
      bus.publish({
        type: 'AskClosed',
        v: 1,
        id: ids.uuidv7() as EventId,
        at: clock.now(),
        hostEpoch,
        payload: { askId: ask.id as AskId, dwarfId: ask.dwarfId as DwarfId, reason: ask.state }
      })
    }
  }
}
