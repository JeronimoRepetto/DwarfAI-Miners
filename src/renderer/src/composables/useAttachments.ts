import type { DwarfAttachmentPick } from '../types'

/*
 * The message panel's attachment calls (ADR-033 item 2; 05 §5.1 R13): the native file picker (A-24
 * `chooseDwarfAttachments`), the dropped-file path helper (A-X1 `pathForDroppedFile`) and the attachment
 * description (A-25 `describeDwarfAttachments`). The rows' shapes pass through unchanged; what becomes pending,
 * and which sentence a refusal reads, stays the panel's (lib/delivery/attachments). Main re-validates every
 * path it is asked to describe (ADR-019 item 9), so nothing here vouches for one.
 */
export function useAttachments() {
  return {
    /** The paths the person chose in the OS dialog; none when they cancelled. */
    choose(): Promise<readonly string[]> {
      return window.api.chooseDwarfAttachments()
    },
    /**
     * The paths of dropped files. `webUtils` in preload is the only thing that can turn a dropped File into a
     * path; a File carrying none — a drag out of a web page — answers '' and is dropped rather than guessed at.
     */
    droppedPaths(files: readonly File[]): readonly string[] {
      return files.map((file) => window.api.pathForDroppedFile(file)).filter((path) => path !== '')
    },
    /** What main says each path is: an attachment, or the refusal that kept it out, one per path. */
    describe(paths: readonly string[]): Promise<readonly DwarfAttachmentPick[]> {
      return window.api.describeDwarfAttachments(paths)
    }
  }
}
