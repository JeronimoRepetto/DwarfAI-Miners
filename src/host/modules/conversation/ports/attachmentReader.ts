// Driven port of conversation (05 §3.6, 16 §4.6 `AttachmentReader`, frozen), type-only (05 R2):
// describes one path a UI sent without reading its content into the DB (INV-62, NFR-PRIV-04).
// `refused: 'too-large'` when the regular file's size is greater than `MAX_ATTACHMENT_BYTES`
// (300 000 000 bytes, AMENDMENT-1), per file, no count limit; a directory, a device, a FIFO or any
// other non-regular file is `not-a-file`; a path that is missing, denied, or that the Host refuses
// to touch (a symlink leaving its folder, a UNC or device-namespace path) is `unreadable`
// (18 C-17, T-35; ADR-019 item 9). Adapter `FsAttachmentReader`; double `FakeAttachmentReader`, in
// testing/ beside the module's other doubles (a port folder holds types only, R2).
import type { AttachmentPick } from '../domain/attachments'

export interface AttachmentReader {
  describe(
    path: string
  ): Promise<AttachmentPick | { refused: 'too-large' | 'unreadable' | 'not-a-file' }>
}
