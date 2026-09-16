/**
 * What the composer says about a file, and which of a drop's files survive it
 * (#408).
 *
 * The arithmetic is the WIRE's — `refuseAttachment` in `shared/contracts.ts`,
 * which `main/index.ts` runs at the IPC boundary against the same numbers — and
 * is deliberately not repeated here. What this module owns is the half that is
 * the panel's: which sentence the person reads, in the alert row's ink, and
 * which files are still pending afterwards.
 *
 * The design's rule for those sentences: they NAME the limit that refused the
 * file. A bare "that file was refused" sends somebody to guess which of four
 * ceilings they hit, and the guess is usually the wrong one.
 */
import {
  MAX_DWARF_ATTACHMENTS,
  MAX_DWARF_ATTACHMENT_BYTES,
  MAX_DWARF_ATTACHMENTS_TOTAL_BYTES,
  refuseAttachment,
  type Dwarf,
  type DwarfAttachment,
  type DwarfAttachmentPick,
  type DwarfAttachmentRefusal
} from '../../types'

/** Megabytes, for a sentence — the limits are bytes and nobody reads bytes. */
const mb = (bytes: number): number => bytes / (1024 * 1024)

/** The sentence for one refusal, naming the file and the limit that stopped it. */
export function refusalSentence(refusal: DwarfAttachmentRefusal, name: string): string {
  switch (refusal) {
    case 'directory':
      return `"${name}" is a folder. A message carries files, one at a time.`
    case 'unreadable':
      return `"${name}" could not be read, so it was not attached.`
    case 'already-attached':
      return `"${name}" is already attached to this message.`
    case 'too-many':
      return `A message carries at most ${MAX_DWARF_ATTACHMENTS} files, so "${name}" was left off.`
    case 'file-too-large':
      return `"${name}" is larger than the ${mb(MAX_DWARF_ATTACHMENT_BYTES)} MB a single file can be.`
    case 'total-too-large':
      return `"${name}" would take this message past the ${mb(MAX_DWARF_ATTACHMENTS_TOTAL_BYTES)} MB it can carry in total.`
  }
}

/** The last path segment, for a pick main refused before it had a name. */
function nameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

/** What a drop or a picker left the composer holding, and why it stopped. */
export interface AcceptedAttachments {
  attachments: readonly DwarfAttachment[]
  /** The one sentence to show, or null when every file was taken. */
  refusal: string | null
}

/**
 * Fold what main described onto what the composer already holds.
 *
 * Only the FIRST refusal is reported. A drop of five files onto a nearly full
 * composer would otherwise produce five sentences in a row that has space for
 * one, and the person needs the reason it stopped rather than a list.
 *
 * Every file that fits is still kept: a drop is several separate intentions,
 * and discarding the four that were fine because the fifth was too big would
 * make the person do the whole gesture again.
 */
export function acceptAttachments(
  pending: readonly DwarfAttachment[],
  picks: readonly DwarfAttachmentPick[]
): AcceptedAttachments {
  const attachments = [...pending]
  let refusal: string | null = null

  for (const pick of picks) {
    // Defensive: main answers with one or the other. A pick carrying neither is
    // still named rather than dropped in silence — a file that vanishes with no
    // sentence is the failure mode this whole row exists to prevent.
    if (pick.attachment === undefined) {
      refusal ??= refusalSentence(pick.refusal ?? 'unreadable', nameOf(pick.path))
      continue
    }
    const refused = refuseAttachment(pick.attachment, attachments)
    if (refused !== null) {
      refusal ??= refusalSentence(refused, pick.attachment.name)
      continue
    }
    attachments.push(pick.attachment)
  }

  return { attachments, refusal }
}

/**
 * What the panel says when it could not ask main about a file at all.
 *
 * The bridge is the only thing that can fail on that call, and it is the one
 * failure with no filename to name — the point is that the panel does not know
 * what it was handed. Silence would be the worst answer available: a chip that
 * never appears and a sentence nobody wrote is the disappearance this whole row
 * exists to prevent.
 */
export const ATTACH_LOST_CONTACT = 'The panel lost contact with the app, so nothing was attached.'

/** What the attach control says where a file can travel. */
export const ATTACH_HINT = 'Attach images or files to this message.'
/**
 * What it says where one cannot, in the kick hint's idiom: the fact, then the
 * way out.
 *
 * The way out is real and is the one the measurement found — a session's own
 * console takes a file, and a relay or a queue carries a sentence. A dwarf with
 * no channel at all is given no way out, because there is none to name.
 */
export const NO_ATTACH_CHANNEL_HINT =
  "This session's channel carries text only; attach a file from its own console instead."
export const NO_ATTACH_AT_ALL_HINT = "This session can't be written to, so it takes no files."

/** The attach control's title, read off the capability rather than guessed. */
export function attachHint(dwarf: Dwarf): string {
  if (dwarf.capabilities?.attach != null) return ATTACH_HINT
  return dwarf.capabilities?.sendText == null ? NO_ATTACH_AT_ALL_HINT : NO_ATTACH_CHANNEL_HINT
}
