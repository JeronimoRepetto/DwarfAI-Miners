/**
 * Whether a string a transcript carried is an address this app will open in the
 * system browser (#347).
 *
 * Shared, and deliberately not two checks. The RENDERER asks it to decide
 * whether a Markdown link is drawn as a control at all, and MAIN asks it again
 * before anything reaches `shell.openExternal` — main's answer is the
 * authoritative one, because a renderer's word is never a permission. Two
 * copies of the rule would be two chances for one of them to widen.
 *
 * Here rather than in `contracts.ts` for the reason `truncate.ts` and
 * `accelerator.ts` are: this is a pure rule both processes run, not a shape
 * that crosses between them. No Electron and no Node, like everything in
 * `shared/` — `URL` is the platform's own parser on both sides.
 */

/**
 * The longest address this app will hand to another program.
 *
 * A bound rather than none, because a bubble's text is unbounded and this is
 * the one thing in it that leaves the process. 2048 is the old de-facto browser
 * ceiling: comfortably past any address a person would follow, and far short of
 * a message that is trying to be an argument list.
 */
export const MAX_EXTERNAL_LINK_CHARS = 2048

/**
 * The address, or `null` when the string is not one this app opens.
 *
 * Only `http:` and `https:` pass. Everything else a URL can name is refused
 * outright rather than filtered — `javascript:` and `data:` are the obvious
 * two, but the list of schemes a desktop registers is the machine's, not this
 * app's, so an allowlist of two is the only version of this check that stays
 * correct on a machine nobody here has seen.
 *
 * The RAW string comes back rather than the parser's canonical form: the
 * renderer shows this on hover and main opens it, and those two must be the
 * same characters. `new URL('http://x.test').href` already is not.
 */
export function externalLinkOf(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_EXTERNAL_LINK_CHARS) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // Not an absolute address — a relative path, a bare word, a fragment. The
    // parser strips leading whitespace and any tab or newline INSIDE the string
    // before it reads the scheme, so a scheme split across a line break has
    // already been rejoined by the time the protocol below is compared.
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return raw
}
