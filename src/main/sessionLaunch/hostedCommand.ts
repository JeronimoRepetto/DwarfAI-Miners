import { isShellShim } from './launch'

/**
 * Reading the command somebody typed into Add > Other (#194).
 *
 * ## Why this exists at all
 *
 * `docs/custom-launch-command.md` used to rule that the panel would not start a
 * command of your own, on the ground that a custom process writes no session
 * store and therefore has no dwarf. The maintainer reversed that on 2026-09-04:
 * the panel observes terminals AND is a terminal itself, and a process the
 * panel HOLDS needs no session file to be observed, because the panel is its
 * stdio. The doc carries the reversal and what it does not promise; this module
 * is the first half of the mechanism.
 *
 * ## No shell, ever
 *
 * The old ruling described the safe version and then never built it: "no shell
 * anywhere, the command resolved as a program name plus an argv array, anything
 * carrying shell metacharacters refused". That is exactly this. It matters more
 * here than it does for a detected CLI, whose argv is a constant: this argv
 * comes from a text box, and `spawn` is called with `shell: false`, so a
 * pipeline would not be INTERPRETED — it would be handed to the program as
 * literal arguments and quietly do something other than what was typed. A
 * refusal that says why beats a launch that lies about what it ran.
 *
 * Pure, so the whole posture is asserted by unit tests rather than inferred
 * from a spawn no test may perform.
 *
 * ## What it deliberately does not do
 *
 * No expansion of any kind: no globs, no variables, no `~`. A `*` reaches the
 * program as an asterisk, because with no shell in the chain that is what it
 * is. Nothing here resolves the program against PATH either — `spawn` does
 * that, and reimplementing it would be a second answer to "which program is
 * this" for the app to be wrong with.
 */

/** Refusals, phrased for the panel. Fixed copy, and never a path — the wire rule AgentProviderOption states. */
export const EMPTY_COMMAND_REFUSAL = 'Type a command first.'

export const SHELL_METACHARACTER_REFUSAL =
  'That command is run directly, with no shell, so pipes, redirects, chains and ' +
  'variables cannot work — remove them and name one program with its arguments.'

export const UNCLOSED_QUOTE_REFUSAL = 'That command has a quote that is never closed.'

export const SHIM_REFUSAL =
  'A .cmd or .bat file cannot be started without a shell — name the program it runs instead.'

/**
 * Every character a shell would treat as syntax, refused rather than passed on
 * as a literal argument.
 *
 * `"` is absent on purpose: it is the one grouping form this understands (see
 * `tokenize`). `'` is present because the two shells this app runs on disagree
 * about it — POSIX groups with it, cmd.exe treats it as an ordinary character —
 * and a panel that picked one would be right on one platform and wrong on the
 * other. `%` is here for the same reason `$` is: somebody typing `%USERPROFILE%`
 * means the expansion, and with no shell in the chain they would get the eleven
 * characters instead.
 */
const SHELL_METACHARACTERS = /[&|;<>()$`'%\n\r]/

/** The parse's verdict: a program and its argv, or the reason it was refused. */
export type HostedCommand =
  { ok: true; program: string; args: string[] } | { ok: false; reason: string }

/**
 * Split on whitespace, with double quotes holding one argument together.
 *
 * Grouping, not a shell: the quotes are removed, nothing inside them is
 * expanded, there are no escapes and no nesting. Without it the most ordinary
 * Windows spelling of a program path — a quoted `C:\Program Files\…` — would be
 * refused for being correct, which is a refusal nobody could act on.
 *
 * Null for a quote that is never closed. Guessing where it ended is how the
 * argv stops being the one that was typed.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const character of command) {
    if (character === '"') {
      quoted = !quoted
      // A pair of quotes is a real (empty) argument, so opening one commits to
      // a token even if nothing follows before it closes.
      started = true
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (quoted) return null
  if (started) tokens.push(current)
  return tokens
}

/**
 * The program and argv for one typed command, or the reason it will not be run.
 *
 * The order of the refusals is the order of how cheap they are to be sure of,
 * and every one of them is a sentence the panel shows: #194's report was "it
 * froze", which was a refusal nobody could see, and the fix is not allowed to
 * reintroduce a silent no.
 */
export function parseHostedCommand(typed: string): HostedCommand {
  const command = typed.trim()
  if (command === '') return { ok: false, reason: EMPTY_COMMAND_REFUSAL }
  if (SHELL_METACHARACTERS.test(command)) {
    return { ok: false, reason: SHELL_METACHARACTER_REFUSAL }
  }
  const tokens = tokenize(command)
  if (tokens === null) return { ok: false, reason: UNCLOSED_QUOTE_REFUSAL }
  const [program, ...args] = tokens
  if (program === undefined || program === '') {
    return { ok: false, reason: EMPTY_COMMAND_REFUSAL }
  }
  // Verified on this machine's Node (v24.11.1) for #193: a `.cmd`/`.bat` spawn
  // with `shell: false` throws EINVAL outright since the CVE-2024-27980 fix. So
  // it is refused BY NAME rather than left to surface as "could not be
  // started" — the refusal a person can act on has to say what it refused.
  //
  // #193 taught the detected-CLI launcher to READ a shim for the program it
  // names instead of refusing it, and that reading is not available here: it
  // starts from a path detection produced, and this starts from a name somebody
  // typed, which may not be a path at all.
  if (isShellShim(program)) return { ok: false, reason: SHIM_REFUSAL }
  return { ok: true, program, args }
}
