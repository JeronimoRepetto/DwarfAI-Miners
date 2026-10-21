// The files a turn carries (15 §1.2 `TurnInput.attachments`; US-MSG-002.AC03; #1463), as the
// launched drivers hand them to a provider that has no input of its own for a kind of file: each
// Host-revalidated path named on its own `Attached file: <path>` line ahead of the person's words,
// so the person's own CLI opens the file with its own tools. Only paths travel; the bytes are never
// read here (INV-62), and a path is never revalidated again (the Host's `send` did it).
import type { TurnInput } from '../../ports/providerDriver'

/** One file of a turn, as the driver receives it. */
export type AttachedFile = TurnInput['attachments'][number]

/**
 * The line DwarfAI writes ahead of each file it names (#1463): the same words the legacy held route
 * (`attachmentDelivery.ts` `heldContentFor`, #408) named a file with when it did not send its
 * bytes. Kept here, not imported: a module adapter never imports `contracts` (R9), and the literal
 * the renderer reads is `contracts/text/heldSessionText.ts` `ATTACHED_FILE_PREFIX`.
 */
export const ATTACHED_FILE_PREFIX = 'Attached file: '

/**
 * A turn's text with its files named (package gap, recorded in the #1463 hand-off): one
 * `Attached file: <path>` line per file, in the order sent, then the person's words. A turn with no
 * file is its words exactly as before; a turn of files alone carries no empty line of words.
 */
export function userContentOf(text: string, attachments: readonly AttachedFile[]): string {
  if (attachments.length === 0) return text
  const named = attachments.map((file) => `${ATTACHED_FILE_PREFIX}${file.path}`)
  return [...named, ...(text === '' ? [] : [text])].join('\n')
}

/**
 * Today's image extensions (`DWARF_IMAGE_EXTENSIONS`; the conversation module's `attachmentKindOf`
 * reads the same list), matched on the file name without case.
 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const

/** Whether a file is an image by the kind its name shows (the composer's chip kind). */
export function isImageFile(file: AttachedFile): boolean {
  const lower = file.name.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
