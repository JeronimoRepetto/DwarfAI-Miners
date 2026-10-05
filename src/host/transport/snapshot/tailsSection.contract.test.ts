// layer: L6
// L6 (17 §1.6): the `tails` section of `session.snapshot` (B-M04; 14 §3.7, §4.1, §4.2, §4.4;
// ADR-003 item 7; ADR-007 item 6) built by the real SnapshotService beside the board sections,
// over faked mines, crew and conversation reads, every page checked against its 14 §3.7 strict()
// schema (14 §1.4). A reopened chat paints from these rows at once and pages the rest through
// `conversation.feed` (methods/conversationFeed.ts).
//
// TC-103-01 (the newest 20 and reachedStart false for a dwarf with more stored rows).
import { describe, expect, it } from 'vitest'
import {
  sectionCapability,
  frameCapability,
  snapshotPageSchema,
  type SnapshotPage
} from '@dwarfai/contracts'
import type { DwarfId, MessageId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { MessageView } from '../../modules/conversation'
import { FakeConversationQueries } from '../../modules/conversation/testing/FakeConversationQueries'
import { collectCapabilities } from '../capabilities'
import { CONVERSATION_FRAMES } from '../frames/conversationAppended'
import {
  BOARD_T0,
  dwarfView,
  FakeCrewQueries,
  FakeMinesQueries,
  mineView
} from '../frames/testing/fakeBoard'
import { NO_LEDGER_TOTALS } from '../mappers/wire'
import { SNAPSHOT_TAIL } from './metaSection'
import { SectionRegistry } from './sectionRegistry'
import { registerDwarfsSection } from './sections/dwarfs'
import { registerMinesSection } from './sections/mines'
import { registerTailsSection } from './tailsSection'
import { SnapshotService } from './snapshotService'

const EPOCH = 'epoch-0103'
const SEQ = 11

const uuid = (prefix: string, n: number): string =>
  `01920000-0000-7000-${prefix}-${n.toString(16).padStart(12, '0')}`
const MINE_1 = uuid('8000', 1)
const MINE_2 = uuid('8000', 2)
const DWARF_A = uuid('9000', 0xa) as DwarfId
const DWARF_B = uuid('9000', 0xb) as DwarfId
const DWARF_GONE = uuid('9000', 0xc) as DwarfId

/** `count` rows of `dwarfId`, newest first; row n was said at BOARD_T0 + n. */
function rows(dwarfId: DwarfId, base: number, count: number): MessageView[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - 1 - i
    return {
      id: uuid('a000', base + n) as MessageId,
      dwarfId,
      role: n % 2 === 0 ? 'person' : 'dwarf',
      text: `line ${n}`,
      attachments: [],
      providerTime: BOARD_T0 + n,
      createdAt: BOARD_T0 + n
    }
  })
}

/** The board and the chats, registered as the composition root registers them. */
function world() {
  const mines = new FakeMinesQueries()
  const crew = new FakeCrewQueries()
  const conversation = new FakeConversationQueries()
  mines.put(mineView(MINE_1, 'alpha'))
  mines.put(mineView(MINE_2, 'bravo'))
  crew.put(dwarfView(DWARF_A, MINE_1))
  crew.put(dwarfView(DWARF_B, MINE_2))
  crew.put(dwarfView(DWARF_GONE, MINE_2, { departed: true }))
  conversation.seed(DWARF_A, rows(DWARF_A, 0x100, 30))
  conversation.seed(DWARF_B, rows(DWARF_B, 0x200, 5))
  conversation.seed(DWARF_GONE, rows(DWARF_GONE, 0x300, 2))
  const sections = new SectionRegistry()
  registerMinesSection(sections, { mines, ledger: NO_LEDGER_TOTALS })
  registerDwarfsSection(sections, { mines, crew })
  registerTailsSection(sections, { mines, crew, conversation })
  const clock = new FakeClock(BOARD_T0)
  const service = new SnapshotService({
    sections,
    ids: new SequenceIdGenerator(),
    scheduler: new FakeScheduler(clock),
    epoch: EPOCH,
    currentSeq: () => SEQ
  })
  const read = (role: 'ui' | 'notifier' = 'ui'): SnapshotPage =>
    snapshotPageSchema.parse(service.read({}, { role, clientId: `${role}-1` })) as SnapshotPage
  return { sections, conversation, read }
}

describe('the tails section of session.snapshot (14 §4.1, §4.2)', () => {
  it('[ADR-003] the tails section holds the newest 20 messages of each present dwarf with reachedStart and comes after the board chunks', () => {
    const w = world()
    const page = w.read()

    // 14 §4.2: the board first, then the chats, so a UI paints the board before the chats arrive.
    expect(page.chunks.map((chunk) => chunk.section)).toEqual(['mines', 'dwarfs', 'tails', 'tails'])
    expect(page.seq).toBe(SEQ)
    const tails = page.chunks.flatMap((chunk) => (chunk.section === 'tails' ? chunk.data : []))
    expect(tails.map((tail) => tail.dwarfId)).toEqual([DWARF_A, DWARF_B])

    // A dwarf with more stored rows than the tail: the newest 20, newest first, start not reached.
    const [a, b] = tails
    expect(SNAPSHOT_TAIL).toBe(20)
    expect(a?.messages).toHaveLength(SNAPSHOT_TAIL)
    expect(a?.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${29 - i}`)
    )
    expect(a?.reachedStart).toBe(false)
    // A dwarf with fewer: all of them, and the start reached. A departed dwarf has no tail.
    expect(b?.messages.map((m) => m.text)).toEqual([
      'line 4',
      'line 3',
      'line 2',
      'line 1',
      'line 0'
    ])
    expect(b?.reachedStart).toBe(true)
    expect(w.conversation.calls).toEqual([
      { dwarfId: DWARF_A, page: { limit: SNAPSHOT_TAIL } },
      { dwarfId: DWARF_B, page: { limit: SNAPSHOT_TAIL } }
    ])

    // `ui` only: a notifier's default snapshot holds no tail.
    expect(w.read('notifier').chunks.map((chunk) => chunk.section)).toEqual([])
  })

  it('[ADR-003] hello.ok advertises section:tails and frame:conversation.appended', () => {
    const w = world()
    const capabilities = collectCapabilities({
      methods: [],
      frames: CONVERSATION_FRAMES,
      sections: w.sections.names()
    })
    expect(capabilities).toContain(sectionCapability('tails'))
    expect(capabilities).toContain(frameCapability('conversation.appended'))
    expect(w.sections.get('tails')?.roles).toEqual(['ui'])
  })
})
