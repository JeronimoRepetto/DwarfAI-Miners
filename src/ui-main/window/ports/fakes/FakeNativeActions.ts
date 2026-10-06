import {
  EXTERNAL_LINK_REFUSED_REASON,
  MINE_PATH_UNOPENABLE_REASON,
  type CopyTextResult,
  type ExternalLinkResult,
  type OpenPathResult,
  type ServedNativeActions
} from '../../application/nativeActions'

/**
 * Hand-written double of `NativeActions` (16 §4.14 table: `FakeNativeActions`; 16 §2.8), for the members cut 0 serves
 * (`ServedNativeActions`). `attachments` is what the person chooses in the picker, `null` a cancelled picker, which
 * answers `[]`. Every copied text and opened link is recorded; `clipboardFails` and `refuseLinks` play a clipboard
 * that fails and a link that is refused, each answered as the real actions answer them. `folder` is the folder the
 * person picks for A-30, `null` (the default) a cancelled picker; every opened path is recorded, and `refusePaths`
 * plays an OS that will not open one (ISSUE-091).
 */
export class FakeNativeActions implements ServedNativeActions {
  readonly copied: string[] = []
  readonly opened: string[] = []
  readonly openedPaths: string[] = []
  pickerOpened = 0
  folderPickerOpened = 0
  refusePaths = false
  clipboardFails = false
  refuseLinks = false
  private readonly attachments: readonly string[] | null
  private readonly folder: string | null

  constructor(options: { attachments?: readonly string[] | null; folder?: string | null } = {}) {
    this.attachments = options.attachments ?? null
    this.folder = options.folder ?? null
  }

  chooseAttachments(): Promise<string[]> {
    this.pickerOpened += 1
    return Promise.resolve(this.attachments === null ? [] : [...this.attachments])
  }

  copyText(t: string): Promise<CopyTextResult> {
    if (t === '' || this.clipboardFails) return Promise.resolve({ copied: false })
    this.copied.push(t)
    return Promise.resolve({ copied: true })
  }

  openExternal(url: string): Promise<ExternalLinkResult> {
    if (this.refuseLinks) {
      return Promise.resolve({ opened: false, reason: EXTERNAL_LINK_REFUSED_REASON })
    }
    this.opened.push(url)
    return Promise.resolve({ opened: true })
  }

  chooseFolder(): Promise<string | null> {
    this.folderPickerOpened += 1
    return Promise.resolve(this.folder)
  }

  openPath(p: string): Promise<OpenPathResult> {
    if (this.refusePaths) {
      return Promise.resolve({ opened: false, reason: MINE_PATH_UNOPENABLE_REASON })
    }
    this.openedPaths.push(p)
    return Promise.resolve({ opened: true })
  }
}
