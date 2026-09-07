import type { LaunchTuning } from '../domain/launchTuning'
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
 * Model and effort used to be left to the CLI's own defaults outright — #86
 * kept that an open question, and guessing would have baked an answer into a
 * wire contract before the question was settled. #239 settled it, and the
 * answer is not a guess: the request may CARRY a model and an effort, and when
 * it carries neither the argv below is byte for byte what it always was. So
 * the default is still the CLI's own, and it is now the CLI's own by omission
 * rather than by this file having no way to say otherwise.
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
 *
 * Both tuning flags are read out of the installed CLI's own help, exactly as
 * the argv above was — Claude Code 2.1.263, 2026-09-07:
 *
 *     --model <model>   Model for the current session. Provide an alias for the
 *                       latest model (e.g. 'fable', 'opus', or 'sonnet') or a
 *                       model's full name (e.g. 'claude-fable-5').
 *     --effort <level>  Effort level for the current session (low, medium,
 *                       high, xhigh, max)
 *
 * `--effort` is the fact #239 asked to be verified before anything was wired,
 * because the issue's own table was unsure of it ("`CLAUDE_EFFORT`-style env
 * or `--effort` — verify the flag on this build before relying on it"). It is
 * a documented flag on this build, with its five levels printed beside it, and
 * those five are also the Agent SDK's `EffortLevel` — so the detached and held
 * routes take the same vocabulary. See PROVIDER_EFFORT_LEVELS.
 *
 * An absent field adds nothing, which is what keeps an untuned launch byte for
 * byte what it was before #239.
 */
export function buildClaudeLaunchArgs(tuning: LaunchTuning = {}): string[] {
  return [
    '-p',
    '--input-format',
    'text',
    ...(tuning.model === undefined ? [] : ['--model', tuning.model]),
    ...(tuning.effort === undefined ? [] : ['--effort', tuning.effort])
  ]
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
/*
 * ## The two tuning flags, and why only one of them is a flag (#239)
 *
 * Read out of the installed CLI's own help, on 2026-09-07 (codex-cli 0.153.4):
 *
 *     -m, --model <MODEL>       Model the agent should use
 *     -c, --config <key=value>  Override a configuration value that would
 *                               otherwise be loaded from `~/.codex/config.toml`
 *                               ... The `value` portion is parsed as TOML. If
 *                               it fails to parse as TOML, the raw string is
 *                               used as a literal.
 *
 * So the model has a flag of its own and the effort does not: Codex names no
 * effort option anywhere in `codex --help` or `codex exec --help`, and the
 * level travels as an override on the key its own config file documents
 * (`model_reasoning_effort`). A bare level is not valid TOML, so it arrives as
 * the literal string the help promises, which is the spelling that file uses.
 *
 * Both go BEFORE the `-` positional, because the usage line is
 * `codex exec [OPTIONS] [PROMPT]`: a flag written after the prompt would be
 * read as an argument to it rather than as an option.
 */
export function buildCodexLaunchArgs(tuning: LaunchTuning = {}): string[] {
  return [
    'exec',
    ...(tuning.model === undefined ? [] : ['-m', tuning.model]),
    ...(tuning.effort === undefined ? [] : ['-c', `model_reasoning_effort=${tuning.effort}`]),
    '-'
  ]
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
 *
 * The tuning is dispatched rather than appended (#239), for that same reason
 * and now with a worked example of it: Claude's effort is `--effort <level>`
 * and Codex's is `-c model_reasoning_effort=<level>`, which is not a variant
 * spelling of the same flag but a different mechanism. One shared tail here
 * would hand each CLI the other's.
 */
export function buildLaunchArgs(provider: DwarfProvider, tuning: LaunchTuning = {}): string[] {
  switch (provider) {
    case 'claude':
      return buildClaudeLaunchArgs(tuning)
    case 'codex':
      return buildCodexLaunchArgs(tuning)
    case 'antigravity':
      // The gate above doing its job, on the first provider to reach it (#237).
      // Antigravity arrives as an OBSERVER: this app reads its store and has
      // proven no invocation of `agy`, so it is absent from
      // LAUNCHABLE_PROVIDERS and nothing offers a chip that would come here.
      // A throw rather than a guessed argv, and rather than a `never` cast
      // that would read as "unreachable" while silently spawning a bare
      // executable: the caller already turns this into "could not be started",
      // which is exactly what happened.
      throw new Error('[launch] antigravity has no launch invocation yet (#237): observer only')
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
