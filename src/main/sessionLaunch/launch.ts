import type { LaunchTuning } from '../domain/launchTuning'
import type { DwarfProvider } from '../domain/types'
import { NOT_LAUNCHABLE } from '../domain/launchProviders'

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
 * Fencing it would put words in the user's mouth. It is only trimmed — and
 * since #431 only trimmed, the cap having gone with the bound that never
 * applied to a prompt on stdin.
 */

/**
 * The prompt as it will reach the child: trimmed, and nothing else. Applied at
 * both boundaries on purpose — the runtime uses it to refuse an empty prompt
 * with an explanation, and the launcher uses it because it is the thing that
 * actually hands over the bytes.
 *
 * AMENDED for #431 (was: `.trim().slice(0, MAX_DWARF_TEXT_CHARS)`, "capped at
 * the same limit a delivered message gets, for the reason sendDwarfText caps
 * its own payload"). Both halves of that reasoning were wrong by then. The
 * limit it borrowed was the keystroke budget of #10, which nothing types any
 * more; and the reason a MESSAGE answers to a ceiling at all is the command
 * line its channel is spawned with — which this prompt has no part of. The
 * section above says so at length and is the evidence: the prompt travels on
 * the child's STDIN, not in argv, precisely so that nothing a user types is
 * visible in this machine's process list. A prompt with no command line to fit
 * inside has no length to answer for, so there was nothing here to refuse — and
 * a cut applied for a bound that does not exist is the silent truncation #431
 * removed everywhere else.
 */
export function prepareLaunchPrompt(text: string): string {
  return text.trim()
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
 * Argv for one non-interactive OpenCode turn (#534) — a DETACHED, one-shot
 * launch only, on the same terms as Codex's was: no held-session
 * engine for OpenCode in this app (see HELDABLE_PROVIDERS in
 * shared/contracts.ts), so this starts the process and lets go, discovered
 * afterwards by the ordinary poll reading `opencode.db`.
 *
 * Read out of the measurement report's own live runs (M1, M3, M9,
 * docs/opencode-format.md): `opencode run --help` documents `-m <string>`
 * for the model and `--variant <string>` for the reasoning-effort key
 * (`session.model.variant` echoes the chosen one back, M1) — not
 * `--model`/`--effort` the way Claude's and Antigravity's own argv spell
 * theirs, and not Codex's `-c model_reasoning_effort=`. `--format json` is
 * what every measured invocation ran with. `launchRunner.ts`'s `stdio` is
 * `['pipe', stdoutFd, stderrFd]` now (#510's own correction) — every
 * provider's stdout is captured to a file the same way, this one included —
 * but that capture is still never read as OpenCode's own answer: `--format
 * json` is a stream of raw JSON EVENTS (`opencode run --help` documents only
 * that much; `docs/opencode-format.md` covers the `opencode.db` store this
 * app actually reads OpenCode's transcript from, never this stream), so
 * `ONE_SHOT_STDOUT_IS_TURN_TEXT.opencode` below is `false` and
 * `oneShotTurnOutcome` never turns this capture into `text`. `json` stays
 * because it is the flag every measurement in `docs/opencode-format.md` ran
 * with, not because anything here parses it — switching format on a guess
 * would be trading one unmeasured shape for another.
 *
 * An absent `model`/`effort` adds nothing, on the same terms as the three
 * builders above: whatever `opencode run` does with no `-m` at all is the
 * CLI's own default, and this app never invents one it has not measured.
 *
 * The prompt is never here (M9): `run` reads its message from stdin
 * whenever argv carries no positional one, for a fresh run and for
 * `--session` continuation alike — this argv carries no prompt at all, on
 * the same argv/stdin split the module header states. Positional and stdin
 * CONCATENATE rather than one overriding the other (M9d), which is exactly
 * why this builder must never add one: a stray positional here would ride
 * along with whatever the caller also puts on stdin.
 */
export function buildOpenCodeLaunchArgs(tuning: LaunchTuning = {}): string[] {
  return [
    'run',
    ...(tuning.model === undefined ? [] : ['-m', tuning.model]),
    ...(tuning.effort === undefined ? [] : ['--variant', tuning.effort]),
    '--format',
    'json'
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
 *
 * AMENDED for ISSUE-185, the step-3b deletion (was: also Codex's `-o` output
 * path, its `-c mcp_servers.jev...` delegation argv and its `--sandbox`
 * permission mode, dispatched to `buildCodexLaunchArgs`): today's Codex launch
 * left the tree, and the Host's Codex drivers are Codex's only launcher.
 */
export function buildLaunchArgs(provider: DwarfProvider, tuning: LaunchTuning = {}): string[] {
  switch (provider) {
    case 'claude':
      return buildClaudeLaunchArgs(tuning)
    case 'codex':
      // AMENDED for ISSUE-185, the step-3b deletion (was: `buildCodexLaunchArgs`,
      // its `codex exec … -` argv): `LAUNCHABLE_PROVIDERS` refuses Codex before
      // this is reached, so this arm is a refusal, as Antigravity's is.
      throw new Error(NOT_LAUNCHABLE)
    case 'antigravity':
      // AMENDED for ISSUE-189, the step-3e deletion (was: its own `agy` argv,
      // #237 step 4, #282): today's Antigravity launch left the tree, and
      // `LAUNCHABLE_PROVIDERS` refuses it before this is reached, so this arm
      // is the refusal `opencode`'s was before #534.
      throw new Error(NOT_LAUNCHABLE)
    case 'opencode':
      // AMENDED for #534 (was: `throw new Error(NOT_LAUNCHABLE)` — #444 left
      // OpenCode observed only, with no launch invocation this app had
      // measured). #534 measured `run` (docs/opencode-format.md), so this
      // arm is dispatched exactly like Claude's, Codex's and Antigravity's
      // above.
      return buildOpenCodeLaunchArgs(tuning)
  }
}

/**
 * Whether a provider's ONE-SHOT stdout — the capture `TurnOutcomeWatch`
 * (launchRunner.ts) reads back after the process exits — is that turn's own
 * final answer, printed as prose, or an opaque machine envelope
 * `oneShotTurnOutcome` (oneShotTurnOutcome.ts) must not read as one (#510
 * correction).
 *
 * Decided HERE rather than beside `oneShotTurnOutcome` itself, because this
 * is where each provider's own output format is already decided and argued
 * at length, immediately above — the fact this table states is a direct
 * restatement of that same argv choice, never a second, independent
 * judgment call about it. `buildLaunchSpawn` (launchRunner.ts) captures
 * every provider's stdout the same way regardless of this table — the
 * CAPTURE stays provider-agnostic, on purpose — and this is the one bit
 * `launchClaudeSession` reads out of it before handing a `LaunchInvocation`
 * to that provider-agnostic runner.
 *
 * - `claude`: `true`. `buildClaudeLaunchArgs` carries no `--output-format`
 *   flag at all — `claude -p` prints its response as plain text by default
 *   (Claude Code 2.1.263's own `--help`, quoted above `buildClaudeLaunchArgs`).
 * - `codex`: `true`, unread since the step-3b deletion (ISSUE-185): today's
 *   launcher no longer starts Codex. `codex exec` has no `--format`/`--json`
 *   flag in its own `--help`, so its stdout was prose.
 * - `antigravity`: `true`, unread since the step-3e deletion (ISSUE-189):
 *   today's launcher no longer starts Antigravity. Its own default
 *   `--output-format` is `text` (Antigravity CLI 1.1.26's own `--help`).
 * - `opencode`: `false`, the one provider this table refuses. `--format json`
 *   (`buildOpenCodeLaunchArgs` above) is documented as "raw JSON events" and
 *   nothing more specific — `opencode run --help`'s own words — and
 *   `docs/opencode-format.md` covers the `opencode.db` store this app
 *   already reads OpenCode's transcript from, never this stream. Nothing
 *   over this app's own evidence bar (official docs, an installed binary's
 *   `--help`, or a measured reproduction — never a guess) documents that
 *   stream's shape, so nothing here may parse it as prose. Losing `text` on
 *   this one path costs nothing a person can read: the ordinary OpenCode
 *   observer route already reads this same session's own answer out of its
 *   store.
 *
 * Exhaustive the same way `PRODUCT_NAME` (domain/launchProviders.ts) already
 * is: a `Record` over every `DwarfProvider`, so a build that adds a fifth
 * provider fails to compile here until someone has measured whether ITS
 * one-shot stdout is prose — never a silent assumption that it is.
 */
export const ONE_SHOT_STDOUT_IS_TURN_TEXT: Readonly<Record<DwarfProvider, boolean>> = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode: false
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
