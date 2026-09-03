import { MAX_DWARF_TEXT_CHARS, type DwarfProvider } from '../domain/types'

/**
 * Starting a NEW agent session, as opposed to writing into one that already
 * runs (#86). The two are easy to confuse and are not the same act: everything
 * under textDelivery/ addresses a session that exists, this brings one into
 * existence, and until now the app had never started an agent at all.
 *
 * The mechanism is the provider's own programmatic interface rather than a
 * terminal window (#95): one headless `claude -p` turn in the mine's folder.
 * That makes the launched session a foreman by construction — a run with no
 * parent is a root, and role is topology (see contracts.ts) — so there is no
 * role to choose and none is plumbed here.
 *
 * Model and effort are deliberately left to the CLI's own defaults; #86 keeps
 * that an open question, and guessing here would bake an answer into a wire
 * contract before the question is settled.
 *
 * ## The prompt travels on stdin, not in argv
 *
 * Verified against the installed `claude --help`: `-p/--print` is documented as
 * "Print response and exit (useful for pipes)", its positional prompt is
 * optional, and `--input-format` takes "text" (the default) "only works with
 * --print". So a `claude -p` with no positional prompt reads it from stdin, and
 * that is what this builds — the format is passed explicitly rather than left
 * to a default that could move under us.
 *
 * This matters because argv is readable by any other process on this machine,
 * which #86 raises as an open question against docs/privacy.md and #59. The
 * relay has no such choice (it needs its courier instruction), and it is the
 * reason this module does NOT fence anything: the relay wraps a payload
 * addressed to a third party, whereas here the user's text IS the prompt.
 * Fencing it would put words in the user's mouth. It is only trimmed and
 * capped, for the reason sendDwarfText caps its own payload.
 */

/**
 * The prompt as it will reach the child: trimmed, and capped at the same limit
 * a delivered message gets. Applied at both boundaries on purpose — the
 * runtime uses it to refuse an empty prompt with an explanation, and the
 * launcher uses it because it is the thing that actually hands over the bytes.
 */
export function prepareLaunchPrompt(text: string): string {
  return text.trim().slice(0, MAX_DWARF_TEXT_CHARS)
}

/**
 * Argv for one headless turn. It carries no prompt: the text goes down stdin,
 * so nothing a user types is visible in this machine's process list.
 */
export function buildClaudeLaunchArgs(): string[] {
  return ['-p', '--input-format', 'text']
}

/**
 * The argv for one provider, or `null` when this engine has no verified
 * invocation for it (#168).
 *
 * Until #168 there was nothing to dispatch on: the engine called
 * `buildClaudeLaunchArgs` outright, so the Add Panel's chips could not reach it
 * and every launch was a Claude one. The `null` is the honest half of the
 * widening — argv does not transfer between CLIs, so a provider with no
 * verified spelling is refused rather than handed somebody else's flags.
 *
 * "Verified" means the same thing it means above: read out of the installed
 * CLI's own `--help`, not inferred. The evaluation docs deliberately stop short
 * of stating an argv for anything but Claude (`docs/command-surface-evaluation
 * .md` writes the Codex headless row as "`codex exec`", and hedges even the
 * registry row it would leave behind with "if a row exists at all"), so a
 * spelling that is not probed here does not get one.
 */
export function buildLaunchArgs(provider: DwarfProvider): string[] | null {
  if (provider === 'claude') return buildClaudeLaunchArgs()
  return null
}
