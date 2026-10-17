// `parseHostedCommand` (ISSUE-165; 18 C-17, T-19; NFR-SEC-09; ADR-020 item 3): the command a person
// typed for "Other…", read as one program and its argv, with no shell. Pure (05 §2.2, R1).
//
// Candidate decision (21 §6): `src/main/sessionLaunch/hostedCommand.ts` (at 0bfd108) is kept. Its 12
// tests pass unchanged here (hostedCommand.test.ts), and it already is the C-17 posture: every
// metacharacter, an unclosed quote and a `.cmd`/`.bat` shim refused, no expansion, no PATH lookup.
// It moves into launching's domain whole; the one change is that its shim check, imported from the
// legacy launcher, is restated here as `isShellShim` (R1: a domain imports no legacy code; R16).
// A refusal's sentence is diagnostic `detail` only (ADR-020 item 3): the notice is cause 3's.

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

/** A `.cmd`/`.bat` name in any case, because Windows paths are case-insensitive. */
function isShellShim(program: string): boolean {
  const lower = program.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

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
