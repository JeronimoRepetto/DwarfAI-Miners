import type { InterfaceFont } from '../../types'

/**
 * Turning a stored font identifier into something the page can be painted with
 * (#370).
 *
 * Two vocabularies meet here and neither may absorb the other. The IDENTIFIER
 * (`'pixelify-sans'`) is what crosses the wire and lands in the userData
 * document, so it must survive a hosted family being renamed. The STACK
 * (`'Pixelify Sans Variable', 'Segoe UI', ...`) is a design value and lives in
 * `assets/design-tokens.css` with every other one. This module is the join, and
 * it deliberately carries no stack of its own: a second copy is exactly the
 * duplication `designTokens.test.ts` exists to catch.
 *
 * Framework-agnostic on purpose — `useTypography` is the Vue-bound half, and
 * what is testable without a component belongs on this side (see src/README).
 */

/**
 * The custom property the whole interface is drawn through, and the one the
 * crew's own words are.
 *
 * Repointing these two is the entire mechanism: every component already reads
 * them, so a preference applies by changing what they resolve to on the
 * document root rather than by touching a single component.
 */
export const INTERFACE_FONT_PROPERTY = '--font-pixel'
export const MESSAGING_FONT_PROPERTY = '--font-conversation'

/**
 * The `var()` reference for one face, to be assigned to either role.
 *
 * A reference rather than the stack itself, so the stack stays declared once in
 * the stylesheet. `design-tokens.css` declares `--font-family-<identifier>` for
 * every member of INTERFACE_FONTS, and a test there holds it to that — a
 * missing token would resolve to nothing, and `font-family:` with nothing in it
 * is a declaration the browser drops silently.
 */
export function fontFamilyReference(font: InterfaceFont): string {
  return `var(--font-family-${font})`
}

/**
 * What Settings calls each face.
 *
 * The family's own name, capitalised as its foundry writes it, rather than
 * anything derived from the identifier: `pixelify-sans` would title-case to
 * "Pixelify-Sans", and a person choosing a font recognises it by the name on
 * the font, not by ours. Kept beside the reference above rather than in
 * `presentation.ts` because it is about this subject and nothing else reads it.
 */
const FONT_FAMILY_LABELS: Record<InterfaceFont, string> = {
  tiny5: 'Tiny5',
  'pixelify-sans': 'Pixelify Sans',
  roboto: 'Roboto',
  arial: 'Arial'
}

export function fontFamilyLabel(font: InterfaceFont): string {
  return FONT_FAMILY_LABELS[font]
}
