// The UI snapshot (14 §4.2, frozen; ADR-003 items 4, 7): `read` serves one page of B-M04.
//
// - A first read (no `snapshotId`) builds the snapshot synchronously, within the one event-loop
//   turn of the call, at the caller's current `seq` S: the seq of the last frame its connection
//   target numbered (FrameDelivery), so every section reflects exactly the frames up to S and
//   every later frame has a seq greater than S. Nothing awaits between reading S and the last
//   section (a provider is synchronous by type, sectionRegistry.ts).
// - The sections are the requested ones, or by default every registered section the caller's role
//   may read; a registered section outside the role is FORBIDDEN (`ui` reads the board sections,
//   `notifier` only `mine-names` and `dwarf-names`, 14 §2.3 B-M04). A section that is not
//   registered never reaches here: the method's params schema refuses it (INVALID_PARAMS, 14 §4.4).
// - Chunks come in the fixed 14 §4.2 order, `tails` and `marks` interleaved per dwarf (in the order
//   of the tails, a mark of a dwarf with no tail after them), and are packed into pages whose
//   encoded `res` frame stays under the 8 MiB frame cap (ADR-003 item 4): a page holds at most
//   SNAPSHOT_PAGE_BYTES of JSON, leaving RES_ENVELOPE_RESERVE_BYTES for the `res` envelope. A
//   chunk larger than a page is split by its provider's items — the elements of an array
//   section — in order, each exactly once. A section whose data is one object (`meta`,
//   `preferences`, `asks`, `recovery`) is one chunk and is never split.
// - Every page carries the same `snapshotId`, `seq` and `epoch`; each page but the last carries
//   the cursor of the next one in `next`.
// - The pages after the first are held in memory for the connection that built them until its
//   last page is read, or for SNAPSHOT_HOLD_MS after the previous read (the injected Scheduler);
//   then they are dropped, and a later page request gets SNAPSHOT_EXPIRED.
// - A continuation names its `snapshotId` and the cursor of the next page, and nothing else
//   (sessionSnapshot.ts). A snapshotId this Host does not hold for this connection — expired,
//   fully read, built by another connection, or from another Host epoch (each snapshotId starts
//   with the epoch that built it) — gets SNAPSHOT_EXPIRED, and the UI starts a new snapshot. A
//   cursor that is not the next page's (a page already read, or a page never issued) gets
//   INVALID_PARAMS and leaves the snapshot where it was: no page is ever skipped or served twice.
//
// Nothing here logs: a snapshot's content is sensitive (14 §1.10, §3.5) and the dispatcher logs
// names and codes only.
import { Buffer } from 'node:buffer'
import {
  FRAME_CAP_AFTER_HELLO_OK,
  type SnapshotChunk,
  type SnapshotPage,
  type SnapshotParams,
  type SnapshotSection
} from '@dwarfai/contracts'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import { CallError } from '../dispatcher'
import type { ChannelRole } from '../roles'
import {
  SNAPSHOT_CHUNK_ORDER,
  type RegisteredSection,
  type SectionRegistry
} from './sectionRegistry'

/** 14 §4.2: pages are held for 30 s after the previous read (architect value). */
export const SNAPSHOT_HOLD_MS = 30_000

/** What a page leaves of the 8 MiB frame for the `res` envelope and its correlation id. */
export const RES_ENVELOPE_RESERVE_BYTES = 64 * 1024

/** The most JSON bytes one page holds (14 §4.2: page ≤ 8 MiB; ADR-003 item 4: frame ≤ 8 MiB). */
export const SNAPSHOT_PAGE_BYTES = FRAME_CAP_AFTER_HELLO_OK - RES_ENVELOPE_RESERVE_BYTES

/** The sections whose data is an array of items, which a page may split. */
const ARRAY_SECTIONS: ReadonlySet<SnapshotSection> = new Set([
  'mines',
  'dwarfs',
  'tails',
  'marks',
  'launches',
  'mine-names',
  'dwarf-names'
])

export interface SnapshotServiceDeps {
  sections: SectionRegistry
  /** Mints each snapshotId. */
  ids: IdGenerator
  /** Drops held pages SNAPSHOT_HOLD_MS after the previous read. */
  scheduler: Scheduler
  /** This boot's epoch: every page carries it, and every snapshotId starts with it. */
  epoch: string
  /** The seq of the last frame numbered for the connection `clientId`'s target. */
  currentSeq: (clientId: string) => number
}

export interface SnapshotCaller {
  role: ChannelRole
  clientId: string
}

/** One section's data cut into what a page packs. */
type Piece =
  | { section: SnapshotSection; kind: 'whole'; data: unknown }
  | { section: SnapshotSection; kind: 'items'; items: readonly unknown[] }

/** A built snapshot's pages after the first, held for the connection that built it. */
interface Held {
  clientId: string
  pages: SnapshotPage[]
  /** The index of the page the next read returns. */
  next: number
  expiry: { cancel(): void }
}

export class SnapshotService {
  private readonly held = new Map<string, Held>()

  constructor(private readonly deps: SnapshotServiceDeps) {}

  /** One page of B-M04 for `caller`; a refusal throws a CallError (14 §3.3). */
  read(params: SnapshotParams, caller: SnapshotCaller): SnapshotPage {
    if (params.snapshotId !== undefined) return this.continue(params, caller)
    return this.build(params, caller)
  }

  private build(params: SnapshotParams, caller: SnapshotCaller): SnapshotPage {
    const sections = this.sectionsFor(params, caller.role)
    // One turn from here to the last page: S, then every section, with nothing awaited between.
    const seq = this.deps.currentSeq(caller.clientId)
    const pieces = piecesOf(sections)
    const snapshotId = `${this.deps.epoch}.${this.deps.ids.uuidv7()}`
    const pages = paginate(pieces, { snapshotId, seq, epoch: this.deps.epoch })
    const [first, ...rest] = pages
    if (first === undefined) throw new HostInvariantError('a snapshot has at least one page')
    if (rest.length > 0) {
      this.held.set(snapshotId, {
        clientId: caller.clientId,
        pages,
        next: 1,
        expiry: this.expireLater(snapshotId)
      })
    }
    return first
  }

  private continue(params: SnapshotParams, caller: SnapshotCaller): SnapshotPage {
    const snapshotId = params.snapshotId ?? ''
    const held = this.held.get(snapshotId)
    if (held === undefined || held.clientId !== caller.clientId) {
      throw new CallError('SNAPSHOT_EXPIRED')
    }
    const page = held.pages[held.next]
    if (page === undefined || params.cursor !== held.pages[held.next - 1]?.next) {
      throw new CallError('INVALID_PARAMS')
    }
    held.next += 1
    held.expiry.cancel()
    if (held.next === held.pages.length) this.held.delete(snapshotId)
    else held.expiry = this.expireLater(snapshotId)
    return page
  }

  /** The requested sections, or every one the role may read, in 14 §4.2 order. */
  private sectionsFor(params: SnapshotParams, role: ChannelRole): RegisteredSection[] {
    const requested = params.sections === undefined ? undefined : new Set(params.sections)
    const sections: RegisteredSection[] = []
    for (const name of SNAPSHOT_CHUNK_ORDER) {
      const section = this.deps.sections.get(name)
      if (section === undefined) continue
      const readable = section.roles.includes(role)
      if (requested === undefined) {
        if (readable) sections.push(section)
      } else if (requested.has(name)) {
        if (!readable) throw new CallError('FORBIDDEN')
        sections.push(section)
      }
    }
    return sections
  }

  private expireLater(snapshotId: string): { cancel(): void } {
    return this.deps.scheduler.after(SNAPSHOT_HOLD_MS, () => this.held.delete(snapshotId))
  }
}

/** Builds every section's data (synchronously) and cuts it into pieces in chunk order. */
function piecesOf(sections: readonly RegisteredSection[]): Piece[] {
  const built = sections.map((section) => ({ section: section.name, data: section.provider() }))
  const pieces: Piece[] = []
  const tails = built.find((entry) => entry.section === 'tails')
  const marks = built.find((entry) => entry.section === 'marks')
  for (const { section, data } of built) {
    if (section === 'tails' || section === 'marks') continue
    pieces.push(
      ARRAY_SECTIONS.has(section)
        ? { section, kind: 'items', items: data as unknown[] }
        : { section, kind: 'whole', data }
    )
  }
  pieces.push(
    ...interleavePerDwarf(
      tails?.data as DwarfItem[] | undefined,
      marks?.data as DwarfItem[] | undefined
    )
  )
  return pieces
}

interface DwarfItem {
  dwarfId: string
}

/**
 * 14 §4.2: `tails` and `marks` interleaved per dwarf — each dwarf's tail, then its marks, in the
 * order of the tails; the marks of a dwarf with no tail follow. A requested section with no item
 * still yields one empty chunk, so the UI knows it was read.
 */
function interleavePerDwarf(tails?: DwarfItem[], marks?: DwarfItem[]): Piece[] {
  const groups = new Map<string, { tails: DwarfItem[]; marks: DwarfItem[] }>()
  const groupOf = (dwarfId: string) => {
    let group = groups.get(dwarfId)
    if (group === undefined) {
      group = { tails: [], marks: [] }
      groups.set(dwarfId, group)
    }
    return group
  }
  for (const tail of tails ?? []) groupOf(tail.dwarfId).tails.push(tail)
  for (const mark of marks ?? []) groupOf(mark.dwarfId).marks.push(mark)
  const pieces: Piece[] = []
  for (const group of groups.values()) {
    if (group.tails.length > 0) pieces.push({ section: 'tails', kind: 'items', items: group.tails })
    if (group.marks.length > 0) pieces.push({ section: 'marks', kind: 'items', items: group.marks })
  }
  if (tails?.length === 0) pieces.push({ section: 'tails', kind: 'items', items: [] })
  if (marks?.length === 0) pieces.push({ section: 'marks', kind: 'items', items: [] })
  return pieces
}

interface PageHead {
  snapshotId: string
  seq: number
  epoch: string
}

/** The UTF-8 bytes of `value`'s JSON. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Packs `pieces` into pages of at most SNAPSHOT_PAGE_BYTES of JSON, in order. The count is an
 * upper bound: each chunk and item is counted with a separating comma, and each page with the
 * longest `next` cursor this snapshot could carry.
 */
function paginate(pieces: readonly Piece[], head: PageHead): SnapshotPage[] {
  const cursorOf = (index: number): string => `${head.snapshotId}/${index}`
  const pageOverhead =
    jsonBytes({ ...head, chunks: [], next: cursorOf(Number.MAX_SAFE_INTEGER) }) + 1
  const budget = SNAPSHOT_PAGE_BYTES - pageOverhead
  const pages: SnapshotChunk[][] = [[]]
  let used = 0
  const current = (): SnapshotChunk[] => pages[pages.length - 1] as SnapshotChunk[]
  const newPage = (): void => {
    pages.push([])
    used = 0
  }

  for (const piece of pieces) {
    if (piece.kind === 'whole') {
      const bytes = jsonBytes({ section: piece.section, data: piece.data }) + 1
      if (bytes > budget)
        throw new HostInvariantError(`a snapshot section exceeds a page: ${piece.section}`)
      if (used + bytes > budget) newPage()
      current().push({ section: piece.section, data: piece.data } as SnapshotChunk)
      used += bytes
      continue
    }
    const section = piece.section
    const chunkOverhead = jsonBytes({ section, data: [] }) + 1
    const startChunk = (): unknown[] => {
      const data: unknown[] = []
      current().push({ section, data } as SnapshotChunk)
      used += chunkOverhead
      return data
    }
    if (piece.items.length === 0) {
      if (used + chunkOverhead > budget) newPage()
      startChunk()
      continue
    }
    let chunk: unknown[] | null = null
    for (const item of piece.items) {
      const bytes = jsonBytes(item) + 1
      if (chunkOverhead + bytes > budget) {
        throw new HostInvariantError(`a snapshot item exceeds a page: ${section}`)
      }
      if (chunk === null) {
        if (used + chunkOverhead + bytes > budget) newPage()
        chunk = startChunk()
      } else if (used + bytes > budget) {
        newPage()
        chunk = startChunk()
      }
      chunk.push(item)
      used += bytes
    }
  }

  return pages.map((chunks, index) => ({
    snapshotId: head.snapshotId,
    seq: head.seq,
    epoch: head.epoch,
    chunks,
    ...(index < pages.length - 1 ? { next: cursorOf(index + 1) } : {})
  }))
}
