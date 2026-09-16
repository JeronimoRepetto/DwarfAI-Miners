/**
 * What main knows about a file the person pointed at, and the renderer cannot
 * (#408).
 *
 * The panel never touches the disk. It has a path — from a drop, through
 * `webUtils.getPathForFile`, or from the system picker — and everything else is
 * a question only this process can answer: how big it is, whether it is a
 * folder, whether it can be read at all, and what a 40px chip should show. So
 * the renderer asks, and both entry points ask through here, which is what
 * makes the drop and the picker "the same validation path" the issue requires
 * rather than two that drifted.
 *
 * Nothing is copied. The path the person chose is the path that travels, and
 * the only bytes read are the ones a preview needs — see `docs/privacy.md`.
 */
import { basename } from 'node:path'
import {
  MAX_DWARF_ATTACHMENT_BYTES,
  attachmentKindFor,
  type DwarfAttachmentPick
} from '../domain/types'

/** The one seam onto the filesystem, so the rules above are testable with a fake. */
export interface AttachmentFilePort {
  /** Null when the path cannot be read at all — gone, denied, not a file we can size. */
  stat(path: string): Promise<{ bytes: number; directory: boolean } | null>
  /** A small data URL for an image, or null when this file will not decode as one. */
  thumbnail(path: string): Promise<string | null>
}

/**
 * Describe every path, in order, answering for each one either an attachment or
 * the reason it is not one.
 *
 * The two refusals reachable here are the two that are facts about the
 * filesystem: a directory, which the issue rules out until somebody designs it,
 * and a path that cannot be read. Everything else — the count, the sizes, a
 * file already attached — is arithmetic over what is pending, which only the
 * composer knows, so it stays in `refuseAttachment` and is not repeated here.
 *
 * An oversized image gets no preview. The limit is about to refuse it, so
 * decoding it would be work spent drawing a chip that cannot exist — and this
 * is the one place where "any size at all" could otherwise reach a decoder.
 */
export async function describeAttachments(
  paths: readonly string[],
  files: AttachmentFilePort
): Promise<DwarfAttachmentPick[]> {
  const picks: DwarfAttachmentPick[] = []
  for (const path of paths) {
    const stat = await files.stat(path)
    if (stat === null) {
      picks.push({ path, refusal: 'unreadable' })
      continue
    }
    if (stat.directory) {
      picks.push({ path, refusal: 'directory' })
      continue
    }
    const name = basename(path.replace(/\\/g, '/'))
    const kind = attachmentKindFor(name)
    const attachment = { path, name, kind, bytes: stat.bytes }
    const previewable = kind === 'image' && stat.bytes <= MAX_DWARF_ATTACHMENT_BYTES
    const thumbnail = previewable ? await files.thumbnail(path) : null
    picks.push({ path, attachment, ...(thumbnail === null ? {} : { thumbnail }) })
  }
  return picks
}
