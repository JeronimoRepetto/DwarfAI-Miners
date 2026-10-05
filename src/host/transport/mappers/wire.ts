// The board's read models as they cross seam B (14 §3.6, frozen): `MineView` → `MineWire` and
// `DwarfView` → `DwarfWire`. Each wire field is named and copied; nothing else of a view crosses,
// so neither the status facts (ADR-032 D1: the status is computed by the Host, never derived in
// the UI) nor the provider identity, its process or session ids, the pending end or the usage path
// ever reach a UI (14 §3.6 "no StatusFacts, no process ids"). The snapshot sections and the board
// frames map through here, so a section and a frame carry the same shape.
//
// - A mine's `totals` are its ledger's six material totals, each carried on its own and never
//   summed (INV-93), read through `MineTotalsReader` (the ledger module, later: ISSUE-076,
//   ISSUE-096). Until the ledger is wired, `NO_LEDGER_TOTALS` reads every material as zero: the
//   true value of a mine nothing has been credited to.
// - A removed mine never crosses as a `MineWire` (its state has no wire value; it is
//   `mine.removed`, later: ISSUE-080): mapping one is a defect.
// - A stored message crosses as 14 §3.6 `MessageView` (06 §0.2): the domain view already left out
//   the row's `sourceKey`, `origin` and `askId` (conversation `toMessageView`); here each wire
//   field is named and copied, so a field the domain grows never crosses unseen.
// - `DwarfWire.workplace` (the worktree chip, mines' stamp, ADR-030 D4) and `outcome` (the outcome
//   line, conversation's, INV-67) are not in `DwarfView`; they join when their owners do.
import type {
  Delivery as DeliveryWire,
  DwarfWire,
  FolderPath,
  Material,
  MaterialAmount,
  MessageView as MessageWire,
  MineWire
} from '@dwarfai/contracts'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { MineId } from '../../kernel/domain/values'
import type { Delivery, MessageView } from '../../modules/conversation'
import type { DwarfView } from '../../modules/crew'
import type { MineView } from '../../modules/mines'

/** 14 §3.6 `MineWire.totals`: the six materials, each on its own (INV-93). */
export type MaterialTotals = Record<Material, MaterialAmount>

/** Reads a mine's ledger totals, at the instant the caller maps the mine. */
export interface MineTotalsReader {
  totalsOf(mineId: MineId): MaterialTotals
}

/** No ledger is wired yet (later: ISSUE-076, ISSUE-096): nothing was credited, every material is zero. */
export const NO_LEDGER_TOTALS: MineTotalsReader = Object.freeze({
  totalsOf: (): MaterialTotals => ({
    coal: { tokens: 0 },
    bronze: { tokens: 0 },
    copper: { tokens: 0 },
    silver: { tokens: 0 },
    gold: { tokens: 0 },
    uranium: { tokens: 0 }
  })
})

/** 14 §3.6 `MineWire` of a mine on the board, with its ledger totals. */
export function toMineWire(view: MineView, totals: MaterialTotals): MineWire {
  if (view.state === 'removed') {
    throw new HostInvariantError(`a removed mine never crosses as a MineWire: ${view.id}`)
  }
  return {
    id: view.id,
    path: view.path as string as FolderPath,
    name: view.name,
    state: view.state,
    tier: view.tier,
    hasBeenMeasured: view.hasBeenMeasured,
    ...(view.unenterableReason === undefined ? {} : { unenterableReason: view.unenterableReason }),
    ...(view.mapSite === undefined
      ? {}
      : { mapSite: { xPct: view.mapSite.xPct, yPct: view.mapSite.yPct } }),
    lastUsedAt: view.lastUsedAt,
    totals: {
      coal: { tokens: totals.coal.tokens },
      bronze: { tokens: totals.bronze.tokens },
      copper: { tokens: totals.copper.tokens },
      silver: { tokens: totals.silver.tokens },
      gold: { tokens: totals.gold.tokens },
      uranium: { tokens: totals.uranium.tokens }
    }
  }
}

/** 14 §3.6 `DwarfWire` of a dwarf: the wire subset of its view, no status facts, no process ids. */
export function toDwarfWire(view: DwarfView): DwarfWire {
  const profile = view.sessionProfile
  return {
    id: view.id,
    mineId: view.mineId,
    providerId: view.providerId,
    baseName: view.baseName,
    customName: view.customName,
    rank: view.rank,
    parentDwarfId: view.parentDwarfId,
    delegated: view.delegated,
    sessionProfile: {
      providerId: profile.providerId,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      ...(profile.permissionMode === undefined ? {} : { permissionMode: profile.permissionMode })
    },
    presence: view.presence,
    processState: view.processState,
    status: view.status,
    needsYou: view.needsYou,
    ...(view.askedAt === undefined ? {} : { askedAt: view.askedAt }),
    canReceiveMessages: view.canReceiveMessages,
    stopInFlight: view.stopInFlight,
    stopUnavailableReason: view.stopUnavailableReason,
    owned: view.owned,
    arrivedAt: view.arrivedAt
  }
}

/** 14 §3.6 `MessageView` of a stored message (06 §0.2): no `sourceKey`, `origin` or `askId`. */
export function toMessageWire(view: MessageView): MessageWire {
  return {
    id: view.id,
    dwarfId: view.dwarfId,
    role: view.role,
    text: view.text,
    ...(view.issuer === undefined ? {} : { issuer: { dwarfId: view.issuer.dwarfId } }),
    ...(view.activity === undefined
      ? {}
      : { activity: { steps: view.activity.steps, summaries: [...view.activity.summaries] } }),
    attachments: view.attachments.map((a) => ({ name: a.name, bytes: a.bytes })),
    ...(view.delivery === undefined ? {} : { delivery: toDeliveryWire(view.delivery) }),
    providerTime: view.providerTime,
    createdAt: view.createdAt
  }
}

/** ADR-022 item 1 `Delivery` as it crosses seam B. */
function toDeliveryWire(delivery: Delivery): DeliveryWire {
  return {
    messageId: delivery.messageId,
    dwarfId: delivery.dwarfId,
    kind: delivery.kind,
    phase: delivery.phase,
    ...(delivery.confidence === undefined ? {} : { confidence: delivery.confidence }),
    ...(delivery.heldUntilTurnEnd === undefined
      ? {}
      : { heldUntilTurnEnd: delivery.heldUntilTurnEnd }),
    ...(delivery.failure === undefined ? {} : { failure: { ...delivery.failure } }),
    attempts: delivery.attempts,
    phaseAt: delivery.phaseAt
  }
}
