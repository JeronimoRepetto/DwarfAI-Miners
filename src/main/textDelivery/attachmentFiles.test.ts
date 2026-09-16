import { describe, expect, it } from 'vitest'
import { MAX_DWARF_ATTACHMENT_BYTES } from '../domain/types'
import { describeAttachments, type AttachmentFilePort } from './attachmentFiles'

/*
 * Issue #408. The panel never touches the disk: it hands main a path the person
 * chose and asks what it is. So everything that can only be known by looking —
 * the size, whether it is a folder at all, whether it can be read — is decided
 * here, behind a port, and the tests use a hand-written fake rather than a temp
 * directory (the house rule in `skills/tdd/SKILL.md`).
 */
function port(
  entries: Record<string, { bytes: number; directory?: boolean }>,
  thumbnails: Record<string, string> = {}
): AttachmentFilePort & { thumbnailed: string[] } {
  const thumbnailed: string[] = []
  return {
    thumbnailed,
    async stat(path) {
      const entry = entries[path]
      return entry === undefined
        ? null
        : { bytes: entry.bytes, directory: entry.directory === true }
    },
    async thumbnail(path) {
      thumbnailed.push(path)
      return thumbnails[path] ?? null
    }
  }
}

const IMAGE = 'C:\\work\\shot.png'
const NOTES = 'C:\\work\\notes.txt'

describe('describeAttachments', () => {
  it('measures a file and names it from its own path', async () => {
    const [pick] = await describeAttachments([NOTES], port({ [NOTES]: { bytes: 120 } }))
    expect(pick).toMatchObject({
      path: NOTES,
      attachment: { path: NOTES, name: 'notes.txt', kind: 'file', bytes: 120 }
    })
    expect(pick?.refusal).toBeUndefined()
  })

  it('keeps a POSIX path readable too, so the renderer never has to know the separator', async () => {
    const posix = '/home/j/work/notes.txt'
    const [pick] = await describeAttachments([posix], port({ [posix]: { bytes: 1 } }))
    expect(pick?.attachment?.name).toBe('notes.txt')
  })

  it('refuses a directory, which the issue rules out until somebody designs it', async () => {
    const dir = 'C:\\work\\src'
    const [pick] = await describeAttachments([dir], port({ [dir]: { bytes: 0, directory: true } }))
    expect(pick).toEqual({ path: dir, refusal: 'directory' })
  })

  it('refuses a path it cannot read rather than inventing a size for it', async () => {
    const [pick] = await describeAttachments(['C:\\gone.png'], port({}))
    expect(pick).toEqual({ path: 'C:\\gone.png', refusal: 'unreadable' })
  })

  it('answers about every path, in the order it was asked', async () => {
    const picks = await describeAttachments(
      [IMAGE, 'C:\\gone.png', NOTES],
      port({ [IMAGE]: { bytes: 10 }, [NOTES]: { bytes: 20 } })
    )
    expect(picks.map((pick) => pick.path)).toEqual([IMAGE, 'C:\\gone.png', NOTES])
  })

  it('renders a preview for an image, so the renderer never loads a path itself', async () => {
    // The renderer must not be handed a file:// URL for an arbitrary path; main
    // reads the bytes it was pointed at and hands back a bounded data URL.
    const fake = port({ [IMAGE]: { bytes: 900 } }, { [IMAGE]: 'data:image/png;base64,AAA' })
    const [pick] = await describeAttachments([IMAGE], fake)
    expect(pick?.thumbnail).toBe('data:image/png;base64,AAA')
  })

  it('renders no preview for a file that is not an image, and does not try', async () => {
    const fake = port({ [NOTES]: { bytes: 900 } })
    const [pick] = await describeAttachments([NOTES], fake)
    expect(pick?.thumbnail).toBeUndefined()
    expect(fake.thumbnailed).toEqual([])
  })

  it('renders no preview for an image past the per-file limit, and does not read it', async () => {
    // The limit refuses the file anyway, so decoding it would be work done to
    // draw a chip that is about to be refused — on a file of any size at all.
    const fake = port({ [IMAGE]: { bytes: MAX_DWARF_ATTACHMENT_BYTES + 1 } })
    const [pick] = await describeAttachments([IMAGE], fake)
    expect(pick?.attachment?.bytes).toBe(MAX_DWARF_ATTACHMENT_BYTES + 1)
    expect(fake.thumbnailed).toEqual([])
  })

  it('still describes an image whose preview could not be drawn', async () => {
    // A corrupt or unsupported file is not an unreadable one: it has a size and
    // a name, and the chip falls back to the file glyph.
    const fake = port({ [IMAGE]: { bytes: 900 } })
    const [pick] = await describeAttachments([IMAGE], fake)
    expect(pick?.attachment?.kind).toBe('image')
    expect(pick?.thumbnail).toBeUndefined()
  })
})
