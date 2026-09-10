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

/**
 * How many tool-call rows one trimmed feed may carry, however long the run
 * that produced them (#359).
 *
 * `trimFeed` below bounds the TEXTS, which is what a feed's `limit` was always
 * a count of — and on its own that makes the answer unbounded, because the run
 * of tool calls after the last reply is carried whole and a build-and-fix loop
 * writes hundreds of them. This wire rides the panel's own read, so it gets a
 * ceiling of its own rather than sharing the text count: a number high enough
 * that an ordinary turn's calls all arrive, low enough that a session that has
 * run tools all afternoon costs a bounded read and a bounded IPC payload.
 *
 * Not a display rule. The panel folds a run into one disclosure whatever its
 * length (#294), so this is never the reason a run looks short.
 */
export const FEED_ACTIVITY_LIMIT = 200

/** How a provider turns one transcript window into messages. */
export type FeedExtractor = (tailText: string, limit: number) => FeedMessage[]

/** How many of these rows are something SAID rather than a tool call (#359). */
export function textCount(rows: readonly FeedMessage[]): number {
  return rows.reduce((count, row) => (row.activity === undefined ? count + 1 : count), 0)
}

/**
 * The last `limit` things SAID in one feed, with the tool calls between them
 * carried — the one rule all three extractors trim by (#359).
 *
 * A feed's `limit` has always been a count of messages: "the latest 50 per
 * dwarf", "twelve for the message panel". Since #240 the extractors also push
 * one row per tool call into that same list, and a plain `slice(-limit)` spent
 * the whole window on them — twelve tool calls after the agent's last reply
 * left the panel with twelve activity rows and not one word, so it drew a
 * single folded run and nothing said. Twelve is a count of things said.
 *
 * So the anchor is the `limit`-th newest text, and everything from it to the
 * end of the list is kept: the calls between two kept replies, and the
 * trailing run after the last one, are that conversation's own work. Activity
 * OLDER than the anchor is dropped — it belongs to a reply this feed no longer
 * shows, and carrying it would attach one turn's work to another's words.
 *
 * `activityLimit` then bounds the calls on their own, dropping the oldest
 * first and never a text: the two counts are independent because they answer
 * two different questions, "how much conversation" and "how much of one
 * working stretch" (see FEED_ACTIVITY_LIMIT).
 *
 * A feed with no text at all is not a feed with nothing to show — a window
 * that holds only work still draws its run — so it keeps the newest
 * `activityLimit` calls rather than answering empty.
 */
export function trimFeed(
  rows: readonly FeedMessage[],
  limit: number,
  activityLimit = FEED_ACTIVITY_LIMIT
): FeedMessage[] {
  if (limit <= 0) return []
  let seen = 0
  let anchor = 0
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index]!.activity !== undefined) continue
    seen++
    if (seen === limit) {
      anchor = index
      break
    }
  }
  const kept = rows.slice(anchor)
  let surplus = kept.length - textCount(kept) - activityLimit
  if (surplus <= 0) return kept
  // Oldest activity first, so the newest of a long run is what survives.
  return kept.filter((row) => {
    if (row.activity === undefined || surplus <= 0) return true
    surplus--
    return false
  })
}

/**
 * One walk's answer: the messages, and whether the read behind them reached
 * the transcript's own start (#227).
 */
export interface FeedWindowRead {
  messages: FeedMessage[]
  /**
   * True when the window that produced `messages` came back shorter than the
   * bytes it asked for — proof the whole file was in hand and no wider step
   * could have found anything earlier. False when the widest step tried still
   * filled completely and `messages` still held fewer than `limit` texts: the file
   * outgrows `FEED_WINDOW_CEILING_BYTES`, and the walk stopped there rather
   * than reading the rest of it. There is no third value here — the walk
   * always reads at least one window and always knows which of the two
   * happened — but the wire type this feeds (`MineHistorySpeaker.reachedStart`
   * in `contracts.ts`) stays optional for a source that cannot say.
   */
  reachedStart: boolean
}

/**
 * The walk both `readFeedWindow` and `readFeedWindowWithReachedStart` share.
 * Escalates while the window came up short of `limit` TEXTS and the file
 * filled it. Texts rather than rows since #359: an extractor also publishes
 * one row per tool call (#240), so counting rows let twelve tool calls satisfy
 * a request for twelve messages inside the first step — the walk stopped on a
 * window holding no words at all, which is exactly the guarantee #188 and #215
 * bought. The cost is that a session whose whole window is tool output escalates
 * to the ceiling rather than stopping early, which is the read those two issues
 * already argue for.
 *
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
async function walkFeedWindow(
  fs: FsLike,
  path: string,
  limit: number,
  extract: FeedExtractor,
  steps: readonly number[]
): Promise<FeedWindowRead> {
  let messages: FeedMessage[] = []
  let reachedStart = false
  for (const bytes of steps) {
    const tail = await fs.readTextTail(path, bytes)
    messages = extract(tail, limit)
    reachedStart = Buffer.byteLength(tail, 'utf8') < bytes
    if (textCount(messages) >= limit || reachedStart) break
  }
  return { messages, reachedStart }
}

/**
 * The latest `limit` things said in one transcript, with the tool calls
 * between them (see `trimFeed`), reading only as far back as that many need.
 * See `walkFeedWindow` for how the walk itself works.
 *
 * Kept at exactly this signature for its two live callers — `ClaudeProvider.feed`
 * and `CodexProvider.feed` — which never needed the reached-start fact and
 * should not have to change to keep not needing it (#227).
 * `readFeedWindowWithReachedStart` is the sibling that answers it, for the
 * Mine History panel alone.
 */
export async function readFeedWindow(
  fs: FsLike,
  path: string,
  limit: number,
  extract: FeedExtractor,
  steps: readonly number[] = FEED_WINDOW_STEPS
): Promise<FeedMessage[]> {
  return (await walkFeedWindow(fs, path, limit, extract, steps)).messages
}

/**
 * Same walk as `readFeedWindow`, with the one fact it used to throw away: did
 * the read reach the transcript's own start, or did it stop at the ceiling
 * with more file still behind it (#227)? The Mine History panel is the one
 * caller that needs to say so; nothing else does.
 */
export async function readFeedWindowWithReachedStart(
  fs: FsLike,
  path: string,
  limit: number,
  extract: FeedExtractor,
  steps: readonly number[] = FEED_WINDOW_STEPS
): Promise<FeedWindowRead> {
  return walkFeedWindow(fs, path, limit, extract, steps)
}
