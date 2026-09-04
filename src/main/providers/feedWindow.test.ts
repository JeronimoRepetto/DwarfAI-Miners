import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import type { FeedMessage } from '../domain/types'
import { FEED_WINDOW_CEILING_BYTES, FEED_WINDOW_STEPS, readFeedWindow } from './feedWindow'

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
