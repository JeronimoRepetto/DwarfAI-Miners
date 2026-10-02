import {
  EXTERNAL_LINK_REFUSED_REASON,
  type CopyTextResult,
  type ExternalLinkResult,
  type ServedNativeActions
} from '../../application/nativeActions'

/**
 * Hand-written double of `NativeActions` (16 §4.14 table: `FakeNativeActions`; 16 §2.8), for the members cut 0 serves
 * (`ServedNativeActions`). `attachments` is what the person chooses in the picker, `null` a cancelled picker, which
 * answers `[]`. Every copied text and opened link is recorded; `clipboardFails` and `refuseLinks` play a clipboard
 * that fails and a link that is refused, each answered as the real actions answer them.
 */
export class FakeNativeActions implements ServedNativeActions {
  readonly copied: string[] = []
  readonly opened: string[] = []
  pickerOpened = 0
  clipboardFails = false
  refuseLinks = false
  private readonly attachments: readonly string[] | null

  constructor(options: { attachments?: readonly string[] | null } = {}) {
    this.attachments = options.attachments ?? null
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
}
