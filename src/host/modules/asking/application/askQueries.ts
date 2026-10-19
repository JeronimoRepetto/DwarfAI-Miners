// The `AskQueries` driving port (05 §3.7; 16 §4.7): the open asks for `session.snapshot` and for
// the frame projections (ADR-010 items 6, 9; 14 §4.1 `asks`). Read-only: no transaction, no event.
//
// Package gap (resolved in ISSUE-130): 05 and 16 name `AskView` without defining it. The only
// shape the contract ever sends for an ask is ADR-010's `AskRecord` (14 §3.5 `ask.opened`, §3.7
// the `asks` chunk), and `AskRecord` already is the text needed to redraw the card with its
// `currentStep` and never a partial pick (INV-75), so `AskView` is `AskRecord`.
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { CrewQueries } from '../../crew'
import type { AskRecord } from '../domain/ask'
import type { AskRepository } from '../ports/askRepository'

/** 05 §3.7 `AskView`: an ask as the transport sends it (package gap above). */
export type AskView = AskRecord

// verbatim: 05-modules-and-ports.md L897 (16 §4.7; `prettier-ignore` keeps it on one line)
// prettier-ignore
export interface AskQueries { openAsks(): AskView[]; openAskOf(dwarfId: DwarfId): AskView | null }
// end verbatim

/** 06 §0.2 `NeedsYouQueue` entry: a dwarf with an open ask, on its mine, since its oldest ask. */
export interface NeedsYouEntry {
  dwarfId: DwarfId
  mineId: MineId
  askedAt: Instant
}

/** What the snapshot's `asks` section holds (14 §3.7), read at one instant. */
export interface AsksSnapshot {
  asks: AskView[]
  needsYou: NeedsYouEntry[]
}

/** `AskQueries` plus the snapshot read the `asks` section serves (14 §4.1). */
export interface AskSnapshotQueries extends AskQueries {
  snapshot(): AsksSnapshot
}

export interface AskReadModelDeps {
  asks: Pick<AskRepository, 'live' | 'openFor'>
  /** Each dwarf's mine for the needs-you queue (the asking → crew edge, 05 §1.3). */
  crew: Pick<CrewQueries, 'get'>
}

export class AskReadModel implements AskSnapshotQueries {
  constructor(private readonly deps: AskReadModelDeps) {}

  /** Every open or answering ask, oldest first, read from the stored rows (`asks_live`). */
  openAsks(): AskView[] {
    return this.deps.asks.live()
  }

  /** The dwarf's front ask (ADR-010 item 7 FIFO), open or answering, or null. */
  openAskOf(dwarfId: DwarfId): AskView | null {
    return this.deps.asks.openFor(dwarfId)
  }

  /** The asks and the needs-you queue from one read, so the two never disagree. */
  snapshot(): AsksSnapshot {
    const asks = this.deps.asks.live()
    return { asks, needsYou: needsYouOf(asks, this.deps.crew) }
  }
}

/**
 * 06 §0.2 `NeedsYouQueue`: one entry per dwarf with an open ask, `askedAt` = its oldest live
 * ask's `openedAt`, in that order (ADR-032 D6: arrival order, never re-sorted). `asks` already
 * runs oldest first (`asks_needs_you`), so the first ask of a dwarf is its entry. A dwarf crew does
 * not know has no mine to show it on, so it gets no entry.
 */
function needsYouOf(asks: readonly AskRecord[], crew: Pick<CrewQueries, 'get'>): NeedsYouEntry[] {
  const seen = new Set<string>()
  const queue: NeedsYouEntry[] = []
  for (const ask of asks) {
    if (seen.has(ask.dwarfId)) continue
    seen.add(ask.dwarfId)
    const dwarfId = ask.dwarfId as DwarfId
    const dwarf = crew.get(dwarfId)
    if (dwarf === null) continue
    queue.push({ dwarfId, mineId: dwarf.mineId, askedAt: ask.openedAt })
  }
  return queue
}
