import { isCodexPermissionMode, type CodexPermissionMode, type DwarfProvider } from './types'

/**
 * What each Codex permission mode means on the command line (#635, PO decision
 * 2026-09-28), and the boundary check that decides whether a launch may name
 * one.
 *
 * Pure, and in `domain/` for the reason `launchTuning.ts` is: `main/index.ts`
 * owns Electron's `ipcMain`, so its parse functions cannot be unit tested, and
 * the rule lives here for the endpoint to call.
 *
 * ## The flags, read out of the installed CLI
 *
 * codex-cli 0.153.4, `codex exec --help`, 2026-09-28:
 *
 *     -s, --sandbox <SANDBOX_MODE>
 *         Select the sandbox policy to use when executing model-generated shell commands
 *         [possible values: read-only, workspace-write, danger-full-access]
 *
 * That is the whole permission surface `codex exec` has. Its help lists no
 * `-a/--ask-for-approval` (the top-level `codex --help` does, for the
 * interactive CLI), and `codex exec -a on-request` is refused outright:
 * "error: unexpected argument '-a' found". A detached launch is `codex exec`
 * with nobody attached to answer, and every one of this machine's 0.153.4
 * `exec` threads records `approval_mode` `never` in Codex's own
 * `state_5.sqlite` — so the sandbox is the one axis a detached launch can set,
 * and each mode below is a sandbox and nothing else.
 *
 * - `default` → nothing. Codex keeps the sandbox it would have chosen with no
 *   flag, which is what makes an untouched select launch exactly as before.
 * - `workspace-write` → `--sandbox workspace-write`: commands run on their own
 *   and may write inside the workspace.
 * - `read-only` → `--sandbox read-only`: commands may read and never write.
 *
 * `danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` are
 * never produced: no mode maps to them, and CODEX_PERMISSION_MODES has no id
 * that could.
 *
 * The flags go BEFORE the trailing `-` prompt positional, because the usage
 * line is `codex exec [OPTIONS] [PROMPT]` — `buildCodexLaunchArgs` places them.
 * They are the same words on Windows, macOS and Linux: how the program is
 * reached (a Windows npm shim runs `node <entry>`) is decided before argv, and
 * never changes what argv says.
 */
const CODEX_PERMISSION_ARGS: Readonly<Record<CodexPermissionMode, readonly string[]>> = {
  default: [],
  'workspace-write': ['--sandbox', 'workspace-write'],
  'read-only': ['--sandbox', 'read-only']
}

/** The argv fragment one Codex permission mode means — a fresh array, safe to spread. */
export function codexPermissionArgs(mode: CodexPermissionMode): string[] {
  return [...CODEX_PERMISSION_ARGS[mode]]
}

/**
 * The permission mode one DETACHED launch payload asked for, or null when it
 * asked for something that cannot be carried out — on `parseLaunchTuning`'s
 * terms: absent degrades to the CLI's own default, and present-but-unusable
 * takes the whole request down rather than being silently dropped.
 *
 * Only Codex has a mode on this channel. A mode named for any other provider
 * is refused rather than ignored, because a detached launch of that provider
 * would start with no flag for it, report `launched: true`, and nothing on
 * screen would say the instruction went nowhere.
 */
export function parseLaunchPermissionMode(
  provider: DwarfProvider,
  payload: Record<string, unknown>
): { permissionMode?: CodexPermissionMode } | null {
  if (payload.permissionMode === undefined) return {}
  if (provider !== 'codex' || !isCodexPermissionMode(payload.permissionMode)) return null
  return { permissionMode: payload.permissionMode }
}
