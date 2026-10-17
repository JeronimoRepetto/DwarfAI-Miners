// layer: L6
// L6 (17 §1.6): the `marks` section of `session.snapshot` (B-M04; 14 §4.1, §4.2, §4.4; ADR-022 item
// 6) built by the real SnapshotService beside the board and `tails`, over faked mines, crew and
// conversation reads, every page checked against its 14 §3.7 strict() schema (14 §1.4).
//
// TC-166-04 (a reattached UI gets the Host's current phase of each message in the tails).
import { describe, expect, it } from 'vitest'
import { sectionCapability, snapshotPageSchema, type SnapshotPage } from '@dwarfai/contracts'
import type { DwarfId, MessageId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { Delivery, MessageView } from '../../modules/conversation'
import { FakeConversationQueries } from '../../modules/conversation/testing/FakeConversationQueries'
import { collectCapabilities } from '../capabilities'
import {
  BOARD_T0,
  dwarfView,
  FakeCrewQueries,
  FakeMinesQueries,
  mineView
} from '../frames/testing/fakeBoard'
import { NO_LEDGER_TOTALS } from '../mappers/wire'
import { registerMarksSection } from './marksSection'
import { SNAPSHOT_TAIL } from './metaSection'
import { SectionRegistry } from './sectionRegistry'
import { registerDwarfsSection } from './sections/dwarfs'
import { registerMinesSection } from './sections/mines'
import { SnapshotService } from './snapshotService'
import { registerTailsSection } from './tailsSection'

const uuid = (prefix: string, n: number): string =>
  `01920000-0000-7000-${prefix}-${n.toString(16).padStart(12, '0')}`
const MINE = uuid('8000', 1)
const DWARF_A = uuid('9000', 0xa) as DwarfId
const DWARF_B = uuid('9000', 0xb) as DwarfId
const DWARF_GONE = uuid('9000', 0xc) as DwarfId

/** A person row of `dwarfId` sent at BOARD_T0 + n, with `delivery` when it has one. */
function sent(dwarfId: DwarfId, n: number, delivery?: Omit<Delivery, 'messageId' | 'dwarfId'>) {
  const id = uuid('a000', n) as MessageId
  const row: MessageView = {
    id,
    dwarfId,
    role: 'person',
    text: `line ${n}`,
    attachments: [],
    providerTime: null,
    createdAt: BOARD_T0 + n,
    ...(delivery === undefined ? {} : { delivery: { messageId: id, dwarfId, ...delivery } })
  }
  return row
}

function world() {
  const mines = new FakeMinesQueries()
  const crew = new FakeCrewQueries()
  const conversation = new FakeConversationQueries()
  mines.put(mineView(MINE, 'alpha'))
  crew.put(dwarfView(DWARF_A, MINE))
  crew.put(dwarfView(DWARF_B, MINE))
  crew.put(dwarfView(DWARF_GONE, MINE, { departed: true }))
  const sections = new SectionRegistry()
  registerMinesSection(sections, { mines, ledger: NO_LEDGER_TOTALS })
  registerDwarfsSection(sections, { mines, crew })
  registerTailsSection(sections, { mines, crew, conversation })
  registerMarksSection(sections, { mines, crew, conversation })
  const service = new SnapshotService({
    sections,
    ids: new SequenceIdGenerator(),
    scheduler: new FakeScheduler(new FakeClock(BOARD_T0)),
    epoch: 'epoch-0166',
    currentSeq: () => 7
  })
  const read = (role: 'ui' | 'notifier' = 'ui'): SnapshotPage =>
    snapshotPageSchema.parse(service.read({}, { role, clientId: `${role}-1` })) as SnapshotPage
  return { sections, conversation, read }
}

describe('the marks section of session.snapshot (14 §4.1, §4.2)', () => {
  it('[ADR-022, US-MSG-001.AC10, S7.18] the snapshot marks section carries the phase, confidence and failure of every message in the tails', () => {
    const w = world()
    // Newest first, as the feed answers. The tail of A holds four marked rows and one provider row.
    w.conversation.seed(DWARF_A, [
      sent(DWARF_A, 5, { kind: 'message', phase: 'sending', attempts: 1, phaseAt: BOARD_T0 + 5 }),
      sent(DWARF_A, 4, {
        kind: 'message',
        phase: 'failed',
        failure: { kind: 'session-closed' },
        attempts: 1,
        phaseAt: BOARD_T0 + 4
      }),
      { ...sent(DWARF_A, 3), role: 'dwarf' },
      sent(DWARF_A, 2, {
        kind: 'message',
        phase: 'reacted',
        confidence: 'confirmed',
        attempts: 1,
        phaseAt: BOARD_T0 + 2
      }),
      sent(DWARF_A, 1, {
        kind: 'message',
        phase: 'delivered',
        confidence: 'unconfirmed',
        attempts: 2,
        phaseAt: BOARD_T0 + 1
      })
    ])
    w.conversation.seed(DWARF_B, [
      sent(DWARF_B, 9, {
        kind: 'message',
        phase: 'failed',
        failure: { kind: 'channel-error', reason: 'pipe closed' },
        attempts: 1,
        phaseAt: BOARD_T0 + 9
      })
    ])
    w.conversation.seed(DWARF_GONE, [
      sent(DWARF_GONE, 7, { kind: 'message', phase: 'sending', attempts: 1, phaseAt: BOARD_T0 })
    ])

    const page = w.read()

    // 14 §4.2: each dwarf's tail, then its marks.
    expect(page.chunks.map((chunk) => chunk.section)).toEqual([
      'mines',
      'dwarfs',
      'tails',
      'marks',
      'tails',
      'marks'
    ])
    const marks = page.chunks.flatMap((chunk) => (chunk.section === 'marks' ? chunk.data : []))
    expect(
      marks.map((mark) => [mark.messageId, mark.phase, mark.confidence, mark.failure])
    ).toEqual([
      [uuid('a000', 5), 'sending', undefined, undefined],
      [uuid('a000', 4), 'failed', undefined, { kind: 'session-closed' }],
      [uuid('a000', 2), 'reacted', 'confirmed', undefined],
      [uuid('a000', 1), 'delivered', 'unconfirmed', undefined],
      [uuid('a000', 9), 'failed', undefined, { kind: 'channel-error', reason: 'pipe closed' }]
    ])
    // The marks are read over the tail's own rows, never more.
    expect(w.conversation.calls).toContainEqual({
      dwarfId: DWARF_A,
      page: { limit: SNAPSHOT_TAIL }
    })
    // `ui` only.
    expect(w.read('notifier').chunks).toEqual([])
  })

  it('[ADR-022] hello.ok advertises section:marks for ui only, and an empty board yields one empty marks chunk', () => {
    const w = world()
    expect(
      collectCapabilities({ methods: [], frames: [], sections: w.sections.names() })
    ).toContain(sectionCapability('marks'))
    expect(w.sections.get('marks')?.roles).toEqual(['ui'])
    const page = w.read()
    expect(page.chunks.filter((chunk) => chunk.section === 'marks')).toEqual([
      { section: 'marks', data: [] }
    ])
  })
})
