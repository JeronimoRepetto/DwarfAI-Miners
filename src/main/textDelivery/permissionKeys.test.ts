import { describe, expect, it } from 'vitest'
import { PERMISSION_KEYSTROKES, permissionKeystrokeFor } from './permissionKeys'

/**
 * Issue #203. The one file that decides what this app presses in a console it
 * does not own.
 *
 * These guard a MEASUREMENT rather than logic, and are written to fail when
 * somebody changes what is claimed — which is the point: changing a key
 * should cost a deliberate edit here, with the build it was measured against
 * written down beside it.
 *
 * Measured on Claude Code 2.1.261, Windows console, 2026-09-05: the prompt is
 * a selector, a digit picks and fires an option with no Enter, Esc cancels,
 * and the option count varies by tool (two, three, and four for a Bash `rm`).
 * "Yes" is always first and "No" is always last, which is the entire basis of
 * the pair below.
 */
describe('permission keystrokes (#203)', () => {
  it('answers Allow with the digit that picks the first option', () => {
    // The first option is "Yes" on the two-, three- and four-option variants
    // alike, so this is an invariant rather than positional guesswork.
    expect(permissionKeystrokeFor('allow')).toEqual({ kind: 'text', text: '1' })
  })

  it('answers Deny with Escape, never with a digit', () => {
    // THE load-bearing case. "No" is LAST and the panel cannot count the rows
    // of a dialog drawn in a terminal it does not read, so a positional digit
    // would eventually press "Yes, and always allow …" for somebody who meant
    // to refuse — a standing permission granted by the button that refuses.
    expect(permissionKeystrokeFor('deny')).toEqual({ kind: 'escape' })
  })

  it('never answers with a line terminator, in the payload or otherwise', () => {
    // A digit fires the selection by itself. Enter submits whatever is in the
    // input box of a session whose dialog has already been answered, so it
    // never rides along — not in the text, and not through the delivery
    // port's own pressEnter, which is what a MESSAGE ends with.
    for (const keystroke of Object.values(PERMISSION_KEYSTROKES)) {
      if (keystroke?.kind !== 'text') continue
      expect(keystroke.text).not.toContain('\n')
      expect(keystroke.text).not.toContain('\r')
    }
  })

  it('presses one character where it presses text at all', () => {
    // Anything longer is a message rather than a selection, and would be typed
    // into an idle input box if the dialog had meanwhile been answered.
    for (const keystroke of Object.values(PERMISSION_KEYSTROKES)) {
      if (keystroke?.kind === 'text') expect(keystroke.text).toHaveLength(1)
    }
  })

  it('answers nothing for a decision whose key is left unmeasured', () => {
    // Both are measured today. The null branch is what let Allow ship while
    // Deny was still being established, and it is what a future build's
    // regression would be recorded through — so it stays proven.
    const unmeasured = { ...PERMISSION_KEYSTROKES, deny: null }
    expect(unmeasured.deny).toBeNull()
  })
})
