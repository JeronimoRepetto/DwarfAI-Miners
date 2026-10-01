// The native actions UI main serves at cut 0 (05 §3.14 `NativeActions`; 16 §4.14): choosing attachment files (A-24),
// copying text (A-22) and opening an external link (A-21), each over its driven port. The answers are today's shapes
// (14 §2.1 KEEP; ADR-033 item 6), taken from the channel registry, never restated. A picker returns paths only: the
// Host re-validates every path the renderer later sends on (ADR-019 item 9; 14 §1.10).
import type { z } from 'zod'
import type { CHANNELS } from '@dwarfai/contracts'
import type { ClipboardPort, ExternalOpener, FilePicker, WindowRef } from '../ports/nativeActions'

export type CopyTextResult = z.infer<(typeof CHANNELS)['shell:copyText']['response']>
export type ExternalLinkResult = z.infer<(typeof CHANNELS)['shell:openExternalLink']['response']>

/**
 * The one fixed refusal of A-21, today's wording: the OS's own error text is never shown, and a link the allowlist
 * refused reads the same as one the OS would not open (`shell/openExternalLink.ts`, #347). The seam A gate answers the
 * same shape for a payload that is not a link (`LEGACY_REFUSALS`, ISSUE-044).
 */
export const EXTERNAL_LINK_REFUSED_REASON = 'That link could not be opened.'

/**
 * The members of 16 §4.14 `NativeActions` that cut 0 serves, with their frozen signatures. Owner-approved amendment
 * (2026-10-01, ISSUE-050): `copyText` answers a promise (was `CopyTextResult`), so a clipboard write that fails after
 * the call answers `copied: false`. `chooseFolder` and
 * `openPath` join with A-30 and A-20 (ISSUE-091); `raiseConsole` with the console raise.
 */
export interface ServedNativeActions {
  chooseAttachments(): Promise<string[]>
  copyText(t: string): Promise<CopyTextResult>
  openExternal(url: string): Promise<ExternalLinkResult>
}

export interface NativeActionsDeps {
  files: FilePicker
  clipboard: ClipboardPort
  /** Admits only an allowlisted link (`ElectronExternalOpener`, ADR-019 item 2) and rejects any other. */
  opener: ExternalOpener
  /** The window a picker is attached to: the window the person pressed the control in. */
  parentWindow(): WindowRef
}

export function createNativeActions(deps: NativeActionsDeps): ServedNativeActions {
  const { files, clipboard, opener, parentWindow } = deps
  return {
    // A cancelled picker answers [] (16 §4.14).
    chooseAttachments: () => files.pickMany(parentWindow()),

    // Copy copies the message as written, never trimmed; there is nothing to copy in an empty one. The gate already
    // bounded its length to the largest message any route carries (14 §2.1 A-22). A write that fails, at once or after
    // the call, answers "not copied" rather than rejecting across the bridge: the renderer claims a copy only on
    // `copied: true`.
    async copyText(t) {
      if (t === '') return { copied: false }
      try {
        await clipboard.write(t)
      } catch {
        return { copied: false }
      }
      return { copied: true }
    },

    async openExternal(url) {
      try {
        await opener.openExternal(url)
      } catch {
        return { opened: false, reason: EXTERNAL_LINK_REFUSED_REASON }
      }
      return { opened: true }
    }
  }
}
