import { externalLinkOf } from '../../shared/externalLink'

/**
 * A press on a link inside a bubble (#347) — reading what a renderer asked for,
 * and refusing anything that is not a web address.
 *
 * Pure and Electron-free, like `openMineFile.ts` beside it: `shell.openExternal`
 * itself is `index.ts`'s job, and this module only decides whether the call is
 * safe to make at all. That is what lets both branches be asserted with no
 * display and no browser.
 *
 * The rule it applies is `shared/externalLink`'s, which the RENDERER already
 * ran before drawing the link. Running it again here is not redundancy: this
 * handler is reachable by anything holding the bridge, and a renderer's word is
 * never a permission.
 */

/**
 * The one fixed refusal (#347). Never the OS's own wording: `shell.openExternal`
 * throws whatever the platform threw, and that is swallowed at the call site in
 * `index.ts` for the reason #279 gives — this app decided what a person is
 * told, not the platform.
 *
 * ONE sentence, where #279 has three. That issue could tell a person something
 * useful, because it was resolving a path they could see. Here there is nothing
 * useful to distinguish: an address that is not the web and an address the OS
 * would not take read the same to somebody who pressed a link, and inventing a
 * difference would say more about the machine than about the link.
 */
export const EXTERNAL_LINK_REFUSED_REASON = 'That link could not be opened.'

/**
 * The address a renderer asked to open, or `null` — the same boundary
 * discipline every channel in `index.ts` holds. A payload that is not a string
 * could not name an address, and honouring it would be handing an unknown shape
 * to another program.
 */
export function parseExternalLinkRequest(payload: unknown): string | null {
  if (typeof payload !== 'string') return null
  return externalLinkOf(payload)
}
