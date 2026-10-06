// L2 (17 §1.2): `ConversationQueries.mineHistory` (16 §4.6; 14 §3.6 `MineHistoryView`; ADR-007
// item 5; PO #87) over the in-memory doubles, which run the same `MessageLog` contract as
// `SqliteMessageLog` (17 §1.3), and a fake crew query (16 §4.2 `CrewQueries.crewOf`, AMENDMENT-10):
// every dwarf that ever worked in the mine, present or departed, with the same ≤ 50 stored rows the
// feed pages, oldest first, undelivered ones included — from the Host's message log alone, never
// from a provider file.
//
// TC-104-01 (present and departed speakers, each with its stored rows only).
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'
import { CONVERSATION_T0 as T0, inMemoryConversation } from '../testing/inMemoryConversation'
import { ConversationFeedQueries, ConversationMineHistory, type MineCrew } from './queries'

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const MINE = id(0x10) as MineId
const OTHER_MINE = id(0x11) as MineId
const DAIN = id(0xd1) as DwarfId
const THRAIN = id(0xd2) as DwarfId
const NORI = id(0xd3) as DwarfId
const STRANGER = id(0xd4) as DwarfId

interface CrewRow {
  id: DwarfId
  mineId: MineId
  displayName: string
  departed: boolean
}

/** `crewOf` over a list: departed dwarfs only when asked for (AMENDMENT-10), in arrival order. */
class FakeMineCrew implements MineCrew {
  readonly calls: Array<{ mineId: MineId; opts: unknown }> = []
  constructor(private readonly rows: readonly CrewRow[]) {}

  crewOf(mineId: MineId, opts: { includeDeparted: true }): CrewRow[] {
    this.calls.push({ mineId, opts: { ...opts } })
    return this.rows.filter(
      (row) => row.mineId === mineId && (opts.includeDeparted === true || !row.departed)
    )
  }
}

const CREW: CrewRow[] = [
  { id: DAIN, mineId: MINE, displayName: 'Dáin', departed: false },
  { id: THRAIN, mineId: MINE, displayName: 'Thráin', departed: true },
  { id: NORI, mineId: MINE, displayName: 'Nori', departed: false },
  { id: STRANGER, mineId: OTHER_MINE, displayName: 'Stranger', departed: false }
]

/** What a transcript observer reads (15 §1.5 key shape); never real conversation text. */
const observed = (dwarf: string, n: number): ConversationEntry => ({
  sourceKey: `claude:claude:session-${dwarf}:event-${n}`,
  role: n % 2 === 0 ? 'person' : 'dwarf',
  text: `${dwarf} message ${n}`,
  providerTime: T0 + n
})

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

function setUp(crew: readonly CrewRow[] = CREW) {
  const c = inMemoryConversation()
  const fakeCrew = new FakeMineCrew(crew)
  const history = new ConversationMineHistory({ log: c.log, crew: fakeCrew })
  return { c, fakeCrew, history }
}

describe('mineHistory', () => {
  it('[US-MINE-006.AC01, NFR-PERS-07] every dwarf that worked in the mine, present or departed, is one speaker with its messages and its last timed entry', () => {
    const { c, fakeCrew, history } = setUp()
    c.commands.ingest(
      DAIN,
      range(1, 3).map((n) => observed('dain', n)),
      'transcript'
    )
    c.commands.ingest(
      THRAIN,
      range(4, 5).map((n) => observed('thrain', n)),
      'transcript'
    )
    c.commands.ingest(STRANGER, [observed('stranger', 6)], 'transcript')

    const view = history.mineHistory(MINE)

    // Departed dwarfs are asked for (AMENDMENT-10): Thráin left, and its rows are kept (09 §7.1).
    expect(fakeCrew.calls).toEqual([{ mineId: MINE, opts: { includeDeparted: true } }])
    expect(view.mineId).toBe(MINE)
    expect(view.speakers.map((s) => [s.dwarfId, s.displayName, s.departed])).toEqual([
      [DAIN, 'Dáin', false],
      [THRAIN, 'Thráin', true],
      [NORI, 'Nori', false]
    ])
    // Each speaker carries its own stored rows only, oldest first for reading; the last one is its
    // last timed entry ("last · <time>").
    const [dain, thrain, nori] = view.speakers
    expect(dain?.messages.map((m) => m.text)).toEqual([
      'dain message 1',
      'dain message 2',
      'dain message 3'
    ])
    expect(dain?.messages.at(-1)?.providerTime).toBe(T0 + 3)
    expect(thrain?.messages.map((m) => [m.text, m.dwarfId])).toEqual([
      ['thrain message 4', THRAIN],
      ['thrain message 5', THRAIN]
    ])
    expect(thrain?.messages.at(-1)?.providerTime).toBe(T0 + 5)
    // A dwarf with no stored row has no messages ("no messages"): nothing is read from anywhere else.
    expect(nori?.messages).toEqual([])
    // Items are MessageView: the stored row without sourceKey, origin and askId (06 §0.2).
    for (const message of [...(dain?.messages ?? []), ...(thrain?.messages ?? [])]) {
      expect(Object.keys(message).sort()).toEqual(
        ['attachments', 'createdAt', 'dwarfId', 'id', 'providerTime', 'role', 'text'].sort()
      )
    }
  })

  it('[US-MINE-006.AC02] a mine with no dwarf ever recorded has no speakers', () => {
    const { c, fakeCrew, history } = setUp()
    c.commands.ingest(STRANGER, [observed('stranger', 1)], 'transcript')
    const EMPTY = id(0x12) as MineId

    expect(history.mineHistory(EMPTY)).toEqual({ mineId: EMPTY, speakers: [] })
    // The crew was asked, departed dwarfs included: nobody, present or gone, ever worked there.
    expect(fakeCrew.calls).toEqual([{ mineId: EMPTY, opts: { includeDeparted: true } }])
  })

  it('[US-MINE-006.AC03] an undelivered last message is returned with its failed delivery, read-only', () => {
    const { c, history } = setUp([CREW[0]!])
    c.commands.ingest(
      DAIN,
      range(1, 2).map((n) => observed('dain', n)),
      'transcript'
    )
    c.clock.advance(60_000)
    const failed = c.log.seedFailedRow(DAIN, 'are the tests green?', { kind: 'session-closed' })

    const [dain] = history.mineHistory(MINE).speakers
    const last = dain?.messages.at(-1)

    expect(last?.id).toBe(failed)
    expect(last?.text).toBe('are the tests green?')
    expect(last?.delivery).toMatchObject({
      messageId: failed,
      phase: 'failed',
      failure: { kind: 'session-closed' }
    })
    // Read-only: a MessageView has no Retry or Copy affordance, only the stored row and its delivery.
    expect(Object.keys(last ?? {}).sort()).toEqual(
      [
        'attachments',
        'createdAt',
        'delivery',
        'dwarfId',
        'id',
        'providerTime',
        'role',
        'text'
      ].sort()
    )
  })

  it('[ADR-007, NFR-PERF-08] a speaker never carries more than the 50 stored rows, the same rows the feed pages', () => {
    const { c, history } = setUp([CREW[0]!])
    // 60 rows written without the ingest trim, so the log holds more than the retention keeps.
    c.runner.inTransaction(() =>
      c.log.append(
        DAIN,
        range(1, 60).map((n) => observed('dain', n)),
        'transcript'
      )
    )
    const feed = new ConversationFeedQueries({ log: c.log }).feed(DAIN)

    const [dain] = history.mineHistory(MINE).speakers

    expect(dain?.messages).toHaveLength(50)
    expect(dain?.messages).toEqual([...feed.messages].reverse())
    expect(dain?.messages[0]?.text).toBe('dain message 11')
    expect(dain?.messages.at(-1)?.text).toBe('dain message 60')
  })
})
