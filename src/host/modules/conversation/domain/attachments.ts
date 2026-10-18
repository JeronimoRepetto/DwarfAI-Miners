// Attachments as the Host describes them (05 §3.6, 16 §4.6 `AttachmentReader`; 14 B-M28, A-25;
// ADR-019 item 9; NFR-PRIV-04; ISSUE-169). Pure: no I/O, no clock.
//
// - `MAX_ATTACHMENT_BYTES` is the per-file cap of AMENDMENT-1 (OQ-51): 300 000 000 bytes, decimal,
//   the copy "max 300 MB". A file of exactly the cap is accepted; one byte more is `too-large`.
//   There is no count limit and no other size rule under the cap (PO #30, #56; US-MSG-002.AC06).
// - `AttachmentPick` (05; 14 §3 imports it, 05 gives no shape): 14 §8 I-10 fixes it to today's
//   `DwarfAttachmentPick` field names, so A-25 keeps its shape (`[]` + a per-item `refusal`). The
//   Host never reads content, so it never sets `thumbnail`.
// - The three refusals of the port (`too-large`, `unreadable`, `not-a-file`) reach the pick as the
//   today names A-25 already shows (`file-too-large`, `unreadable`, `directory`): package gap
//   (14 and 16 are silent on the mapping), resolved to the only names the KEEP shape has.

/** AMENDMENT-1 (OQ-51): the per-file cap in bytes (decimal, like ADR-026 `LOG_CAP_BYTES`). */
export const MAX_ATTACHMENT_BYTES = 300_000_000

/** Why the `AttachmentReader` refuses a path (16 §4.6). */
export type AttachmentRefusal = 'too-large' | 'unreadable' | 'not-a-file'

/** Today's `DwarfAttachmentKind`: an image gets a preview chip, everything else is a file. */
export type AttachmentKind = 'image' | 'file'

/** The refusals a pick carries (today's `DwarfAttachmentPick.refusal` names the Host can reach). */
export type AttachmentPickRefusal = 'directory' | 'unreadable' | 'file-too-large'

/** One described file: its revalidated path, the name the person sees, its kind and size. */
export interface DescribedAttachment {
  /** The real path the Host resolved and checked: what travels in `TurnInput.attachments`. */
  path: string
  name: string
  kind: AttachmentKind
  bytes: number
}

/** 05 `AttachmentPick` in today's `DwarfAttachmentPick` field names (14 §8 I-10). */
export interface AttachmentPick {
  /** The path as the UI sent it, so the composer can match each pick to what it asked about. */
  path: string
  attachment?: DescribedAttachment
  refusal?: AttachmentPickRefusal
  thumbnail?: string
}

/** Today's image extensions (`DWARF_IMAGE_EXTENSIONS`), matched without case. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const

/** Today's `attachmentKindFor`: the kind a file name shows. */
export function attachmentKindOf(name: string): AttachmentKind {
  const lower = name.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? 'image' : 'file'
}

/** Whether a regular file of `bytes` is over the cap (`>`: exactly the cap is accepted). */
export function overCap(bytes: number): boolean {
  return bytes > MAX_ATTACHMENT_BYTES
}

const PICK_REFUSAL: Readonly<Record<AttachmentRefusal, AttachmentPickRefusal>> = {
  'too-large': 'file-too-large',
  unreadable: 'unreadable',
  'not-a-file': 'directory'
}

/** The pick A-25 shows for one path the reader refused. */
export function refusedPick(path: string, refused: AttachmentRefusal): AttachmentPick {
  return { path, refusal: PICK_REFUSAL[refused] }
}
