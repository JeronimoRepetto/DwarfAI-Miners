// The MessageLog conformance suite (16 §4.6 `runMessageLogContract`; 16 §2.8; 17 §1.3): run on the
// in-memory double and on the SQLite adapter. ISSUE-098's cases: one row per source key whatever
// path delivers it, a dropped record keeps its key and writes no row, an echo merges into its
// waiting DwarfAI row, pages are newest first and per dwarf, and every write runs inside the
// caller's transaction. ISSUE-105's cap cases: at most `MESSAGES_PER_DWARF` stored rows per
// dwarf, every role counted, a `sending` row kept, a trimmed key never re-inserted, one dwarf's
// trim never touching another's rows. The `request_id` case (ISSUE-166) is added by its issue.
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { MessageLog } from '../ports/messageLog'

export interface MessageLogSubject {
  log: MessageLog
  /** Two dwarfs that exist in the subject's store (the SQLite half seeds their rows). */
  dwarfIds: readonly [DwarfId, DwarfId]
  /** The instant the subject's clock reads (stamps `createdAt`). */
  now: Instant
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** A DwarfAI-sent row of `dwarfId` waiting for the echo `correlation` (written by send later). */
  seedWaitingRow(dwarfId: DwarfId, correlation: string, text: string): MessageId
  /** A DwarfAI-sent person row of `dwarfId` whose delivery is `sending`, stamped `now`. */
  seedSendingRow(dwarfId: DwarfId, text: string): MessageId
  /** A delivered "Answers:" record of `dwarfId`, stamped `now`. */
  seedAnswersRecord(dwarfId: DwarfId, text: string): MessageId
  /** The claimed key, with the row it points at, or null when the key was never seen. */
  keyOf(sourceKey: string): { dwarfId: DwarfId; messageId: MessageId | null } | null
  /** How many message rows the dwarf has. */
  rowCount(dwarfId: DwarfId): number
  /** The ids of the dwarf's message rows. */
  rowIds(dwarfId: DwarfId): MessageId[]
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

/** Every role a provider entry can carry (15 §1.2), cycled so the cap counts each of them. */
const ROLES: ConversationEntry['role'][] = ['person', 'dwarf', 'system-line']

const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-1:event-${n}`,
  role: 'dwarf',
  text: `message ${n}`,
  providerTime: null,
  ...extra
})

export function runMessageLogContract(
  makeSubject: () => MessageLogSubject | Promise<MessageLogSubject>
): void {
  describe('MessageLog contract', () => {
    let subject: MessageLogSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    it('[INV-60, ADR-006] the same sourceKey appended from two paths inserts one row and reports inserted 1 then 0', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const live = entry(1, { role: 'person', text: 'hello', providerTime: 1_000 })
      const fromTranscript = { ...live }

      const first = s.inTransaction(() => s.log.append(dwarf, [live], 'live-stream'))
      const second = s.inTransaction(() => s.log.append(dwarf, [fromTranscript], 'transcript'))

      expect(first.inserted).toBe(1)
      expect(first.appended).toEqual([
        {
          id: expect.any(String),
          dwarfId: dwarf,
          sourceKey: live.sourceKey,
          role: 'person',
          text: 'hello',
          attachments: [],
          origin: 'live-stream',
          providerTime: 1_000,
          createdAt: s.now
        }
      ])
      expect(second).toEqual({ inserted: 0, appended: [] })
      expect(s.rowCount(dwarf)).toBe(1)
      expect(s.keyOf(live.sourceKey)).toEqual({ dwarfId: dwarf, messageId: first.appended[0]?.id })
      // The page holds the stored row itself (16 §4.6 as amended, ISSUE-103).
      expect(s.log.page(dwarf, {})).toEqual(first.appended)
    })

    it('[INV-60] a dropped record claims its key with no message row, and a later replay of that key inserts nothing', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const controlPlane = entry(1, { controlPlane: true, text: 'Warmup' })
      const handoffEcho = entry(2, { handoffEcho: true, role: 'person' })

      const dropped = s.inTransaction(() =>
        s.log.append(dwarf, [controlPlane, handoffEcho], 'transcript')
      )
      // A replay of the same keys, even one that lost the flags, finds them claimed.
      const replay = s.inTransaction(() => s.log.append(dwarf, [entry(1), entry(2)], 'live-stream'))

      expect(dropped).toEqual({ inserted: 0, appended: [] })
      expect(replay).toEqual({ inserted: 0, appended: [] })
      expect(s.keyOf(controlPlane.sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })
      expect(s.keyOf(handoffEcho.sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })
      expect(s.rowCount(dwarf)).toBe(0)
      expect(s.log.page(dwarf, {})).toEqual([])
    })

    it('[INV-60, ADR-007] a provider echo of a waiting DwarfAI row is merged into it and its key points at that row', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const waiting = s.seedWaitingRow(dwarf, 'send-request-7', 'hello')
      const echo = entry(1, { role: 'person', text: 'hello', echoOf: 'send-request-7' })
      // The same correlation on another dwarf's row never merges across dwarfs.
      const elsewhere = entry(2, { role: 'person', text: 'hello', echoOf: 'send-request-8' })
      s.seedWaitingRow(other, 'send-request-8', 'hello')

      const merged = s.inTransaction(() => s.log.append(dwarf, [echo, elsewhere], 'live-stream'))

      expect(merged.inserted).toBe(1)
      expect(merged.appended.map((m) => m.sourceKey)).toEqual([elsewhere.sourceKey])
      expect(s.keyOf(echo.sourceKey)).toEqual({ dwarfId: dwarf, messageId: waiting })
      expect(s.rowCount(dwarf)).toBe(2)
      expect(s.rowCount(other)).toBe(1)
    })

    it('[INV-60, ADR-007] an uncorrelated transcript echo of typed text merges into the oldest waiting row with that exact text, once', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      // The same text typed twice: two waiting rows, each merged by one echo, oldest first.
      const first = s.seedWaitingRow(dwarf, 'typed:relay-1', 'hello')
      const second = s.seedWaitingRow(dwarf, 'typed:relay-2', 'hello')
      s.seedWaitingRow(other, 'typed:relay-3', 'hello')
      const echo = (n: number) => entry(n, { role: 'person', text: 'hello', providerTime: s.now })

      const firstEcho = s.inTransaction(() => s.log.append(dwarf, [echo(1)], 'transcript'))
      const secondEcho = s.inTransaction(() => s.log.append(dwarf, [echo(2)], 'transcript'))
      // A third echo finds no waiting row left: it is the person's own message.
      const third = s.inTransaction(() => s.log.append(dwarf, [echo(3)], 'transcript'))
      // The same text from a live stream is never merged by text: it carries its correlation.
      const live = s.inTransaction(() => s.log.append(other, [echo(4)], 'live-stream'))

      expect(firstEcho).toEqual({ inserted: 0, appended: [] })
      expect(secondEcho).toEqual({ inserted: 0, appended: [] })
      expect(s.keyOf(echo(1).sourceKey)).toEqual({ dwarfId: dwarf, messageId: first })
      expect(s.keyOf(echo(2).sourceKey)).toEqual({ dwarfId: dwarf, messageId: second })
      expect(third.inserted).toBe(1)
      expect(live.inserted).toBe(1)
      expect(s.rowCount(dwarf)).toBe(3)
      expect(s.rowCount(other)).toBe(2)
    })

    it('[ADR-007] page returns the newest rows first and never a row of another dwarf', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const oldest = entry(1, { providerTime: s.now - 3_000 })
      const newest = entry(2, { providerTime: s.now + 5_000 })
      const middle = entry(3, { providerTime: s.now - 1_000 })
      // No provider time: it sorts by its createdAt, the subject's now.
      const untimed = entry(4)
      const otherDwarfs = entry(5, { providerTime: s.now + 9_000 })

      const { appended } = s.inTransaction(() =>
        s.log.append(dwarf, [oldest, newest, middle, untimed], 'transcript')
      )
      s.inTransaction(() => s.log.append(other, [otherDwarfs], 'transcript'))
      const untimedId = appended.find((m) => m.sourceKey === untimed.sourceKey)?.id

      const keys = (req: Parameters<MessageLog['page']>[1]) =>
        s.log.page(dwarf, req).map((e) => e.sourceKey)
      expect(keys({})).toEqual([
        newest.sourceKey,
        untimed.sourceKey,
        middle.sourceKey,
        oldest.sourceKey
      ])
      expect(keys({ limit: 2 })).toEqual([newest.sourceKey, untimed.sourceKey])
      // `before` pages past a row: the rows older than it, newest first.
      expect(keys({ before: untimedId })).toEqual([middle.sourceKey, oldest.sourceKey])
      expect(s.log.page(other, {}).map((e) => e.sourceKey)).toEqual([otherDwarfs.sourceKey])
    })

    it('[ADR-007] page returns every stored row of the dwarf as a Message, DwarfAI-sent rows and answers-records included with their delivery, newest first by sortAt then id', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const { appended } = s.inTransaction(() =>
        s.log.append(
          dwarf,
          [
            entry(1, { providerTime: s.now + 1, role: 'dwarf' }),
            entry(2, { providerTime: s.now - 1, role: 'person' })
          ],
          'transcript'
        )
      )
      // Seeded rows have no provider time: they sort at their createdAt (`now`), ties by id.
      const waiting = s.seedWaitingRow(dwarf, 'send-request-9', 'waiting')
      const sending = s.seedSendingRow(dwarf, 'sending')
      const record = s.seedAnswersRecord(dwarf, 'Answers: yes')
      s.seedSendingRow(other, 'elsewhere')
      const [newer, older] = appended

      const page = s.log.page(dwarf, {})
      expect(page.map((m) => m.id)).toEqual([newer?.id, record, sending, waiting, older?.id])
      expect(page[0]).toEqual(newer)
      expect(page.map((m) => [m.role, m.origin, m.text])).toEqual([
        ['dwarf', 'transcript', 'message 1'],
        ['answers-record', 'dwarfai', 'Answers: yes'],
        ['person', 'dwarfai', 'sending'],
        ['person', 'dwarfai', 'waiting'],
        ['person', 'transcript', 'message 2']
      ])
      const sendingRow = page.find((m) => m.id === sending)
      expect(sendingRow?.sourceKey).toBeNull()
      expect(sendingRow?.delivery).toEqual({
        messageId: sending,
        dwarfId: dwarf,
        kind: 'message',
        phase: 'sending',
        attempts: 1,
        phaseAt: s.now
      })
      expect(page.find((m) => m.id === record)?.delivery).toMatchObject({
        kind: 'answers-record',
        phase: 'delivered'
      })
      expect(page.find((m) => m.id === waiting)?.delivery).toBeUndefined()
      // `before` and `limit` page over the same rows.
      expect(s.log.page(dwarf, { before: sending, limit: 1 }).map((m) => m.id)).toEqual([waiting])
      expect(s.log.page(dwarf, { before: waiting }).map((m) => m.id)).toEqual([older?.id])
    })

    it('[ADR-007] append outside an open transaction throws HostInvariantError', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds

      expect(() => s.log.append(dwarf, [entry(1)], 'live-stream')).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.log.append(dwarf, [entry(2)], 'live-stream')
          throw new CallerFailure('the caller failed after appending')
        })
      ).toThrow(CallerFailure)

      expect(s.keyOf(entry(1).sourceKey)).toBeNull()
      expect(s.keyOf(entry(2).sourceKey)).toBeNull()
      expect(s.rowCount(dwarf)).toBe(0)
    })

    // Entries `from`..`to` of `dwarf`, each one millisecond newer than the last and newer than every
    // seeded row (seeds are stamped `now`), so the oldest is always the lowest `n`.
    const timed = (s: MessageLogSubject, from: number, to: number, roles = ROLES) =>
      Array.from({ length: to - from + 1 }, (_, i) =>
        entry(from + i, {
          providerTime: s.now + from + i,
          role: roles[(from + i) % roles.length] ?? 'dwarf'
        })
      )

    const appendAndTrim = (
      s: MessageLogSubject,
      dwarf: DwarfId,
      entries: ConversationEntry[],
      origin: 'live-stream' | 'transcript' = 'live-stream'
    ) =>
      s.inTransaction(() => {
        const result = s.log.append(dwarf, entries, origin)
        s.log.trim(dwarf, MESSAGES_PER_DWARF)
        return result
      })

    it('[INV-61, ADR-007] the 51st stored message of a dwarf trims its oldest; every role counts, answers-record rows included', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const record = s.seedAnswersRecord(dwarf, 'Answers: yes')

      // The record and 49 messages of every provider role: 50 rows, nothing to trim.
      appendAndTrim(s, dwarf, timed(s, 1, 49))
      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.rowIds(dwarf)).toContain(record)

      // The 51st row trims the oldest, which is the answers-record.
      appendAndTrim(s, dwarf, timed(s, 50, 50))
      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.rowIds(dwarf)).not.toContain(record)

      // The next one trims the oldest message; its key stays, pointing at no row.
      appendAndTrim(s, dwarf, timed(s, 51, 51))
      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.keyOf(entry(1).sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })
      expect(s.keyOf(entry(2).sourceKey)?.messageId).toEqual(expect.any(String))
      expect(s.log.page(dwarf, {}).map((e) => e.sourceKey)).toEqual(
        timed(s, 2, 51)
          .reverse()
          .map((e) => e.sourceKey)
      )
    })

    it('[INV-61] a sending row is kept by the trim even when it is the oldest row of its dwarf', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const sending = s.seedSendingRow(dwarf, 'still being handed over')

      appendAndTrim(s, dwarf, timed(s, 1, 50))

      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.rowIds(dwarf)).toContain(sending)
      expect(s.keyOf(entry(1).sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })
    })

    it("[INV-61] a trimmed message's key blocks re-insertion from a replay", async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      appendAndTrim(s, dwarf, timed(s, 1, 51))
      expect(s.keyOf(entry(1).sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })

      // The same record again, from the other path, even newer than every stored row.
      const replay = appendAndTrim(
        s,
        dwarf,
        [entry(1, { providerTime: s.now + 1_000 })],
        'transcript'
      )

      expect(replay).toEqual({ inserted: 0, appended: [] })
      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.keyOf(entry(1).sourceKey)).toEqual({ dwarfId: dwarf, messageId: null })
    })

    it("[INV-61] trimming one dwarf never touches another dwarf's rows", async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      // The other dwarf's rows are the oldest of the store.
      const others = [0, 1, 2].map((n) =>
        entry(100 + n, { providerTime: s.now - 10_000 + n, role: 'person' })
      )
      appendAndTrim(s, other, others)

      appendAndTrim(s, dwarf, timed(s, 1, 55))

      expect(s.rowCount(dwarf)).toBe(50)
      expect(s.rowCount(other)).toBe(3)
      expect(others.map((e) => s.keyOf(e.sourceKey)?.messageId)).toEqual([
        expect.any(String),
        expect.any(String),
        expect.any(String)
      ])
    })

    it('[INV-61] trim refuses any keep but MESSAGES_PER_DWARF and runs only inside the caller transaction', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      appendAndTrim(s, dwarf, timed(s, 1, 51))

      expect(() => s.log.trim(dwarf, MESSAGES_PER_DWARF)).toThrow(HostInvariantError)
      for (const keep of [0, 49, 51]) {
        expect(() => s.inTransaction(() => s.log.trim(dwarf, keep))).toThrow(HostInvariantError)
      }
      expect(s.rowCount(dwarf)).toBe(50)
    })

    it('[ADR-007] an entry over 64 KiB is refused and its batch leaves nothing in the caller transaction', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const tooLong = entry(2, { text: 'x'.repeat(65_537) })

      expect(() =>
        s.inTransaction(() => s.log.append(dwarf, [entry(1), tooLong], 'live-stream'))
      ).toThrow()

      expect(s.keyOf(entry(1).sourceKey)).toBeNull()
      expect(s.keyOf(tooLong.sourceKey)).toBeNull()
      expect(s.rowCount(dwarf)).toBe(0)
    })
  })
}
