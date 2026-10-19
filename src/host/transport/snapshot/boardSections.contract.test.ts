// layer: L6
// L6 (17 §1.6): the board sections of `session.snapshot` (B-M04) — `mines` and `dwarfs` — built by
// the real SnapshotService over faked mines, crew and ledger reads, every page checked against
// its 14 §3.7 strict() schema (14 §1.4, §4.1, §4.2, §4.4; ADR-003 item 7; INV-93). The wire
// mapping (mappers/wire.ts) is what the strict schemas check: no status facts, no process ids.
import { describe, expect, it } from 'vitest'
import {
  snapshotPageSchema,
  type DwarfWire,
  type Material,
  type MaterialAmount,
  type MineWire,
  type SnapshotPage
} from '@dwarfai/contracts'
import type { MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { collectCapabilities } from '../capabilities'
import {
  BOARD_T0,
  dwarfView,
  FakeCrewQueries,
  FakeMinesQueries,
  mineView
} from '../frames/testing/fakeBoard'
import { NO_LEDGER_TOTALS, type MineTotalsReader } from '../mappers/wire'
import { SectionRegistry } from './sectionRegistry'
import { registerDwarfsSection } from './sections/dwarfs'
import { registerMinesSection } from './sections/mines'
import { SnapshotService } from './snapshotService'

const EPOCH = 'epoch-0082'
/** The seq of the last frame the caller's target numbered (FrameDelivery.currentSeq). */
const SEQ = 7
const MATERIALS: readonly Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']

function mineId(n: number): string {
  return `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function dwarfId(n: number): string {
  return `01920000-0000-7000-9000-${n.toString(16).padStart(12, '0')}`
}

/** A board of faked reads, the two sections registered as the composition root registers them. */
function board(ledger: MineTotalsReader = NO_LEDGER_TOTALS) {
  const mines = new FakeMinesQueries()
  const crew = new FakeCrewQueries()
  const sections = new SectionRegistry()
  registerMinesSection(sections, { mines, ledger })
  registerDwarfsSection(sections, { mines, crew })
  const clock = new FakeClock(BOARD_T0)
  const service = new SnapshotService({
    sections,
    ids: new SequenceIdGenerator(),
    scheduler: new FakeScheduler(clock),
    epoch: EPOCH,
    currentSeq: () => SEQ
  })
  const caller = { role: 'ui' as const, clientId: 'ui-1' }
  /** Reads every page of one snapshot, each checked against the 14 §3.7 schema. */
  const readAll = (between: () => void = () => {}): SnapshotPage[] => {
    const pages = [snapshotPageSchema.parse(service.read({}, caller)) as SnapshotPage]
    for (let page = pages[0]; page?.next !== undefined; page = pages.at(-1)) {
      between()
      pages.push(
        snapshotPageSchema.parse(
          service.read({ snapshotId: page.snapshotId, cursor: page.next }, caller)
        ) as SnapshotPage
      )
    }
    return pages
  }
  return { mines, crew, sections, readAll }
}

function minesOf(pages: readonly SnapshotPage[]): MineWire[] {
  return pages.flatMap((page) =>
    page.chunks.flatMap((chunk) => (chunk.section === 'mines' ? chunk.data : []))
  )
}

function dwarfsOf(pages: readonly SnapshotPage[]): DwarfWire[] {
  return pages.flatMap((page) =>
    page.chunks.flatMap((chunk) => (chunk.section === 'dwarfs' ? chunk.data : []))
  )
}

describe('the board sections of session.snapshot (14 §4.1, §4.2; ADR-003 item 7)', () => {
  it('[ADR-003] the mines and dwarfs sections are built at one seq and every page carries the same seq and snapshotId', () => {
    const b = board()
    // 24 mines of about 512 KiB each: about 12 MiB of mines, so the snapshot spans pages.
    for (let n = 1; n <= 24; n += 1) {
      b.mines.put(
        mineView(mineId(n), `mine-${String(n).padStart(2, '0')}-${'x'.repeat(512 * 1024)}`)
      )
      b.crew.put(dwarfView(dwarfId(n), mineId(n)))
    }

    // Between two page reads the board changes: a later page still shows the board at the seq the
    // snapshot was built at, never the change (14 §4.2).
    const pages = b.readAll(() => {
      b.mines.put(mineView(mineId(99), 'late'))
      b.crew.put(dwarfView(dwarfId(99), mineId(1)))
    })

    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.seq).toBe(SEQ)
      expect(page.snapshotId).toBe(pages[0]?.snapshotId)
      expect(page.epoch).toBe(EPOCH)
    }
    expect(minesOf(pages).map((mine) => mine.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => mineId(i + 1))
    )
    expect(dwarfsOf(pages).map((dwarf) => dwarf.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => dwarfId(i + 1))
    )
    // 14 §4.2 order: every mines chunk before the first dwarfs chunk.
    const order = pages.flatMap((page) => page.chunks.map((chunk) => chunk.section))
    expect(order.lastIndexOf('mines')).toBeLessThan(order.indexOf('dwarfs'))
    // 14 §4.4: advertised as section:<name>.
    expect(collectCapabilities({ methods: [], sections: b.sections.names() })).toEqual([
      'section:dwarfs',
      'section:mines'
    ])
  })

  it('[INV-93] each MineWire carries six separate material totals', () => {
    const credited: Record<Material, MaterialAmount> = {
      coal: { tokens: 600 },
      bronze: { tokens: 500 },
      copper: { tokens: 400 },
      silver: { tokens: 300 },
      gold: { tokens: 200 },
      uranium: { tokens: 100 }
    }
    const b = board({
      totalsOf: (id: MineId) => (id === mineId(1) ? credited : NO_LEDGER_TOTALS.totalsOf(id))
    })
    b.mines.put(mineView(mineId(1), 'alpha'))
    b.mines.put(mineView(mineId(2), 'beta'))

    const [alpha, beta] = minesOf(b.readAll())

    expect(alpha?.totals).toEqual(credited)
    expect(Object.keys(alpha?.totals ?? {}).sort()).toEqual([...MATERIALS].sort())
    // A mine with no credit yet: each material zero, carried on its own, never summed.
    expect(beta?.totals).toEqual(
      Object.fromEntries(MATERIALS.map((material) => [material, { tokens: 0 }]))
    )
    expect(alpha).not.toHaveProperty('total')
  })

  it('[ADR-003] a removed mine and a departed dwarf are never in a snapshot', () => {
    const b = board()
    b.mines.put(mineView(mineId(1), 'alpha'))
    b.mines.put(mineView(mineId(2), 'gone', { state: 'removed', removedAt: BOARD_T0 + 1 }))
    b.crew.put(dwarfView(dwarfId(1), mineId(1)))
    b.crew.put(
      dwarfView(dwarfId(2), mineId(1), {
        presence: 'walking-out',
        processState: 'closed',
        departedAt: BOARD_T0 + 2,
        departureCause: 'closed-elsewhere',
        departed: true
      })
    )
    // A dwarf of the removed mine is not on the board either.
    b.crew.put(dwarfView(dwarfId(3), mineId(2)))

    const pages = b.readAll()

    expect(minesOf(pages).map((mine) => mine.id)).toEqual([mineId(1)])
    expect(dwarfsOf(pages).map((dwarf) => dwarf.id)).toEqual([dwarfId(1)])
  })
})
