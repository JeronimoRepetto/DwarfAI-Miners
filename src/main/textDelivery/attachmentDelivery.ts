/**
 * Turning a message's attachments into what each of the two channels that can
 * carry one actually takes (#408).
 *
 * Both shapes here are 2026-09-16's measurement rather than a design — see
 * `docs/console-hosting.md` §6:
 *
 * - **A console** takes a path inside bracketed-paste markers. An IMAGE path so
 *   wrapped makes the receiving CLI attach the image itself; any other path
 *   arrives as ordinary text, and the session opens it with its own tools. Both
 *   travel the same way, which is why there is one builder and not two.
 * - **A held session** takes content blocks, so an image travels as its own
 *   bytes with no console involved at all. A non-image gets the same promise as
 *   on the console — its path, named — rather than a document block nobody has
 *   measured this route accepting.
 *
 * What both refuse is a partial message. One unreadable image takes the whole
 * send down, because a ✓ beside half of somebody's files is the exact
 * dishonesty this feature exists to avoid.
 */
import { toConsoleLine } from './sendKeys'
import type { DwarfAttachment } from '../domain/types'

/**
 * The VT markers a terminal wraps a dropped path in.
 *
 * So a drag onto a terminal and this app's delivery are the same gesture: the
 * CLI attaches the file because the path arrived BETWEEN these, read as the
 * person's own input, which is also why a project-scoped tool permission does
 * not gate it and why the same path sent as plain text stays text.
 */
export const BRACKETED_PASTE_START = '[200~'
export const BRACKETED_PASTE_END = '[201~'

/** The chunk that submits — a carriage return, in a call of its own (#404). */
const ENTER_CHUNK = '\r'

/** How a held session is told about a file it will not receive the bytes of. */
export const ATTACHED_FILE_PREFIX = 'Attached file: '

/**
 * The chunk list for one console message, for `buildConsoleInputSequenceCommand`.
 *
 * Attachments first and the words after them, which is the order measured to
 * work and the order the composer already draws — chips above the input. Enter
 * is last and alone: measured at 0 ms between the calls, every paste attached
 * and none submitted, so the pause the builder puts between chunks is doing
 * real work here rather than carrying a margin.
 *
 * Never emits an empty chunk, which the builder refuses outright: a message may
 * be only files, and trimmed-to-nothing words are not a chunk.
 */
export function consoleChunksFor(
  text: string,
  attachments: readonly DwarfAttachment[],
  pressEnter: boolean
): string[] {
  const words = toConsoleLine(text)
  return [
    ...attachments.map(
      (attachment) => `${BRACKETED_PASTE_START}${attachment.path}${BRACKETED_PASTE_END}`
    ),
    ...(words === '' ? [] : [words]),
    ...(pressEnter ? [ENTER_CHUNK] : [])
  ]
}

/** What one image's bytes are, once main has read them. Null when it could not. */
export type AttachmentReader = (
  path: string
) => Promise<{ base64: string; mediaType: string } | null>

/** The Anthropic content-block shapes a held session's user message can carry. */
export type HeldContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** What a held session's `send` takes: a plain string, or blocks. */
export type HeldMessageContent = string | readonly HeldContentBlock[]

/**
 * The content one held-session message carries, or null when it cannot be built.
 *
 * A message with no attachments stays a plain STRING rather than a one-element
 * block array, so nothing that worked before #408 changes shape on the wire to
 * the SDK — a regression here would be invisible in a test that only checked
 * the text.
 *
 * Null is the all-or-nothing rule: one image whose bytes will not read takes
 * the whole message down, words included. Sending the rest would leave the
 * person looking at a ✓ for a message their session never fully received.
 */
export async function heldContentFor(
  text: string,
  attachments: readonly DwarfAttachment[],
  read: AttachmentReader
): Promise<HeldMessageContent | null> {
  if (attachments.length === 0) return text

  const blocks: HeldContentBlock[] = []
  const named: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') {
      named.push(`${ATTACHED_FILE_PREFIX}${attachment.path}`)
      continue
    }
    const bytes = await read(attachment.path)
    if (bytes === null) return null
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: bytes.mediaType, data: bytes.base64 }
    })
  }

  const words = [...named, ...(text === '' ? [] : [text])].join('\n')
  return words === '' ? blocks : [...blocks, { type: 'text', text: words }]
}
