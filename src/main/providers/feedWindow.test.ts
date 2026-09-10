import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import type { FeedMessage } from '../domain/types'
import {
  FEED_ACTIVITY_LIMIT,
  FEED_WINDOW_CEILING_BYTES,
  FEED_WINDOW_STEPS,
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
