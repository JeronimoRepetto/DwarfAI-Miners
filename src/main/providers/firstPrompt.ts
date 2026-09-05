import type { FsLike } from '../adapters/fsLike'
import type { FeedExtractor } from './feedWindow'

/**
 * The opening prompt of one session, read from the START of its transcript
 * (#191).
 *
 * Every other transcript read in this app takes a TAIL, because what the panel
 * draws is the latest words. This one exists for the opposite question: which
 * dwarf on the board is the session the Add Panel just launched. The launch
 * left evidence rather than an id — the exact prompt it wrote to that child's
 * stdin — and the provider recorded that prompt as the first thing a human
 * said in the session. So the receipt is at the file's head, and in a session
 * of any length the poll's tail window will never contain it.
 *
 * ## Read once, off the poll, never on it
 *
 * A head read is not free and it answers a question that is asked once per
 * launch, so nothing here rides the 2-second loop. The caller
 * (LaunchReceiptRegistry) reads a candidate dwarf at most a handful of times,
 * stops the moment the session has said anything at all, and never asks again
 * about a dwarf it has already read.
 *
 * ## Nothing read here is ever shown
 *
 * The text comes back RAW, deliberately unlike `Provider.feed`, which redacts
 * every message on the way to the renderer. This string is compared in main
 * against the prompt main itself sent and is then dropped; it does not cross
 * the wire, so redacting it would only guarantee the comparison fails for
 * anyone whose prompt happens to contain what a redactor rewrites.
 */

/**
 * How much of a transcript's head one read asks for.
 *
 * A prompt is capped at MAX_DWARF_TEXT_CHARS and the providers write the first
 * human turn within the first few records, so this is slack rather than a
 * measurement — wide enough that a verbose session preamble cannot push the
 * opening prompt out of the window, narrow enough that a mistaken read of a
 * huge transcript costs one bounded page.
 */
export const FIRST_PROMPT_HEAD_BYTES = 256 * 1024

/** How a provider finds the opening human turn in a window of its own store. */
export type FirstPromptFinder = (headText: string) => string | undefined

/**
 * The head window holds however many messages fit in its bytes, and the
 * extractors bound by the LAST `limit` of them — the opposite end from the one
 * being looked for. So the count is left unbounded and the BYTES are the bound.
 */
const EVERY_MESSAGE_IN_THE_WINDOW = Number.MAX_SAFE_INTEGER

/**
 * A finder built from a provider's own feed extractor: the first message in
 * the window that a person sent. Suits a provider whose extractor already
 * knows which records are a human's and which are the harness talking to
 * itself; a provider whose store needs a different reading writes its own.
 */
export function firstUserMessageIn(extract: FeedExtractor): FirstPromptFinder {
  return (headText) =>
    extract(headText, EVERY_MESSAGE_IN_THE_WINDOW).find((message) => message.role === 'user')?.text
}

/**
 * The opening prompt of the transcript at `path`, or undefined.
 *
 * Undefined covers two different facts and the caller must treat them as one:
 * this session has not recorded a human turn YET, and this transcript could
 * not be read at all. Neither is proof the dwarf belongs to somebody else, so
 * neither may be recorded as a mismatch — a launch whose session is still
 * writing its first record is the ordinary case, not an error. A missing file
 * answers rather than throwing for the same reason: these reads are scheduled
 * against a board that is already a moment old, and there is no caller left to
 * catch a rejection by the time one runs.
 */
export async function readFirstPrompt(
  fs: FsLike,
  path: string,
  find: FirstPromptFinder,
  headBytes: number = FIRST_PROMPT_HEAD_BYTES
): Promise<string | undefined> {
  try {
    return find(await fs.readTextHead(path, headBytes))
  } catch {
    return undefined
  }
}
