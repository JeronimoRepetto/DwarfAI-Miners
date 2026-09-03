/**
 * Reading the renderer document's own Content-Security-Policy (#156).
 *
 * ## Why this exists
 *
 * Every icon in the SHIPPED app was invisible — the navigation stack, the browse
 * header, the mine's round close, the dwarf status glyphs over the sprites — and
 * so was the app mark and the Tiny5 pixel font. #153 had already found and fixed
 * a quoting bug in the same glyphs, which is exactly why this one survived: the
 * masks were correct, the data URIs were well formed, and the page simply
 * refused to load them.
 *
 * The renderer's own `index.html` declares `default-src 'self'`, and it declares
 * no `img-src` and no `font-src`, so both fall back to it. `data:` is a SCHEME,
 * not an origin, so it is not `'self'` — and Vite inlines every asset under
 * `assetsInlineLimit` as a `data:` URI. A packaged build is loaded from `file://`
 * and every one of those assets is refused with
 *
 *     Loading the image 'data:image/svg+xml,...' violates the following Content
 *     Security Policy directive: "default-src 'self'".
 *
 * Nothing about that is visible in a `pnpm dev` run, where the same assets are
 * served from the dev server's own origin as `/@fs/...` URLs. It reaches the
 * user and only the user.
 *
 * So the policy is parsed here rather than eyeballed, and the test beside this
 * file reads the SHIPPED `index.html` and holds it to admitting the schemes the
 * bundle actually emits. The parser is deliberately small: it answers what the
 * browser answers for the one question that matters — which source list governs
 * a directive once the fallback to `default-src` is taken into account.
 */

/**
 * The source list that actually governs `directive`, following the one fallback
 * rule that bit us: a directive the policy does not name falls back to
 * `default-src`. Returns an empty list when neither is declared, which is a
 * policy that governs nothing rather than one that forbids everything.
 */
export function policySourcesFor(policy: string, directive: string): readonly string[] {
  const declared = declaredSourcesFor(policy, directive)
  if (declared !== null) return declared
  return declaredSourcesFor(policy, 'default-src') ?? []
}

/**
 * Whether `source` — an origin keyword like `'self'`, or a scheme like `data:` —
 * is admitted for `directive`.
 *
 * A `*` admits anything; an undeclared directive with no `default-src` behind it
 * admits anything too, because there is no policy to violate.
 */
export function policyAdmits(policy: string, directive: string, source: string): boolean {
  const sources = policySourcesFor(policy, directive)
  if (sources.length === 0) return true
  return sources.includes(source) || sources.includes('*')
}

function declaredSourcesFor(policy: string, directive: string): readonly string[] | null {
  for (const clause of policy.split(';')) {
    const tokens = clause.trim().split(/\s+/).filter(Boolean)
    const name = tokens[0]
    if (name === undefined || name.toLowerCase() !== directive) continue
    return tokens.slice(1)
  }
  return null
}
