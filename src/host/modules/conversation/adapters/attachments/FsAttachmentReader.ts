// FsAttachmentReader (05 §3.6, 16 §4.6 row `AttachmentReader`; 18 C-17, T-35; ADR-019 item 9;
// NFR-PRIV-04; ISSUE-169): the Host's own check of a path a UI sent, picked or dropped, never
// trusted. It stats and resolves; it never opens the file or reads a byte of it (INV-62).
//
// Candidate (21 §6): today's `src/main/textDelivery/attachmentFiles.ts` and `attachmentDelivery.ts`
// were evaluated against runAttachmentReaderContract and replaced: they cap by today's Anthropic
// image limits (18 E-08), not the 300 000 000-byte cap; they read image bytes for a thumbnail; and
// they follow links with no realpath, so a symlink leaving its folder, a FIFO or a UNC path passes.
//
// The rules, in order, each answered without going further:
// 1. A relative path names nothing the person picked: `unreadable` (it would resolve against the
//    Host's own working folder).
// 2. Windows: a UNC or device-namespace path (`\\server\share`, `\\?\`, `\\.\`, either slash) is
//    `unreadable`, refused before the disk is asked (a share would be reached over the network, a
//    device or pipe opened).
// 3. The path's own entry (links not followed) and its OS real path must exist: else `unreadable`.
//    On Windows a real path that is UNC (a mapped drive) is `unreadable` too.
// 4. A symlink must stay inside its own folder: its real target must lie under the real path of
//    the folder the link sits in (case-folded on Windows, as the volume compares); else
//    `unreadable`. A link inside its folder is described by its real path.
// 5. The real path's entry must be a regular file: a directory, a FIFO, a device or a socket is
//    `not-a-file`.
// 6. Its size must be at most `MAX_ATTACHMENT_BYTES` (`>` refuses: exactly the cap is accepted):
//    else `too-large`. No other size rule and no count limit (US-MSG-002.AC06, AC07).
// 7. The Host must be allowed to open it for reading: else `unreadable`.
// What is accepted carries the real path: that is the path `TurnInput.attachments` hands a driver.
// The per-OS rules live only here (R18); the platform is explicit, never read from the process.
import { posix, win32 } from 'node:path'
import { attachmentKindOf, overCap, type AttachmentPick } from '../../domain/attachments'
import type { AttachmentReader } from '../../ports/attachmentReader'

/** What `lstat` says a path's own entry is: a FIFO, a device or a socket is `other`. */
export type AttachmentEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface AttachmentEntry {
  kind: AttachmentEntryKind
  /** The size of a regular file; 0 for anything else. */
  bytes: number
}

/** The OS questions the reader asks (`NodeAttachmentProbe`); none opens or reads a file. */
export interface AttachmentFileProbe {
  /** The OS real path: every link and junction followed to the end; null when nothing is there. */
  realpath(path: string): Promise<string | null>
  /** The path's own entry, links not followed; null when it cannot be stat'ed. */
  entry(path: string): Promise<AttachmentEntry | null>
  /** Whether the Host may open the file for reading; nothing is read. */
  readable(path: string): Promise<boolean>
}

export interface FsAttachmentReaderDeps {
  /** The Host's OS (`hostRuntime().os`): which path rules apply. */
  platform: NodeJS.Platform
  probe: AttachmentFileProbe
}

type Described = AttachmentPick | { refused: 'too-large' | 'unreadable' | 'not-a-file' }

const UNREADABLE = { refused: 'unreadable' } as const

/** A UNC share or a Win32 device namespace (`\\?\`, `\\.\`), with either slash. */
const UNC_OR_DEVICE = /^[\\/]{2}/

export class FsAttachmentReader implements AttachmentReader {
  private readonly path: typeof posix
  private readonly windows: boolean

  constructor(private readonly deps: FsAttachmentReaderDeps) {
    this.windows = deps.platform === 'win32'
    this.path = this.windows ? win32 : posix
  }

  async describe(path: string): Promise<Described> {
    const { probe } = this.deps
    if (!this.path.isAbsolute(path)) return UNREADABLE
    if (this.windows && UNC_OR_DEVICE.test(path)) return UNREADABLE
    const own = await probe.entry(path)
    if (own === null) return UNREADABLE
    const real = await probe.realpath(path)
    if (real === null) return UNREADABLE
    if (this.windows && UNC_OR_DEVICE.test(real)) return UNREADABLE
    if (own.kind === 'symlink' && !(await this.staysInItsFolder(path, real))) return UNREADABLE
    const target = await probe.entry(real)
    if (target === null) return UNREADABLE
    if (target.kind !== 'file') return { refused: 'not-a-file' }
    if (overCap(target.bytes)) return { refused: 'too-large' }
    if (!(await probe.readable(real))) return UNREADABLE
    const name = this.path.basename(path)
    return {
      path,
      attachment: { path: real, name, kind: attachmentKindOf(name), bytes: target.bytes }
    }
  }

  /** Whether a link's real target lies under the real path of the folder the link sits in. */
  private async staysInItsFolder(link: string, real: string): Promise<boolean> {
    const folder = await this.deps.probe.realpath(this.path.dirname(link))
    if (folder === null) return false
    const fold = (p: string): string => (this.windows ? p.toLowerCase() : p)
    const relative = this.path.relative(fold(folder), fold(real))
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${this.path.sep}`) &&
      !this.path.isAbsolute(relative)
    )
  }
}
