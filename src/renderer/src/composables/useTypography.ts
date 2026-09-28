import { ref } from 'vue'
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  parseTypographyPreferences,
  type TypographyPreferences
} from '../types'
import { resolveTypography } from '../lib/typography/typePresets'

/**
 * State for Settings › Appearance, and the one place a chosen font style
 * actually reaches the page (#370, #635).
 *
 * ## Why this is a composable and not a change in every component
 *
 * The four type roles are custom properties every component reads —
 * `--f-display`, `--f-label`, `--f-meta` (inherited from `body`) and `--f-talk`,
 * which the #370 roles `--font-pixel` and `--font-conversation` follow in the
 * stylesheet — and the size steps are too. So applying a preference is a few
 * `setProperty` calls on the DOCUMENT ROOT, where an inline declaration
 * outranks the `:root` block in `design-tokens.css` — and nothing below this
 * file learns that a preference exists. A preset and a Custom face both set
 * the sizes their faces are sharp at (typePresets.ts, crisp sizes). The alternative, a prop threaded to
 * every styled component, would have put the feature in fifty places and left
 * the fifty-first on the old face.
 *
 * ## The honesty rule
 *
 * `preferences` only ever becomes a document MAIN answered with, which is the
 * rule `usePinnedWindow` holds for the pin. Main refuses a face this build
 * cannot draw — Tiny5 for messages above all — so a press that was corrected
 * has to show the correction rather than the wish.
 *
 * ## One window
 *
 * Installed in the shell, which holds Settings and, since #635, the message
 * panel too. `listen()` was how the panel's own window heard a change the
 * shell made (#370); with one page it hears the shell's own change a second
 * time, which applies the same document again.
 *
 * No module-scope singleton: each root calls this once, so per-call refs keep
 * the tests independent without a clearAll() ritual.
 */
export function useTypography() {
  // Matches the stylesheet's own declarations, so the first paint is right
  // before anything has been asked; sync() corrects it from the stored
  // document after mount.
  const preferences = ref<TypographyPreferences>({
    style: DEFAULT_TYPOGRAPHY_PREFERENCES.style,
    faces: { ...DEFAULT_TYPOGRAPHY_PREFERENCES.faces }
  })
  const applying = ref(false)

  /**
   * Repoint the four roles and the size steps on the document root.
   *
   * `var()` references rather than stacks: the stacks are design values and
   * stay declared once in `design-tokens.css` (see typePresets.ts).
   */
  function adopt(answer: TypographyPreferences): void {
    // Read through the shared parser once more: the preload already did, but a document this
    // build cannot draw must paint the defaults rather than throw out of the window's setup.
    const next = parseTypographyPreferences(answer)
    preferences.value = next
    const root = document.documentElement
    for (const [property, value] of Object.entries(resolveTypography(next))) {
      root.style.setProperty(property, value)
    }
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
   * Ask main for a whole choice: the style and its four faces.
   *
   * Whole rather than a patch, because what a press means depends on what is
   * in force — picking Custom keeps the faces of the style it leaves — and
   * Settings builds that from the preferences it was handed
   * (lib/settings/fontStyle.ts), so nothing here merges.
   *
   * A second press while one is in flight is ignored: two racing writes could
   * land out of order and leave the section drawn at the older one.
   */
  async function set(next: TypographyPreferences): Promise<void> {
    if (applying.value) return
    applying.value = true
    try {
      adopt(await window.api.setTypographyPreferences(next))
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
