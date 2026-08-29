/**
 * The single string that identifies a hook entry as this app's.
 *
 * It doubles as the listener's route, so one token in the command string is
 * both the endpoint and the ownership marker — install and uninstall never
 * need any other bookkeeping, and a foreign entry can never be mistaken for
 * ours (the same substring-identity rule agentpet's `is_ours` uses).
 */
export const HOOK_MARKER = 'dwarfai-miners-hook'

/** The only path the listener answers on. */
export const HOOK_ROUTE = `/${HOOK_MARKER}`

/** Per-install shared secret header. Lowercase: Node lowercases incoming header names. */
export const HOOK_TOKEN_HEADER = 'x-dwarfai-token'

/** Seconds curl may spend on one relay before giving up. */
const RELAY_TIMEOUT_S = 2

const TOKEN_PATTERN = /^[0-9a-f]{16,}$/

export interface HookCommandOptions {
  port: number
  token: string
  platform: NodeJS.Platform
}

/**
 * Windows names it `curl.exe` on purpose: PowerShell aliases bare `curl` to
 * Invoke-WebRequest, and Claude Code falls back to PowerShell on hosts without
 * Git Bash. The `.exe` suffix bypasses the alias in every Windows shell.
 */
export function curlBinaryFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'curl.exe' : 'curl'
}

/**
 * Recognise a hook entry this app installed.
 *
 * Matching is on the marker substring only, never the whole command, so an
 * entry written by an earlier port or an earlier token is still recognised and
 * gets replaced instead of duplicated. Anything else — including a hook from
 * another relay tool — is foreign and must be left untouched.
 */
export function isOurHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(HOOK_MARKER)
}

/**
 * The shell command Claude Code runs for each installed hook event: read the
 * event JSON from stdin, POST it to the loopback listener, exit.
 *
 * Every argument is one whitespace-free, quote-free token. That is not
 * cosmetic — a shell-form hook is parsed by `sh` on Unix, and by Git Bash *or*
 * PowerShell on Windows, and only such tokens survive all three identically
 * (a bare `@-` is a hard PowerShell parse error, hence `-d@-`). The port and
 * token are validated rather than escaped, so no value can ever introduce a
 * separator into the command.
 *
 * The listener answers 204 with an empty body: a SessionStart hook's stdout is
 * injected into Claude's context, so the relay must print nothing at all.
 */
export function buildHookCommand(options: HookCommandOptions): string {
  const { port, token, platform } = options
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[hooks] Invalid listener port: ${String(port)}`)
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('[hooks] Invalid hook token: expected at least 16 lowercase hex characters')
  }
  return [
    curlBinaryFor(platform),
    '-s',
    '-m',
    String(RELAY_TIMEOUT_S),
    '-X',
    'POST',
    '-H',
    `${HOOK_TOKEN_HEADER}:${token}`,
    '-H',
    'Content-Type:application/json',
    '--noproxy',
    '127.0.0.1',
    '-d@-',
    `http://127.0.0.1:${port}${HOOK_ROUTE}`
  ].join(' ')
}
