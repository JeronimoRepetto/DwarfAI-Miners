// `MinesCommands.remove` (05 §3.1; 16 §4.1; UC-020; 07 S3.15–S3.18; 06 INV-06, INV-96; ADR-014
// item 6; PO #3, #4, #49, #79): "Remove mine" ends every session in the mine, then removes it, or
// keeps it and says which dwarfs could not be ended.
//
// - S3.15: removal starts (`removing` is never stored): a running scoring walk is aborted and a
//   pending one dropped (`abortWalk`), then crew's `endAllIn(mineId, requestId)` ends every present
//   dwarf in parallel, mid-turn included, along the mines → crew edge (05 §1.3). The command waits
//   for every end (14 §1.7: `mines.remove` answers after every end), holding no transaction.
// - S3.16: every dwarf ended (crew departed each `mine-removed` before answering), so the mine, read
//   again (16 §2.5), becomes `removed` with `removedAt` in one transaction; its ledger, dwarfs and
//   messages stay (soft delete, INV-06, INV-96). `MineRemoved` follows the commit.
// - S3.17: one or more could not be ended, so nothing is written: the mine keeps its prior state
//   with exactly those dwarfs (the ended ones walked out) and ONE `MineRemovalFailed{requestId,
//   failed}` names them all; the answer is `dwarf-could-not-be-ended` (PO #79). Package gap: S3.17
//   keeps the prior state while S3.15 aborted its walk; a `measuring` mine is given its walk again
//   (`remeasure`), so it does not stay measuring with no walk until the next boot (S3.25).
// - S3.18: a Host crash before the outcome leaves the mine as it was (nothing was written); the
//   person repeats Remove mine. A mine already removed answers ok with no effect, as does an id no
//   mine has (the frozen result has no other outcome, 14 §3.4 `RemoveMineResult`).
import type { EventId, HostEpoch, MineId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewEnds } from '../../crew'
import { transition, type Mine } from '../domain/mine'
import type { MineRepository } from '../ports/mineRepository'
import type { MinesCommands } from './declare'
import type { MineRemovalEvent } from './events'

export interface MineRemovalDeps {
  readonly repository: MineRepository
  readonly transactions: TransactionRunner
  readonly bus: Pick<DomainEventBus<MineRemovalEvent>, 'publish'>
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly hostEpoch: HostEpoch
  /** Crew's ends (05 §1.3 edge mines → crew). */
  readonly crew: CrewEnds
  /** S3.15: aborts the mine's running walk and drops a pending one (`measure.ts` `abort`). */
  abortWalk(mineId: MineId): void
  /** `MinesCommands.remeasure`: the walk a kept `measuring` mine gets again. */
  remeasure(mineId: MineId): void
}

/** `MinesCommands.remove` over `deps`. */
export function createRemove(deps: MineRemovalDeps): Pick<MinesCommands, 'remove'> {
  return {
    async remove(mineId, requestId): Promise<Result<void, 'dwarf-could-not-be-ended'>> {
      const mine = deps.repository.byId(mineId)
      if (mine === null) return OK
      if (transition(mine, { type: 'removal-requested' }, deps.clock.now()).transition === null) {
        return OK
      }
      deps.abortWalk(mineId)
      const { failed } = await deps.crew.endAllIn(mineId, requestId)
      const everyDwarfEnded = failed.length === 0
      const now = deps.clock.now()
      const settled = deps.transactions.inTransaction((): Mine | null => {
        const current = deps.repository.byId(mineId)
        if (current === null) return null
        const step = transition(current, { type: 'removal-settled', everyDwarfEnded }, now)
        if (step.transition === 'S3.16' && step.mine !== null) deps.repository.save(step.mine)
        return step.transition === null ? null : current
      })
      if (!everyDwarfEnded) {
        publish(deps, 'MineRemovalFailed', { mineId, requestId, failed })
        if (settled?.state === 'measuring') deps.remeasure(mineId)
        return { ok: false, error: 'dwarf-could-not-be-ended' }
      }
      if (settled !== null) publish(deps, 'MineRemoved', { mineId, removedAt: now })
      return OK
    }
  }
}

const OK: Result<void, never> = { ok: true, value: undefined }

function publish<K extends MineRemovalEvent['type']>(
  deps: MineRemovalDeps,
  type: K,
  payload: Extract<MineRemovalEvent, { type: K }>['payload']
): void {
  deps.bus.publish({
    type,
    v: 1,
    id: deps.ids.uuidv7() as EventId,
    at: deps.clock.now(),
    hostEpoch: deps.hostEpoch,
    payload
  } as Extract<MineRemovalEvent, { type: K }>)
}
