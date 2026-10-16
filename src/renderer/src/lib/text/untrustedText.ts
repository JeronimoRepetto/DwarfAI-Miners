/**
 * The C-08 untrusted-string rule (18 §5.1, extends NFR-SEC-07), in one pure function so that the
 * design review OI-18-6 leaves open changes exactly one place.
 *
 * A file name, a custom name, a tool summary, an ask payload or a tool-output tail is text that a
 * provider, a repository or another program wrote. It is drawn as a text node, never as markup,
 * and before it is drawn this function takes out the characters that are not text at all:
 *
 * 1. Terminal escape sequences (ECMA-48): a whole CSI (`ESC [ … final`, or the C1 `U+009B`), a whole
 *    control string (OSC, DCS, SOS, PM, APC, up to BEL or ST, or to the end when it was never
 *    terminated) and every other `ESC` sequence. Removing only the `ESC` would leave `[31m` on the
 *    screen, so the sequence goes with it. A tail cut off inside a sequence loses that sequence.
 * 2. C0 and C1 control characters and DEL, except tab and line feed, which are layout a person can
 *    see. A carriage return goes, so `\r\n` reads as one line break.
 * 3. The bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). They draw
 *    nothing and exist only to reorder: without them nothing inside the string can open a direction
 *    run, and the caller's bidi isolation (`<bdi>` or `unicode-bidi: isolate`) bounds what is left.
 *
 * Nothing a person can see is rewritten. Right-to-left letters, the implicit marks (U+200E, U+200F,
 * U+061C) and the zero-width joiners stay, because they are how real text in real scripts is
 * written; an emoji sequence or a Persian word is not a spoof. What a call site does with the
 * result is its own: it renders it inside a bidi-isolated text node.
 */

/** OSC, DCS, SOS, PM and APC: a control string that runs up to BEL or ST, or to the end. */
const CONTROL_STRING =
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g

/** A control sequence: parameters, intermediates, one final byte, or the end of a cut-off tail. */
const CONTROL_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)/g

/** Every other escape sequence: intermediates and one final byte, or the end. */
const ESCAPE_SEQUENCE = /\u001b[ -/]*(?:[0-~]|$)/g

/** C0 except tab (U+0009) and line feed (U+000A), DEL, C1, and the bidi controls. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** The string as it may be drawn: controls, escape sequences and bidi controls taken out. */
export function untrustedText(raw: string): string {
  return raw
    .replace(CONTROL_STRING, '')
    .replace(CONTROL_SEQUENCE, '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
}
