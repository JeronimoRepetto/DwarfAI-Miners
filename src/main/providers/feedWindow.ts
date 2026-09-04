import type { FsLike } from '../adapters/fsLike'
import type { FeedMessage } from '../domain/types'

/**
 * Reading a bounded window of one transcript, wide enough for the number of
 * messages that were actually asked for (issues #215, #188).
 *
 * Every feed in this app asks for a COUNT — "the latest 50 messages" per
 * dwarf, twelve for the message panel — and every one of them used to get the
 * last N messages of a fixed 256 KiB byte tail. Two windows in series with the
 * narrower one first, and the narrow one is a byte count over a file whose
 * bytes are overwhelmingly tool output: a real 256 KB tail held **one** human
 * text line (docs/provider-formats.md §1.6), and the live feed measured 8
 * messages in 256 KB against 65 in 2 MB of the same transcript (#188). So for
 * any session longer than a few hundred kilobytes the first message was
 * outside the window by construction, not by chance.
 *
 * This walks the window outwards instead: read the narrowest, and only when it
 * came up short of the count AND the file is longer than it, read wider. The
 * ceiling is the safety net rather than the rule.
 */

/**
 * The windows one feed read walks back through, narrowest first.
 *
 * 256 KiB first because it was the whole window and is enough for the common
 * case — a session whose conversation is near the end of its file costs
 * exactly what it cost before. 2 MiB next because that is the width #188
 * measured 65 messages in, comfortably past the 50 the Mine History panel
 * promises. 8 MiB last, as the bound a transcript that outgrows even that
 * truncates at, so one panel open can never become an unbounded read.
 *
 * A fully escalated read costs 256 KiB + 2 MiB + 8 MiB = 10.25 MiB of reads
 * for a 8 MiB window, because each step re-reads from the end rather than
 * stitching chunks. That is deliberate: the extractors parse the whole window
 * from its start anyway, so stitching would save bytes off disk and no parse,
 * and it only happens for a file that is both long and nearly all tool output.
 *
 * None of this touches the poll. The 2-second loop reads
 * `TRANSCRIPT_TAIL_BYTES` in claudeProvider and does not go through here.
 */
export const FEED_WINDOW_STEPS: readonly number[] = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]

/** The widest read any feed window will ever ask for. */
export const FEED_WINDOW_CEILING_BYTES = FEED_WINDOW_STEPS[FEED_WINDOW_STEPS.length - 1]!

/** How a provider turns one transcript window into messages. */
export type FeedExtractor = (tailText: string, limit: number) => FeedMessage[]

/**
 * The latest `limit` messages of one transcript, reading only as far back as
 * that many messages need.
 *
 * Escalates while the window came up short of `limit` and the file filled it.
 * "Filled it" is measured on the bytes that came back rather than by asking
 * for the file's size: `readTextTail` returns the whole file when the file is
 * smaller than the window, so a short answer already proves the read reached
 * the start and no wider window can find more. A file whose size lands exactly
 * on a step costs one redundant read, which is cheaper than a stat on every
 * transcript to avoid it.
 *
 * Reads are compared in bytes, never in string length: a tail read slices at a
 * byte offset, so a multi-byte transcript's decoded string is shorter than the
 * window it filled, and comparing lengths would call a truncated read complete
 * and stop the walk one step early.
 *
 * `steps` exists so the walk can be proved on a handful of bytes instead of
 * megabyte fixtures; production always takes the default. Errors are left to
 * the caller — both of them already answer for a transcript that went away
 * between the listing and the read, and a walk that swallowed that would
 * report an empty conversation instead.
 */
export async function readFeedWindow(
  fs: FsLike,
  path: string,
  limit: number,
  extract: FeedExtractor,
  steps: readonly number[] = FEED_WINDOW_STEPS
): Promise<FeedMessage[]> {
  let messages: FeedMessage[] = []
  for (const bytes of steps) {
    const tail = await fs.readTextTail(path, bytes)
    messages = extract(tail, limit)
    if (messages.length >= limit) break
    if (Buffer.byteLength(tail, 'utf8') < bytes) break
  }
  return messages
}
