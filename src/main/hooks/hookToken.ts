import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import type { HookFsLike } from './hookFs'

/**
 * The per-install shared secret that separates a real Claude hook from any
 * other process on this machine.
 *
 * The listener is bound to loopback, which keeps it off the network but does
 * nothing about local callers: without a secret, any program running as this
 * user could POST forged events and drive the scanner. The token is generated
 * once, stored beside the app's other user-data state, and embedded in the
 * hook command Claude Code runs — so it never travels further than this
 * machine's own config.
 */

/** File name under Electron's userData directory. */
export const HOOK_TOKEN_FILE = 'hook-token'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

export interface HookTokenOptions {
  fs: HookFsLike
  path: string
  /** Injected in tests; defaults to 16 cryptographically random bytes as hex. */
  generate?: () => string
}

function generateToken(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Return this install's token, creating and persisting one the first time.
 *
 * A stored value that is not a well-formed token is replaced rather than
 * trusted: a truncated or hand-edited file would otherwise produce a command
 * string this app refuses to build, leaving the toggle permanently broken.
 */
export async function loadOrCreateHookToken(options: HookTokenOptions): Promise<string> {
  const stored = (await options.fs.readText(options.path))?.trim()
  if (stored !== undefined && TOKEN_PATTERN.test(stored)) return stored

  const token = (options.generate ?? generateToken)()
  await options.fs.ensureDir(dirname(options.path))
  await options.fs.writeText(options.path, token)
  return token
}

/**
 * Constant-time token comparison for the request header.
 *
 * Length is checked first (timingSafeEqual throws on a mismatch), and an empty
 * expected token never matches anything — a listener that somehow started
 * without a secret must reject every caller rather than accept every caller.
 */
export function tokensMatch(expected: string, presented: unknown): boolean {
  if (expected === '' || typeof presented !== 'string') return false
  const expectedBytes = Buffer.from(expected, 'utf8')
  const presentedBytes = Buffer.from(presented, 'utf8')
  if (expectedBytes.length !== presentedBytes.length) return false
  return timingSafeEqual(expectedBytes, presentedBytes)
}
