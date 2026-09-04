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
 * Argv for one non-interactive Codex run, on the same terms as Claude's.
 *
 * ## What a Codex launch can honestly be
 *
 * Not a held session. `docs/command-surface-evaluation.md` states outright that
 * "Codex has no held-session engine in this app (no equivalent of
 * `sdkHeldSession.ts` exists for it)", and `docs/question-capture-evaluation.md`
 * marks the `codex exec` row No for live capture and No for answering. So the
 * only shape available is the DETACHED one: start the process in the mine's
 * folder, let go of it, and let the ordinary poll discover it afterwards
 * through Codex's own rollout storage — where the thread row's `cwd` is what
 * files it under the mine it was launched from. Nothing here holds a stream,
 * and nothing pretends to.
 *
 * ## Why this exact spelling
 *
 * Read out of the installed CLI's own help, exactly as Claude's argv was
 * (codex-cli 0.151.0 — the same build `docs/console-hosting.md` probed):
 *
 *     Usage: codex exec [OPTIONS] [PROMPT]
 *     [PROMPT]  Initial instructions for the agent. If not provided as an
 *               argument (or if `-` is used), instructions are read from stdin.
 *
 * `-` is therefore the documented way to say "the prompt is on stdin", and it
 * is passed rather than relying on the bare-positional default, for the reason
 * Claude's argv names `--input-format text`: a default can move under us. The
 * argv/stdin split itself is the privacy rule at the top of this file, which
 * was never Claude-specific — argv is readable by any process on this machine
 * whichever binary owns it.
 *
 * ## The two flags that are deliberately NOT here
 *
 * `--ephemeral` ("Run without persisting session files to disk") would make the
 * launch invisible: the panel observes sessions through the provider's own
 * storage, so a session that persists nothing has no dwarf, ever.
 *
 * `--skip-git-repo-check` is absent for the opposite reason — it would make
 * more launches succeed. Codex declines to run outside a Git repository on
 * purpose; overriding that silently would be this panel making a safety
 * decision inside somebody's own folder. If Codex refuses, that refusal is
 * Codex's to give.
 */
export function buildCodexLaunchArgs(): string[] {
  return ['exec', '-']
}

/**
 * The argv for one provider (#168).
 *
 * Until #168 there was nothing to dispatch on: the engine called
 * `buildClaudeLaunchArgs` outright, so the Add Panel's chips could not reach it
 * and every launch was a Claude one whichever chip was pressed.
 *
 * Exhaustive on purpose — no default branch, so adding a third provider to
 * `DWARF_PROVIDERS` fails to compile here until someone has probed its CLI and
 * written its spelling down. Argv does not transfer between CLIs, so the thing
 * a default arm would do is lend one CLI's flags to another: either an opaque
 * failure or, worse, a process that starts and is not what the user chose.
 */
export function buildLaunchArgs(provider: DwarfProvider): string[] {
  switch (provider) {
    case 'claude':
      return buildClaudeLaunchArgs()
    case 'codex':
      return buildCodexLaunchArgs()
  }
}

/**
 * Whether a detected binary is a batch shim that cannot be spawned directly.
 *
 * Verified against this machine's Node (v24.11.1): `spawn('probe.cmd', [],
 * { shell: false })` throws `EINVAL` outright. Since the CVE-2024-27980 fix a
 * `.cmd`/`.bat` needs `shell: true`.
 *
 * This is not hypothetical: `conventionalCliPaths` returns
 * `AppData\Roaming\npm\codex.cmd` on Windows, the PATH lookup admits `.cmd` and
 * `.bat` for either CLI, and a pnpm machine answers `where codex` with
 * `...\pnpm\bin\codex.CMD`. Until #193 the launcher answered a shim with a
 * refusal borrowed from the queue, naming `CODEX_CLI_PATH` as the exit — one a
 * packaged user has no Settings UI to take, and a block whose only exit cannot
 * be taken is worse than no block. The queue's reason was also never the
 * launcher's: the queue's payload is an argv element a shell would re-parse,
 * whereas this argv is a constant and the prompt is on stdin. So a shim is now
 * the cue to read the program it points at and start that directly — see
 * `resolveShimTarget` in cliDetection.ts for the reading, and for why the shim
 * is read rather than run through cmd.exe.
 *
 * Asked of a path string rather than of the host, so the Windows case is
 * asserted by tests running on any OS.
 */
export function isShellShim(binaryPath: string): boolean {
  const lower = binaryPath.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}
