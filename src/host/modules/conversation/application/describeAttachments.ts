// `ConversationCommands.describeAttachments` (05 §3.6, 16 §4.6; 14 B-M28, A-25; ADR-019 item 9;
// 12 UC-035; ISSUE-169) and the re-validation `send` repeats (11 F4 step 1): every path a UI sent,
// picked or dropped, is described by the `AttachmentReader`, never trusted.
//
// - `describeAttachments` answers one `AttachmentPick` per path, in the order asked: an accepted
//   file with its revalidated path, name, kind and size, or the path with its refusal in A-25's
//   names (`domain/attachments.ts`), so one oversized file among several is refused alone and the
//   others stay accepted (US-MSG-002.AC05). No count limit (AC07), no other size rule (AC06).
// - `revalidateAttachments` is `send`'s: every path accepted again (a file may have gone or grown
//   since it was described), or the whole send is `attachment-refused` before any row (16 §4.6;
//   UC-035 "A path changed between describe and send"). What passes is `TurnInput.attachments`:
//   the real paths, names and sizes (15 §1.2). Nothing is read and nothing is stored (INV-62).
// Paths are described one at a time: a message may carry any number of files, and each answer
// waits on the disk, never on the others.
import type { AttachmentPick } from '../domain/attachments'
import { refusedPick } from '../domain/attachments'
import type { AttachmentReader } from '../ports/attachmentReader'
import type { AttachmentPath } from './ingest'

/** 16 §4.6 `ConversationCommands.describeAttachments`. */
export interface ConversationAttachmentCommand {
  describeAttachments(paths: AttachmentPath[]): Promise<AttachmentPick[]>
}

/** `15` §1.2 `TurnInput.attachments`: one Host-revalidated file. */
export interface RevalidatedAttachment {
  path: string
  name: string
  bytes: number
}

export async function describeAttachments(
  paths: readonly AttachmentPath[],
  reader: AttachmentReader
): Promise<AttachmentPick[]> {
  const picks: AttachmentPick[] = []
  for (const path of paths) {
    const described = await reader.describe(path)
    picks.push('refused' in described ? refusedPick(path, described.refused) : described)
  }
  return picks
}

/** Every path accepted again, as the turn carries it; null when any one is refused now. */
export async function revalidateAttachments(
  paths: readonly AttachmentPath[],
  reader: AttachmentReader
): Promise<RevalidatedAttachment[] | null> {
  const accepted: RevalidatedAttachment[] = []
  for (const path of paths) {
    const described = await reader.describe(path)
    if ('refused' in described || described.attachment === undefined) return null
    const { path: real, name, bytes } = described.attachment
    accepted.push({ path: real, name, bytes })
  }
  return accepted
}
