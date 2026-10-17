// layer: L6
// L6 (17 §1.6): a delegated worker on seam B (14 §2.4 note; §3.6 `DwarfWire.delegated`,
// `parentDwarfId`; ADR-013 item 5; INV-85; ISSUE-207). The worker is an ordinary dwarf the UI can
// tell apart: the snapshot's `dwarfs` section (B-M04, 14 §4.1) and the `dwarf.arrived` frame
// (B-F08) both carry `delegated: true` and its parent's id, and every other dwarf — the parent, a
// subagent the parent started itself — carries `delegated: false`. The crew is the real crew
// application over its in-memory doubles (16 §2.8); the mines reads are faked. Every page and frame
// is checked against its 14 §3.5 / §3.7 strict() schema (14 §1.4).
//
// TC-207-01 (the snapshot and `dwarf.arrived` carry the mark and the parent).
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  snapshotPageSchema,
  type DwarfWire,
  type HostFrameData,
  type HostFrameName,
  type SnapshotPage
} from '@dwarfai/contracts'
import type { MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import type { MinesEvent } from '../../modules/mines'
import type { ObservationEvent } from '../../modules/observation'
import { publishBoardFrames } from '../frames/board'
import { BOARD_T0, FakeMinesQueries, mineView } from '../frames/testing/fakeBoard'
import { NO_LEDGER_TOTALS } from '../mappers/wire'
import { SectionRegistry } from './sectionRegistry'
import { registerDwarfsSection } from './sections/dwarfs'
import { SnapshotService } from './snapshotService'

const MINE = '01920000-0000-7000-8000-0000000002a7' as MineId

/** Records every frame the board projection publishes, each checked against its 14 §3.5 schema. */
class RecordingFrames {
  readonly sent: { name: string; data: unknown }[] = []

  publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    this.sent.push({ name, data })
    const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
    schemas[name]?.parse(data)
  }

  arrived(): DwarfWire[] {
    return this.sent.flatMap((frame) =>
      frame.name === 'dwarf.arrived' ? [(frame.data as HostFrameData['dwarf.arrived']).dwarf] : []
    )
  }
}

/** The board of one mine over the real crew, its frames and its `dwarfs` snapshot section. */
function board() {
  const crew = inMemoryCrew()
  const mines = new FakeMinesQueries()
  mines.put(mineView(MINE, 'north-seam'))
  const frames = new RecordingFrames()
  publishBoardFrames({
    events: {
      mines: new RecordingEventBus<MinesEvent>(),
      crew: crew.bus,
      observation: new RecordingEventBus<ObservationEvent>()
    },
    mines,
    crew: crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames
  })
  const sections = new SectionRegistry()
  registerDwarfsSection(sections, { mines, crew: crew.queries })
  const service = new SnapshotService({
    sections,
    ids: new SequenceIdGenerator(),
    scheduler: new FakeScheduler(new FakeClock(BOARD_T0)),
    epoch: 'epoch-207',
    currentSeq: () => 0
  })
  /** The `dwarfs` section of one whole snapshot, every page checked against 14 §3.7. */
  const snapshotDwarfs = (): DwarfWire[] => {
    const caller = { role: 'ui' as const, clientId: 'ui-207' }
    const pages = [snapshotPageSchema.parse(service.read({}, caller)) as SnapshotPage]
    for (let page = pages[0]; page?.next !== undefined; page = pages.at(-1)) {
      pages.push(
        snapshotPageSchema.parse(
          service.read({ snapshotId: page.snapshotId, cursor: page.next }, caller)
        ) as SnapshotPage
      )
    }
    return pages.flatMap((page) =>
      page.chunks.flatMap((chunk) => (chunk.section === 'dwarfs' ? chunk.data : []))
    )
  }
  return { crew, frames, snapshotDwarfs }
}

describe('a delegated worker on seam B (14 §2.4 note, §3.6; ADR-013 item 5)', () => {
  it('[US-DLG-002.AC05] the snapshot dwarfs section and the dwarf.arrived frame carry delegated and parentDwarfId for a worker and delegated false for any other dwarf', () => {
    const b = board()
    // The delegating dwarf: the mine's root session (a foreman).
    const parent = b.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'parent-207' },
      rank: rankForDepth(0),
      status: 'working'
    })
    // A subagent the parent started itself: it has a parent, and it is no delegation (INV-28).
    const own = b.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'own-subagent-207' },
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })
    // The worker of a delegation, as launching arrives it (AMENDMENT-15).
    const worker = b.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'simulated', providerSessionId: 'worker-207' },
      parent,
      rank: rankForDepth(1),
      status: 'working',
      delegated: true
    })

    const marks = (dwarfs: readonly DwarfWire[]) =>
      dwarfs.map(({ id, delegated, parentDwarfId }) => ({ id, delegated, parentDwarfId }))
    const expected = [
      { id: parent, delegated: false, parentDwarfId: null },
      { id: own, delegated: false, parentDwarfId: parent },
      { id: worker, delegated: true, parentDwarfId: parent }
    ]
    expect(marks(b.frames.arrived())).toStrictEqual(expected)
    expect(marks(b.snapshotDwarfs())).toStrictEqual(expected)
    // The worker is otherwise an ordinary dwarf: ranked by depth like the parent's own subagent.
    const [, ownWire, workerWire] = b.snapshotDwarfs()
    expect(workerWire?.rank).toBe(ownWire?.rank)
  })
})
