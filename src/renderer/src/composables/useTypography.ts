import { ref } from 'vue'
import { DEFAULT_TYPOGRAPHY_PREFERENCES, type TypographyPreferences } from '../types'
import {
  INTERFACE_FONT_PROPERTY,
  MESSAGING_FONT_PROPERTY,
  fontFamilyReference
} from '../lib/typography/fontFamilies'

/**
 * State for Settings' Typography section, and the one place a chosen face
 * actually reaches the page (#370).
 *
 * ## Why this is a composable and not a change in every component
 *
 * The two roles are already custom properties every component reads:
 * `--font-pixel` on `body`, `--font-conversation` on the bubbles, the question
 * and permission prose and the Add Panel. So applying a preference is two
 * `setProperty` calls on the DOCUMENT ROOT, where an inline declaration
 * outranks the `:root` block in `design-tokens.css` — and nothing below this
 * file learns that a preference exists. The alternative, a prop threaded to
 * every styled component, would have put the feature in fifty places and left
 * the fifty-first on the old face.
 *
 * ## The honesty rule
 *
 * `preferences` only ever becomes a document MAIN answered with, which is the
 * rule `usePinnedWindow` holds for the pin. Main refuses a face this build
 * cannot draw — Tiny5 for messaging above all — so a press that was corrected
 * has to show the correction rather than the wish.
 *
 * ## Both windows
 *
 * Installed in the shell AND in the message-panel window, because both paint
 * with these roles and only the shell holds Settings. `listen()` is how the
 * window that did not make the change hears about it; without it the panel's
 * bubbles would keep the old face until a reload.
 *
 * No module-scope singleton: each root calls this once, so per-call refs keep
 * the tests independent without a clearAll() ritual.
 */
export function useTypography() {
  // Matches the stylesheet's own declarations, so the first paint is right
  // before anything has been asked; sync() corrects it from the stored
  // document after mount.
  const preferences = ref<TypographyPreferences>({ ...DEFAULT_TYPOGRAPHY_PREFERENCES })
  const applying = ref(false)

  /**
   * Repoint the two roles on the document root.
   *
   * A `var()` reference rather than a stack: the stacks are design values and
   * stay declared once in `design-tokens.css` (see fontFamilies.ts).
   */
  function adopt(next: TypographyPreferences): void {
    preferences.value = next
    const root = document.documentElement
    root.style.setProperty(INTERFACE_FONT_PROPERTY, fontFamilyReference(next.interfaceFont))
    root.style.setProperty(MESSAGING_FONT_PROPERTY, fontFamilyReference(next.messagingFont))
  }

  /** Adopt the stored faces; on failure keep the last known ones. */
  async function sync(): Promise<void> {
    try {
      adopt(await window.api.getTypographyPreferences())
    } catch {
      // The bridge is unreachable: the stylesheet's own defaults are still the
      // most honest thing on screen, and the next successful call corrects it.
    }
  }

  /**
   * Ask main for a face, naming only the role that changed.
   *
   * The other role is carried from what is currently in force rather than
   * omitted, because the document is stored whole — sending one field would
   * make the other one's absence indistinguishable from a request to reset it.
   *
   * A second press while one is in flight is ignored: two racing writes could
   * land out of order and leave the section drawn at the older one.
   */
  async function set(patch: Partial<TypographyPreferences>): Promise<void> {
    if (applying.value) return
    applying.value = true
    try {
      adopt(await window.api.setTypographyPreferences({ ...preferences.value, ...patch }))
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  /** Hear a change the OTHER window made. Returns an unsubscribe function. */
  function listen(): () => void {
    return window.api.onTypographyPreferences(adopt)
  }

  return { preferences, applying, sync, set, listen }
}
