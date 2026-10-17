// The AttachmentReader conformance suite (16 §4.6 `AttachmentReader`; 16 §2.8; 17 §1.3): run on
// `FakeAttachmentReader` over `FakeFs` and on `FsAttachmentReader` over a temp folder, so the
// double and the adapter answer the same cases. The cap is AMENDMENT-1's `MAX_ATTACHMENT_BYTES`
// (300 000 000 bytes, decimal): exactly the cap is accepted, one byte more is `too-large`
// (NFR-PRIV-04, 18 C-17 row "300 MB + 1 byte refused"). A directory is `not-a-file`; a missing or
// denied path is `unreadable` (ADR-019 item 9). The per-OS refusals (a symlink leaving its folder,
// a device, a FIFO, a UNC path) are the adapter's own L8 cases (FsAttachmentReader.os.test.ts).
//
// TC-169-01.
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES, type AttachmentPick } from '../domain/attachments'
import type { AttachmentReader } from '../ports/attachmentReader'

export interface AttachmentReaderSubject {
  reader: AttachmentReader
  /** An absolute path to a new regular file of exactly `bytes`, named `name`. */
  file(name: string, bytes: number): Promise<string>
  /** An absolute path to a new folder named `name`. */
  directory(name: string): Promise<string>
  /** An absolute path where nothing exists. */
  missing(name: string): string
  /**
   * An absolute path to a regular file the Host may not open, or null where the subject cannot
   * deny a read (Windows, or a POSIX process running as root).
   */
  unreadable(name: string): Promise<string | null>
  /** The real path the subject resolves `path` to (the temp folder may sit behind a link). */
  real(path: string): Promise<string>
  dispose(): void | Promise<void>
}

/** The accepted pick of `path`, or a failed expectation naming what came back. */
function accepted(answer: AttachmentPick | { refused: string }): AttachmentPick {
  expect(answer).not.toHaveProperty('refused')
  return answer as AttachmentPick
}

export function runAttachmentReaderContract(
  name: string,
  makeSubject: () => AttachmentReaderSubject | Promise<AttachmentReaderSubject>
): void {
  describe(`AttachmentReader contract: ${name}`, () => {
    const subjects: AttachmentReaderSubject[] = []
    const subject = async (): Promise<AttachmentReaderSubject> => {
      const made = await makeSubject()
      subjects.push(made)
      return made
    }
    afterEach(async () => {
      for (const made of subjects.splice(0)) await made.dispose()
    })

    it('[US-MSG-002.AC05, NFR-PRIV-04] a file of exactly 300 000 000 bytes is accepted and one of 300 000 001 is refused too-large', async () => {
      const s = await subject()
      const atCap = await s.file('at-cap.bin', MAX_ATTACHMENT_BYTES)
      const overCap = await s.file('over-cap.bin', MAX_ATTACHMENT_BYTES + 1)

      expect(MAX_ATTACHMENT_BYTES).toBe(300_000_000)
      expect(accepted(await s.reader.describe(atCap)).attachment?.bytes).toBe(300_000_000)
      expect(await s.reader.describe(overCap)).toStrictEqual({ refused: 'too-large' })
    })

    it('[US-MSG-002.AC01] a readable regular file is described with its name and size', async () => {
      const s = await subject()
      const notes = await s.file('notes.txt', 12)
      const shot = await s.file('Shot.PNG', 3)

      expect(accepted(await s.reader.describe(notes))).toStrictEqual({
        path: notes,
        attachment: { path: await s.real(notes), name: 'notes.txt', kind: 'file', bytes: 12 }
      })
      expect(accepted(await s.reader.describe(shot))).toStrictEqual({
        path: shot,
        attachment: { path: await s.real(shot), name: 'Shot.PNG', kind: 'image', bytes: 3 }
      })
      // An empty file is a file: no size rule under the cap (US-MSG-002.AC06).
      const empty = await s.file('empty.log', 0)
      expect(accepted(await s.reader.describe(empty)).attachment?.bytes).toBe(0)
    })

    it('[ADR-019] a directory is not-a-file and a missing or unreadable path is unreadable', async () => {
      const s = await subject()
      const folder = await s.directory('a-folder')

      expect(await s.reader.describe(folder)).toStrictEqual({ refused: 'not-a-file' })
      expect(await s.reader.describe(s.missing('gone.txt'))).toStrictEqual({
        refused: 'unreadable'
      })
      const denied = await s.unreadable('denied.txt')
      if (denied !== null) {
        expect(await s.reader.describe(denied)).toStrictEqual({ refused: 'unreadable' })
      }
      // A relative path names no file the person picked: the Host never resolves it against its
      // own working folder.
      expect(await s.reader.describe('notes.txt')).toStrictEqual({ refused: 'unreadable' })
    })
  })
}
