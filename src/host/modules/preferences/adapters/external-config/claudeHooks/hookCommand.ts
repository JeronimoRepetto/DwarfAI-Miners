// The command of DwarfAI's own Claude Code hook entry (ADR-016 items 1, 2 and 6.2; 16 §7.1), and
// the two probes the `claude-hooks` target identifies entries by. Pure: the platform is a
// parameter (the composition root passes the running one), never read here.
//
// Evaluated candidate: the legacy `src/main/hooks/hookCommand.ts` (found tree) — adapted. Kept:
// `TOKEN_PATTERN` and the hex check before a command is built, `curl.exe` on Windows, and the rule
// that every argument is one whitespace-free, quote-free word (identical in sh, Git Bash and
// PowerShell, which is how Claude Code runs a shell-form hook on each OS). Changed: the route is
// the Host ingress's `/hooks/claude/*` (ADR-016 item 1), and the arguments are reordered so the
// command opens with a prefix of DwarfAI's own that the old app's command never had: that prefix
// is the exact ownership probe (ADR-016 item 6.2), and the old app's command is matched by its own
// exact form, never adopted (16 §7.1 "Old-app entries"). Its loose `includes(HOOK_MARKER)` match is
// not kept: a foreign command that merely mentions DwarfAI would have been taken for its own.
//
// The token is carried in the `x-dwarfai-token` header of a curl invocation: ADR-016 item 1 names
// it the one accepted argv exposure of `claudeHookToken` (scoped to reporting hook events). It is
// never put in an environment variable another process inherits.
import { HostInvariantError } from '../../../../../kernel/domain/errors'

/** Kept from the legacy builder: lower-case hex only, so no value can add a shell separator. */
export const TOKEN_PATTERN = /^[0-9a-f]{16,}$/

/**
 * The Claude Code events DwarfAI's entry reports. Package gap: the package names no list; these are
 * the events the ingress accepts (ISSUE-133 `CLAUDE_HOOK_EVENTS`) except `PreToolUse` and
 * `PostToolUse`, which run before and after every tool call, so a curl per call would slow every
 * session down. `SessionStart` is a command hook like every other here: Claude Code runs
 * `SessionStart` hooks only as `command` or `mcp_tool`, never `http`
 * (https://code.claude.com/docs/en/hooks).
 */
export const INSTALLED_CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStop'
] as const

/** Seconds Claude Code gives the hook; curl's own `-m 2` is the real bound (legacy value). */
export const HOOK_TIMEOUT_S = 5

/** ADR-016 item 2: the custom header the ingress reads the channel token from. */
const TOKEN_HEADER = 'x-dwarfai-token'
/** The ingress path: every `/hooks/claude/*` path is the Claude hooks route (ISSUE-133). */
const ROUTE = '/hooks/claude/event'

export interface HookCommandOptions {
  /** The persisted ingress port (ADR-016 item 3). */
  port: number
  /** `claudeHookToken`, plaintext only here and in the written entry (ADR-016 item 1). */
  token: string
  platform: NodeJS.Platform
}

/** PowerShell aliases a bare `curl` to Invoke-WebRequest; `curl.exe` bypasses it in every shell. */
const curlFor = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'curl.exe' : 'curl')

/** `config_writes.owned_marker`: every command DwarfAI writes starts with it, and only those. */
export function ownedCommandPrefix(platform: NodeJS.Platform): string {
  return [
    curlFor(platform),
    '-s',
    '-m',
    '2',
    '--noproxy',
    '127.0.0.1',
    '-X',
    'POST',
    '-H',
    'Content-Type:application/json',
    // A bare `@-` is a PowerShell parse error, hence the joined form.
    '-d@-',
    '-H',
    `${TOKEN_HEADER}:`
  ].join(' ')
}

/**
 * The shell command Claude Code runs for each event: POST the event JSON from stdin to the
 * ingress, print nothing (a `SessionStart` hook's stdout is added to Claude's context; the
 * ingress answers 204 with no body). The port and token are validated, never escaped.
 */
export function buildHookCommand(options: HookCommandOptions): string {
  const { port, token, platform } = options
  if (!TOKEN_PATTERN.test(token)) {
    throw new HostInvariantError('claude-hooks: the hook token is not lower-case hex')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostInvariantError(`claude-hooks: invalid ingress port ${String(port)}`)
  }
  return `${ownedCommandPrefix(platform)}${token} http://127.0.0.1:${port}${ROUTE}`
}

/** The exact ownership probe (ADR-016 item 6.2): DwarfAI's own prefix, nothing looser. */
export function isOwnedHookCommand(command: unknown, platform: NodeJS.Platform): boolean {
  return typeof command === 'string' && command.startsWith(ownedCommandPrefix(platform))
}

/**
 * The old app's exact command (16 §7.1 legacy probe), as the legacy `buildHookCommand` in
 * `src/main/hooks/hookCommand.ts` (found tree) joins it: `curl` or `curl.exe`, its hex token, any
 * port, the `/dwarfai-miners-hook` route, and nothing else.
 */
const LEGACY_COMMAND =
  /^curl(?:\.exe)? -s -m 2 -X POST -H x-dwarfai-token:[0-9a-f]{16,} -H Content-Type:application\/json --noproxy 127\.0\.0\.1 -d@- http:\/\/127\.0\.0\.1:\d{1,5}\/dwarfai-miners-hook$/

export function isLegacyHookCommand(command: unknown): boolean {
  return typeof command === 'string' && LEGACY_COMMAND.test(command)
}
