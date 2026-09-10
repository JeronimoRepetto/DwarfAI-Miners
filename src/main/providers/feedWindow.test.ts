import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import type { FeedMessage, FeedPageCursor } from '../domain/types'
import {
  FEED_ACTIVITY_LIMIT,
  FEED_WINDOW_CEILING_BYTES,
  FEED_WINDOW_STEPS,
  feedPageOf,
  parseDwarfFeedPageRequest,
  readFeedPage,
  readFeedWindow,
  readFeedWindowWithReachedStart,
  textCount,
  trimFeed
} from './feedWindow'

/*
 * Issue #215 and #188, which are one defect seen from two panels: a feed asked
 * for a count of MESSAGES and got the last N messages of a byte window that
 * mostly held tool output. Two windows in series with the narrow one first, so
 * a long session's first message was outside by construction.
 *
 * The walk below is what replaces it. The steps are injectable so the walk can
 * be proved on a handful of bytes rather than on megabyte fixtures; one test
 * at the bottom pins the real constants.
 */

const PATH = 'C:\\transcripts\\session.jsonl'

/** A one-line record the extractor below counts, padded to `size` bytes. */
function record(index: number, size = 0): string {
  return `${index}${'.'.repeat(Math.max(0, size - String(index).length))}\n`
}

/**
 * Stand-in for extractClaudeFeed: one message per line, newest last, capped
 * the way both real extractors cap. A partial first line is dropped, exactly
 * as a JSONL parse drops the fragment a byte-offset tail read begins with.
 */
function extractLines(tailText: string, limit: number): FeedMessage[] {
  const feed = tailText
    .split('\n')
    .filter((line) => line !== '')
    .filter((line) => /^\d/.test(line))
    .map((line) => ({ role: 'user' as const, text: line.trim(), timestamp: '' }))
  return feed.slice(-limit)
}

/** FakeFs with its tail reads recorded, so the walk's own steps are visible. */
function spying(fs: FakeFs): { fs: FsLike; reads: () => number[] } {
  const readTextTail = vi.fn(fs.readTextTail.bind(fs))
  return {
    fs: {
      readTextTail,
      readTextHead: fs.readTextHead.bind(fs),
      readJson: fs.readJson.bind(fs),
      listDir: fs.listDir.bind(fs),
      stat: fs.stat.bind(fs),
      exists: fs.exists.bind(fs)
    },
    reads: () => readTextTail.mock.calls.map((call) => call[1] as number)
  }
}

describe('readFeedWindow', () => {
  it('reads the narrowest window alone when it already holds the asked-for count', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, record(1) + record(2) + record(3))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 2, extractLines, [8, 64, 512])
    expect(messages.map((m) => m.text)).toEqual(['2', '3'])
    // The whole point of the walk: a session whose conversation is at the end
    // of the file costs exactly what it costs today.
    expect(reads()).toEqual([8])
  })

  it('walks back through wider windows until the asked-for count is collected', async () => {
    const fake = new FakeFs()
    // 40 bytes of padding per record, so eight of them outrun a 64-byte window
    // and only the widest step can hold five messages.
    fake.addFile(PATH, Array.from({ length: 8 }, (_, index) => record(index, 40)).join(''))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 5, extractLines, [8, 64, 512])
    expect(messages).toHaveLength(5)
    expect(messages.map((m) => m.text.slice(0, 1))).toEqual(['3', '4', '5', '6', '7'])
    expect(reads()).toEqual([8, 64, 512])
  })

  it('stops at the first window the file did not fill, which is the whole file', async () => {
    // Fewer messages than asked for, and no wider window can find more: the
    // file starts inside this one. Escalating anyway would read it twice.
    const fake = new FakeFs()
    fake.addFile(PATH, record(1) + record(2))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 50, extractLines, [8, 64, 512])
    expect(messages.map((m) => m.text)).toEqual(['1', '2'])
    expect(reads()).toEqual([8])
  })

  it('never asks for more than the widest step, however short the count stays', async () => {
    // The ceiling is the safety net, not the rule: a transcript this long
    // truncates rather than turning one panel open into an unbounded read.
    const fake = new FakeFs()
    fake.addFile(PATH, Array.from({ length: 40 }, (_, index) => record(index, 40)).join(''))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 50, extractLines, [8, 64, 512])
    expect(reads()).toEqual([8, 64, 512])
    // 512 bytes of a 1640-byte file: twelve whole records and a fragment,
    // which the extractor drops exactly as a JSONL parse drops it.
    expect(messages).toHaveLength(12)
    expect(messages.at(-1)?.text.slice(0, 2)).toBe('39')
  })

  it('answers the newest messages, not the oldest, at every width', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, Array.from({ length: 6 }, (_, index) => record(index, 40)).join(''))
    const { fs } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 3, extractLines, [8, 64, 512])
    expect(messages.map((m) => m.text.slice(0, 1))).toEqual(['3', '4', '5'])
  })

  it('measures a filled window in bytes, so a multi-byte transcript still escalates', async () => {
    // A tail read slices at a byte offset, so 64 bytes of em dashes decode to
    // a 22-character string. Comparing string lengths would read that as "the
    // file did not fill the window", call the walk complete one step early,
    // and answer one message where five were asked for — the same
    // byte-versus-message confusion these issues are about, one level down.
    const fake = new FakeFs()
    const wide = (index: number): string => `${index}${'—'.repeat(13)}\n`
    fake.addFile(PATH, Array.from({ length: 8 }, (_, index) => wide(index)).join(''))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 5, extractLines, [8, 64, 512])
    expect(reads()).toEqual([8, 64, 512])
    expect(messages.map((m) => m.text.slice(0, 1))).toEqual(['3', '4', '5', '6', '7'])
  })

  it('lets the read fail the way the adapter fails, for a file that is gone', async () => {
    // Both callers already answer for a transcript deleted between the listing
    // and the read; the walk must not swallow that into an empty feed.
    const { fs } = spying(new FakeFs())
    await expect(readFeedWindow(fs, PATH, 50, extractLines, [8])).rejects.toThrow()
  })

  it('starts at the window the poll reads and ends far above it', async () => {
    // The two numbers the issues argue about. The first step is the 256 KiB
    // that was the whole window, so the common case costs what it did; the
    // ceiling is the safety net a session that outgrows it stops at.
    expect(FEED_WINDOW_STEPS[0]).toBe(256 * 1024)
    expect(FEED_WINDOW_CEILING_BYTES).toBe(FEED_WINDOW_STEPS.at(-1))
    expect(FEED_WINDOW_CEILING_BYTES).toBeGreaterThan(256 * 1024)
    // Strictly increasing, or a later step would read no further than an
    // earlier one and the walk would spend a read for nothing.
    for (let index = 1; index < FEED_WINDOW_STEPS.length; index++) {
      expect(FEED_WINDOW_STEPS[index]!).toBeGreaterThan(FEED_WINDOW_STEPS[index - 1]!)
    }
  })
})

/*
 * #227: the walk already knows whether its read reached the file's start —
 * "came back short of what it asked for" (module comment above) is exactly
 * that fact — and used to throw it away. `readFeedWindow` keeps its existing
 * signature for its two live callers (ClaudeProvider.feed, CodexProvider.feed);
 * this sibling answers the same walk with the fact kept, for the Mine History
 * panel alone.
 */
describe('readFeedWindowWithReachedStart', () => {
  it('reports reached-start when the narrowest window already holds the whole file', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, record(1) + record(2))
    const { fs } = spying(fake)

    const result = await readFeedWindowWithReachedStart(fs, PATH, 50, extractLines, [8, 64, 512])
    expect(result.messages.map((m) => m.text)).toEqual(['1', '2'])
    expect(result.reachedStart).toBe(true)
  })

  it('reports not-reached when the widest window filled and still fell short of the count', async () => {
    // Same fixture as "never asks for more than the widest step": 40 records
    // fill every step, and the widest one still holds only twelve of them —
    // there is more file behind it that the walk never read.
    const fake = new FakeFs()
    fake.addFile(PATH, Array.from({ length: 40 }, (_, index) => record(index, 40)).join(''))
    const { fs } = spying(fake)

    const result = await readFeedWindowWithReachedStart(fs, PATH, 50, extractLines, [8, 64, 512])
    expect(result.messages).toHaveLength(12)
    expect(result.reachedStart).toBe(false)
  })

  it('reports reached-start once a middle window fills the file, even after a narrower one came up short', async () => {
    // 8 records of 5 bytes each (48 bytes): too big for the 8-byte step, which
    // still leaves it short of the count, but the 64-byte step holds the whole
    // file — proving the flag reflects the window that actually produced the
    // answer, not just the first one tried.
    const fake = new FakeFs()
    fake.addFile(PATH, Array.from({ length: 8 }, (_, index) => record(index, 5)).join(''))
    const { fs, reads } = spying(fake)

    const result = await readFeedWindowWithReachedStart(fs, PATH, 3, extractLines, [8, 64, 512])
    expect(reads()).toEqual([8, 64])
    expect(result.reachedStart).toBe(true)
  })

  it('still throws the way the adapter throws, for a file that is gone', async () => {
    const { fs } = spying(new FakeFs())
    await expect(readFeedWindowWithReachedStart(fs, PATH, 50, extractLines, [8])).rejects.toThrow()
  })

  it('does not change what readFeedWindow itself reads or returns', async () => {
    // The sibling exists so the two live feed() callers never have to change:
    // proof the plain function still answers exactly the messages it did.
    const fake = new FakeFs()
    fake.addFile(PATH, Array.from({ length: 8 }, (_, index) => record(index, 40)).join(''))
    const { fs: plainFs } = spying(fake)
    const { fs: richFs } = spying(fake)

    const plain = await readFeedWindow(plainFs, PATH, 5, extractLines, [8, 64, 512])
    const rich = await readFeedWindowWithReachedStart(richFs, PATH, 5, extractLines, [8, 64, 512])
    expect(plain).toEqual(rich.messages)
  })
})

/*
 * Issue #359, which is #215 and #188 again after #240 changed what a row is.
 * Twelve is a count of things SAID, and an agent that has run twelve tools
 * since it last spoke used to spend the whole window on activity rows: the
 * panel drew one folded run and no words. So the trim counts texts and carries
 * the tool calls between them.
 */

/** Something said — a prompt or a reply, the rows `limit` counts. */
function said(index: number): FeedMessage {
  return { role: 'assistant', text: `said ${index}`, timestamp: '' }
}

/** One tool call, the row `limit` must stop counting. */
function ran(index: number): FeedMessage {
  return {
    role: 'assistant',
    text: `Ran step ${index}`,
    timestamp: '',
    activity: { kind: 'run', target: `step ${index}` }
  }
}

const texts = (rows: readonly FeedMessage[]): string[] =>
  rows.filter((row) => row.activity === undefined).map((row) => row.text)

const activities = (rows: readonly FeedMessage[]): string[] =>
  rows.filter((row) => row.activity !== undefined).map((row) => row.text)

describe('trimFeed', () => {
  it('keeps every text when a long run of tool calls follows the last one', () => {
    // The reported defect, in one assertion: twenty tool calls after the last
    // reply used to be the whole answer, and both replies were dropped.
    const rows = [said(0), said(1), ...Array.from({ length: 20 }, (_, index) => ran(index))]

    const kept = trimFeed(rows, 12)
    expect(texts(kept)).toEqual(['said 0', 'said 1'])
    expect(activities(kept)).toHaveLength(20)
  })

  it('counts only texts against the limit, dropping activity older than the oldest kept text', () => {
    // Fifteen texts, one tool call between each pair. The twelfth-newest text
    // is the anchor: everything from it to the end is carried, and the
    // activity rows belonging to the three replies before it are not — they
    // are someone else's turn.
    const rows = Array.from({ length: 15 }, (_, index) => [said(index), ran(index)]).flat()

    const kept = trimFeed(rows, 12)
    expect(texts(kept)).toEqual(Array.from({ length: 12 }, (_, index) => `said ${index + 3}`))
    expect(activities(kept)).toEqual(
      Array.from({ length: 12 }, (_, index) => `Ran step ${index + 3}`)
    )
    expect(kept[0]!.text).toBe('said 3')
  })

  it('caps the activity rows on their own, and never at a text’s expense', () => {
    const rows = [said(0), said(1), ...Array.from({ length: 250 }, (_, index) => ran(index))]

    const kept = trimFeed(rows, 12)
    expect(texts(kept)).toEqual(['said 0', 'said 1'])
    expect(activities(kept)).toHaveLength(FEED_ACTIVITY_LIMIT)
    // The newest are the ones kept: the oldest tool calls of the run go first.
    expect(activities(kept).at(-1)).toBe('Ran step 249')
    expect(activities(kept)[0]).toBe(`Ran step ${250 - FEED_ACTIVITY_LIMIT}`)
  })

  it('takes the activity cap as a parameter, so the rule can be proved small', () => {
    const rows = [said(0), ran(0), ran(1), ran(2)]
    expect(trimFeed(rows, 12, 2).map((row) => row.text)).toEqual([
      'said 0',
      'Ran step 1',
      'Ran step 2'
    ])
  })

  it('answers a feed of nothing but tool calls with the newest of them', () => {
    // No text to anchor on is not the same as nothing to show: a session whose
    // window holds only work still draws its folded run.
    const rows = Array.from({ length: 4 }, (_, index) => ran(index))
    expect(trimFeed(rows, 12, 2).map((row) => row.text)).toEqual(['Ran step 2', 'Ran step 3'])
  })

  it('holds a short feed unchanged, exactly as the slice it replaces did', () => {
    const rows = [said(0), ran(0), said(1)]
    expect(trimFeed(rows, 12)).toEqual(rows)
    expect(trimFeed([], 12)).toEqual([])
  })

  it('counts a text as a row with no activity, whichever half of the exchange it is', () => {
    expect(textCount([said(0), ran(0), { role: 'user', text: 'dig', timestamp: '' }])).toBe(2)
    expect(textCount([ran(0), ran(1)])).toBe(0)
  })

  it('bounds the activity rows well above one folded run and well below a wire this app would notice', () => {
    // The cap exists so (1) cannot grow the wire without bound; it is not a
    // display limit, and must stay generous enough that an ordinary tool loop
    // reaches the panel whole.
    expect(FEED_ACTIVITY_LIMIT).toBeGreaterThan(12)
    expect(FEED_ACTIVITY_LIMIT).toBeLessThanOrEqual(500)
  })
})

describe('readFeedWindow past a window of tool calls (#359)', () => {
  /**
   * Stand-in for an extractor since #240: a record ending in `!` is a tool
   * call rather than something said, and the answer is trimmed by the shared
   * rule exactly as all three real extractors trim theirs.
   */
  function extractInterleaved(tailText: string, limit: number): FeedMessage[] {
    const feed = tailText
      .split('\n')
      .filter((line) => /^\d/.test(line))
      .map((line) => line.trim())
      .map((line) =>
        line.endsWith('!')
          ? {
              role: 'assistant' as const,
              text: `Ran ${line}`,
              timestamp: '',
              activity: { kind: 'run' as const, target: line }
            }
          : { role: 'user' as const, text: line, timestamp: '' }
      )
    return trimFeed(feed, limit)
  }

  /** A 20-byte record of something said, and a 6-byte tool call. */
  const spoken = (index: number): string => `${index}${'.'.repeat(18)}\n`
  const toolCall = (index: number): string => `${index}...!\n`

  it('escalates past a window that holds only tool-call rows', async () => {
    // The stop condition #188 and #215 bought, read the way #240 left it: the
    // 64-byte window holds eight rows and not one word, which used to satisfy
    // "eight is more than three" and end the walk on a wordless feed.
    const fake = new FakeFs()
    fake.addFile(
      PATH,
      spoken(0) + spoken(1) + Array.from({ length: 8 }, (_, index) => toolCall(index)).join('')
    )
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 3, extractInterleaved, [8, 64, 512])
    expect(reads()).toEqual([8, 64, 512])
    expect(texts(messages)).toEqual([spoken(0).trim(), spoken(1).trim()])
    expect(activities(messages)).toHaveLength(8)
  })

  it('still stops at the first window that holds the texts asked for', async () => {
    // The escalation above must not become the rule: a conversation at the end
    // of the file costs one read, tool calls beside it or not.
    const fake = new FakeFs()
    fake.addFile(PATH, spoken(0) + spoken(1) + spoken(2) + spoken(3) + toolCall(4))
    const { fs, reads } = spying(fake)

    const messages = await readFeedWindow(fs, PATH, 2, extractInterleaved, [64, 512])
    expect(reads()).toEqual([64])
    expect(texts(messages)).toEqual([spoken(2).trim(), spoken(3).trim()])
    expect(activities(messages)).toEqual(['Ran ' + toolCall(4).trim()])
  })
})

/*
 * Issue #364: the panel showed the newest FEED_LIMIT texts and nothing older,
 * so the beginning of a session was unreachable by scrolling. Raising the
 * number was measured and rejected — at 50 a 19.8 MB transcript cost 3 steps,
 * 10.25 MiB and 30 ms inside a poll loop budgeted at 15 ms median, and at 200
 * the 8 MiB ceiling truncated the answer to 176 texts anyway. So the newest
 * page keeps costing what it costs, and an older one is read only when
 * somebody scrolls back to ask for it.
 *
 * The cursor is CONTENT, never an offset from the end: the poll pushes the
 * watched dwarf's feed again on every reply (#196), so a count from the end
 * names different rows one second later. The drift test at the bottom of this
 * block is the whole reason the cursor has the shape it has.
 */
describe('readFeedPage (#364)', () => {
  /** A 20-byte record of something said, and a 6-byte tool call. */
  const spoken = (index: number): string => `${index}${'.'.repeat(18)}\n`
  const toolCall = (index: number): string => `${index}...!\n`

  /** One said/ran pair per index — 26 bytes each, so windows land predictably. */
  const pairs = (count: number, from = 0): string =>
    Array.from({ length: count }, (_, index) => spoken(from + index) + toolCall(from + index)).join(
      ''
    )

  /**
   * Stand-in for a real extractor, forwarding BOTH counts.
   *
   * The activity cap has to be forwarded since #364: a page read asks the
   * extractor for the window WHOLE and then trims the page's own span itself,
   * and an extractor that ignored the second count would quietly cap the
   * window's activity at 200 and drop the OLDEST tool calls — which are
   * precisely the rows an older page is made of.
   */
  function extractPaged(tailText: string, limit: number, activityLimit?: number): FeedMessage[] {
    const feed = tailText
      .split('\n')
      .filter((line) => /^\d/.test(line))
      .map((line) => line.trim())
      .map((line) =>
        line.endsWith('!')
          ? {
              role: 'assistant' as const,
              text: `Ran ${line}`,
              timestamp: '',
              activity: { kind: 'run' as const, target: line }
            }
          : { role: 'user' as const, text: line, timestamp: '' }
      )
    return trimFeed(feed, limit, activityLimit)
  }

  /** The cursor a panel holding down to `index` would send. */
  const before = (index: number): FeedPageCursor => ({
    timestamp: '',
    text: spoken(index).trim()
  })

  it('answers the texts immediately older than the cursor, with their tool calls', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(8))
    const { fs } = spying(fake)

    const page = await readFeedPage(fs, PATH, 2, extractPaged, before(5), [512])
    // The two texts below the cursor, and the calls between them — including
    // the run after the last of them, which is that turn's own work.
    expect(texts(page.messages)).toEqual([spoken(3).trim(), spoken(4).trim()])
    expect(activities(page.messages)).toEqual([
      'Ran ' + toolCall(3).trim(),
      'Ran ' + toolCall(4).trim()
    ])
    // Five texts precede the cursor and the page spent two of them, so the
    // panel may ask again.
    expect(page.reachedStart).toBe(false)
  })

  it('escalates when the first window held fewer than the limit texts before the cursor', async () => {
    // The 64-byte window reaches back only to the cursor's own neighbourhood:
    // one text below it against the two asked for, and the window filled, so a
    // wider step can still find more.
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(8))
    const { fs, reads } = spying(fake)

    const page = await readFeedPage(fs, PATH, 2, extractPaged, before(7), [64, 512])
    expect(reads()).toEqual([64, 512])
    expect(texts(page.messages)).toEqual([spoken(5).trim(), spoken(6).trim()])
  })

  it('answers the last page reached-start, and a page beyond it empty', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(8))
    const { fs } = spying(fake)

    // Two texts below the cursor and no more: this is the last page.
    const last = await readFeedPage(fs, PATH, 2, extractPaged, before(2), [512])
    expect(texts(last.messages)).toEqual([spoken(0).trim(), spoken(1).trim()])
    expect(last.reachedStart).toBe(true)

    // And the page below the transcript's own first text is empty, still
    // reached-start, so the panel says it once and stops asking.
    const beyond = await readFeedPage(fs, PATH, 2, extractPaged, before(0), [512])
    expect(beyond.messages).toEqual([])
    expect(beyond.reachedStart).toBe(true)
  })

  it('widens for a cursor the narrow window cannot see, rather than calling it missing', async () => {
    // A reader four pages back sends a cursor that is nowhere near the end of
    // the file, and every window is a TAIL: not-found is the ordinary shape of
    // a deep page, so it escalates exactly as a short count does.
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(8))
    const { fs, reads } = spying(fake)

    const page = await readFeedPage(fs, PATH, 2, extractPaged, before(1), [64, 512])
    expect(reads()).toEqual([64, 512])
    expect(texts(page.messages)).toEqual([spoken(0).trim()])
    expect(page.reachedStart).toBe(true)
  })

  it('answers an empty last page for a cursor the whole transcript does not hold', async () => {
    // The whole file is in hand and the row the cursor names is not in it — a
    // stale cursor, or a transcript rewritten under the panel. Nothing is older
    // than a row that is not there, so the honest answer is an empty page that
    // stops the asking rather than a guess at where the reader was.
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(4))
    const { fs } = spying(fake)

    const page = await readFeedPage(
      fs,
      PATH,
      2,
      extractPaged,
      { timestamp: '', text: 'never said' },
      [512]
    )
    expect(page.messages).toEqual([])
    expect(page.reachedStart).toBe(true)
  })

  it('answers a missing cursor without claiming the start, when the file outgrew the ceiling', async () => {
    // Same missing row, but every step filled: there is more file behind the
    // widest window, so the page is empty and the panel must NOT be told it has
    // reached the beginning.
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(40))
    const { fs, reads } = spying(fake)

    const page = await readFeedPage(
      fs,
      PATH,
      2,
      extractPaged,
      { timestamp: '', text: 'never said' },
      [64, 128]
    )
    expect(reads()).toEqual([64, 128])
    expect(page.messages).toEqual([])
    expect(page.reachedStart).toBe(false)
  })

  it('answers the same page for the same cursor after the session speaks again', async () => {
    /*
     * The drift the cursor's shape exists to prevent, and the reason it is not
     * an offset. Four new pairs land at the END of the transcript — which is
     * what every reply does, and what the poll pushes to the panel (#196). An
     * offset counted from the end would slide four texts and answer rows the
     * reader already has, or skip the ones between; content does not move.
     */
    const fake = new FakeFs()
    fake.addFile(PATH, pairs(8))
    const { fs } = spying(fake)

    const first = await readFeedPage(fs, PATH, 2, extractPaged, before(5), [512])

    const grown = new FakeFs()
    grown.addFile(PATH, pairs(8) + pairs(4, 8))
    const { fs: grownFs } = spying(grown)
    const second = await readFeedPage(grownFs, PATH, 2, extractPaged, before(5), [512])

    expect(second.messages).toEqual(first.messages)
    expect(second.reachedStart).toBe(first.reachedStart)
  })

  it('takes the NEWEST of two identical rows, repeating a row rather than skipping one', async () => {
    /*
     * The collision the cursor's doc comment admits to: the same text with the
     * same timestamp twice. Matching the newer one starts the page further
     * forward than the reader's own oldest row, so it repeats conversation
     * already on screen; matching the older one would silently drop everything
     * between the two. A repeat is visible and a gap is not.
     */
    const fake = new FakeFs()
    fake.addFile(PATH, spoken(0) + spoken(1) + spoken(2) + spoken(3) + spoken(4) + spoken(2))
    const { fs } = spying(fake)

    const page = await readFeedPage(fs, PATH, 2, extractPaged, before(2), [512])
    expect(texts(page.messages)).toEqual([spoken(3).trim(), spoken(4).trim()])
  })

  it('asks the extractor for the window whole, so an older page keeps its own tool calls', async () => {
    /*
     * A page read cannot let the extractor trim: the extractors answer the
     * NEWEST `limit` texts, which is the one part of the window a page does not
     * want. This stand-in caps activity at two rows by default, so a read that
     * failed to ask for the window whole would hand the page a span whose
     * oldest tool calls had already been thrown away.
     */
    const capped = (tailText: string, limit: number, activityLimit = 2): FeedMessage[] =>
      extractPaged(tailText, limit, activityLimit)
    const fake = new FakeFs()
    fake.addFile(
      PATH,
      spoken(0) +
        toolCall(0) +
        toolCall(1) +
        toolCall(2) +
        toolCall(3) +
        spoken(1) +
        spoken(2) +
        spoken(3)
    )
    const { fs } = spying(fake)

    const page = await readFeedPage(fs, PATH, 2, capped, before(2), [512])
    expect(texts(page.messages)).toEqual([spoken(0).trim(), spoken(1).trim()])
    expect(activities(page.messages)).toHaveLength(4)
  })

  it('lets the read fail the way the adapter fails, for a file that is gone', async () => {
    const { fs } = spying(new FakeFs())
    await expect(readFeedPage(fs, PATH, 2, extractPaged, before(1), [8])).rejects.toThrow()
  })
})

describe('feedPageOf (#364)', () => {
  it('starts a page at a TEXT, never at activity older than one', () => {
    // The one place a page's rule differs from trimFeed's. trimFeed keeps a
    // leading run because the newest feed has nothing above it to attach the
    // run to; a page does — the run belongs to the page BELOW it, and carrying
    // it here would hand the same rows out twice.
    const rows = [ran(0), said(0), ran(1), said(1)]
    expect(feedPageOf(rows, 3)).toEqual([said(0), ran(1), said(1)])
    expect(trimFeed(rows, 3)).toEqual(rows)
  })

  it('answers nothing for a span with no text in it at all', () => {
    // Unlike a feed, where a window of pure work still draws its run: these
    // calls precede every text this page could anchor on, so they are the next
    // page's, and answering them would repeat them there.
    expect(feedPageOf([ran(0), ran(1)], 12)).toEqual([])
    expect(feedPageOf([], 12)).toEqual([])
    expect(feedPageOf([said(0)], 0)).toEqual([])
  })

  it('bounds a page’s activity on its own, the way every other feed is bounded', () => {
    const rows = [said(0), ...Array.from({ length: 250 }, (_, index) => ran(index))]
    expect(activities(feedPageOf(rows, 12))).toHaveLength(FEED_ACTIVITY_LIMIT)
    expect(feedPageOf(rows, 12, 2).map((row) => row.text)).toEqual([
      'said 0',
      'Ran step 248',
      'Ran step 249'
    ])
  })
})

describe('parseDwarfFeedPageRequest (#364)', () => {
  const cursor = { timestamp: '2026-09-10T08:00:00.000Z', text: 'dig here' }

  it('accepts a dwarf id and a cursor naming something said', () => {
    expect(parseDwarfFeedPageRequest({ dwarfId: 'claude:s1', before: cursor })).toEqual({
      dwarfId: 'claude:s1',
      before: cursor
    })
  })

  it('keeps an empty timestamp, which is a real value a transcript yields', () => {
    // An extractor falls back to '' for a record that carried no timestamp, so
    // a cursor naming such a row has to survive the boundary.
    expect(
      parseDwarfFeedPageRequest({ dwarfId: 'claude:s1', before: { timestamp: '', text: 'dig' } })
    ).toEqual({ dwarfId: 'claude:s1', before: { timestamp: '', text: 'dig' } })
  })

  it.each([
    ['no payload at all', undefined],
    ['a payload that is not an object', 'claude:s1'],
    ['a missing dwarf id', { before: cursor }],
    ['an empty dwarf id', { dwarfId: '', before: cursor }],
    ['a dwarf id that is not a string', { dwarfId: 42, before: cursor }],
    ['no cursor', { dwarfId: 'claude:s1' }],
    ['a cursor that is not an object', { dwarfId: 'claude:s1', before: 'dig here' }],
    [
      'a cursor whose text is empty, which names nothing said',
      { dwarfId: 'claude:s1', before: { timestamp: '', text: '' } }
    ],
    [
      'a cursor whose text is not a string',
      { dwarfId: 'claude:s1', before: { timestamp: '', text: 7 } }
    ],
    [
      'a cursor whose timestamp is not a string',
      { dwarfId: 'claude:s1', before: { timestamp: 7, text: 'dig' } }
    ]
  ])('refuses %s', (_case, payload) => {
    expect(parseDwarfFeedPageRequest(payload)).toBeNull()
  })

  it('carries nothing a caller hung off the request', () => {
    expect(
      parseDwarfFeedPageRequest({
        dwarfId: 'claude:s1',
        before: { ...cursor, role: 'user' },
        limit: 500
      })
    ).toEqual({ dwarfId: 'claude:s1', before: cursor })
  })
})
