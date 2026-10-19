// The AttachmentReader double (16 §2.8, 16 §4.6 row `AttachmentReader`: `FakeAttachmentReader`
// over `FakeFs`). It runs the same runAttachmentReaderContract as FsAttachmentReader: a FakeFs file
// is a regular file (its size is its content's, or the one `declareSize` gave it, so the 300 MB
// cases hold no bytes), a FakeFs folder is `not-a-file`, a missing or faulted path is `unreadable`,
// and so is a relative one. FakeFs has no links, so a path is its own real path. Never imported by
// production code (R14).
import type { FakeFs } from '../../../kernel/fakes/FakeFs'
import { attachmentKindOf, overCap, type AttachmentPick } from '../domain/attachments'
import type { AttachmentReader } from '../ports/attachmentReader'

/** A POSIX root, a drive root or a UNC prefix: what an absolute path starts with. */
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/

export class FakeAttachmentReader implements AttachmentReader {
  /** Every path described, in order. */
  readonly described: string[] = []
  private readonly sizes = new Map<string, number>()

  constructor(private readonly fs: FakeFs) {}

  /** Gives the file at `path` a size without holding its bytes (the 300 MB cases). */
  declareSize(path: string, bytes: number): void {
    this.sizes.set(path, bytes)
  }

  async describe(
    path: string
  ): Promise<AttachmentPick | { refused: 'too-large' | 'unreadable' | 'not-a-file' }> {
    this.described.push(path)
    if (!ABSOLUTE.test(path)) return { refused: 'unreadable' }
    const stat = await this.fs.stat(path)
    if (stat === null) return { refused: 'unreadable' }
    if (stat.isDirectory) return { refused: 'not-a-file' }
    const bytes = this.sizes.get(path) ?? stat.size
    if (overCap(bytes)) return { refused: 'too-large' }
    const name = path.split(/[\\/]/).at(-1) ?? path
    return { path, attachment: { path, name, kind: attachmentKindOf(name), bytes } }
  }
}
