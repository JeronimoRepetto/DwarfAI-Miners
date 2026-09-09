import type { DwarfPermissionDecision } from '../domain/types'

/**
 * What this app presses in somebody else's console to answer Claude Code's
 * permission dialog (#203) — measured, per decision, per CLI build.
 *
 * ## The dialog is a selector, and its options are not fixed
 *
 * The keybindings reference documents a `Confirmation` context taking `y` or
 * Enter to confirm and `n` or Esc to decline, and this issue carried that
 * reading as settled. It is wrong for this dialog. Measured on Claude Code
 * **2.1.261**, Windows console, 2026-09-05:
 *
 * - The prompt is a SELECTOR. A lone `y` does nothing at all.
 * - A DIGIT picks that option and fires it immediately — no Enter.
 * - `Esc` cancels the prompt, and the tool is declined.
 * - The option COUNT varies by tool. Two options in some places, three for a
 *   file write, and four for a Bash `rm`: 1 "Yes", 2 "Yes, and always allow
 *   …", 3 "Yes, and switch to auto mode", 4 "No".
 *
 * Two invariants survive that variation, and they are the whole basis of the
 * pair below: **"Yes" is always option 1**, and **"No" is always last**.
 *
 * ## So allow is a digit and deny cannot be
 *
 * `allow` is `1`, because the first option is Yes on every variant seen.
 *
 * `deny` is `Esc`, because "No" is LAST and the panel cannot know how many
 * options this particular dialog drew — it is rendered in a terminal this app
 * does not read. A positional digit would eventually mean "Yes, and always
 * allow …" to somebody who pressed Deny: a standing permission granted by the
 * button meant to refuse, which is the worst thing this route could do.
 *
 * The panel deliberately offers only those two. "Always allow" and "auto
 * mode" exist only as rows in a dialog this app cannot see, and an option the
 * panel cannot count is one it must not name — see DwarfPermissionDecision on
 * why nothing here outlives the prompt.
 *
 * ## What a LATE keystroke does, which is the risk this route carries
 *
 * The panel's card can be up to a poll old, so both keys can arrive after the
 * dialog is gone. The runtime re-reads the board and re-matches the open call
 * immediately before pressing anything (see typePermissionDecision), which
 * closes all but the last milliseconds. What is left:
 *
 * - A late `1` lands in the session's idle input box as one stray character.
 *   Nothing is sent, because nothing here ever presses Enter.
 * - A late `Esc` INTERRUPTS the running turn — the dialog was answered Yes at
 *   the terminal and the tool is now running. Accepted, and bounded: the
 *   person pressing Deny wanted that tool not to run, and an interrupted turn
 *   is the nearest thing to it. The panel says so in the status line under a
 *   deny rather than leaving it to be discovered.
 *
 * That asymmetry is why the two decisions carry different wording in the
 * panel, and why neither may ever be pressed on a board that was not just
 * re-read.
 */

/**
 * One key press, and which of the console tier's two doors it goes through.
 *
 * `escape` addresses `TextDeliveryPort.sendInterrupt`, which already presses
 * exactly this key behind each platform's own builder: a raw Esc into the
 * focused console, which is precisely what a decline is here. Nothing per-OS is
 * added for this — reaching for a new port method would have meant a second
 * Windows SendKeys builder and a second posix one, both spelling the key the
 * existing pair already spells.
 *
 * That method was Kick's path when this was written and is not any more (#329):
 * a kick ends the session's process instead, because a keystroke could not be
 * aimed at one tab of a shared terminal window. This IS still a keystroke at a
 * window and cannot be anything else — the dialog is drawn there and nowhere
 * else — so it inherits that limit rather than escaping it, and the port
 * refuses a shared-window focus rather than pressing Esc into another session.
 */
export type PermissionKeystroke =
  | {
      kind: 'text'
      /** Sent with `pressEnter: false`, always — a digit fires the selection by itself. */
      text: string
    }
  | { kind: 'escape' }

/**
 * The key each decision is answered with, or null where none has been
 * measured for it on this build. Two values, two independent measurements,
 * so half of this can ship while the other half is still being established.
 */
export const PERMISSION_KEYSTROKES: Record<DwarfPermissionDecision, PermissionKeystroke | null> = {
  // Measured: picks "Yes", the first option, and fires it. Not positional
  // guesswork — the first option is Yes on the two-, three- and four-option
  // variants alike.
  allow: { kind: 'text', text: '1' },
  // Measured: cancels the prompt, and the tool is declined. The one answer
  // that does not depend on counting rows in a dialog this app cannot see.
  deny: { kind: 'escape' }
}

/**
 * The key that answers `decision`, or null while nothing this build accepts
 * has been measured for it.
 *
 * Null rather than a throw, so the one caller has a plain branch to refuse on
 * and can say something the person can act on: the prompt is still open at
 * their terminal, and that is where it can be answered.
 */
export function permissionKeystrokeFor(
  decision: DwarfPermissionDecision
): PermissionKeystroke | null {
  const keystroke = PERMISSION_KEYSTROKES[decision]
  if (keystroke === null) return null
  return keystroke.kind === 'text' && keystroke.text === '' ? null : keystroke
}
