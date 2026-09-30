import type { LogRecord } from './logRecord'
import { redactSecrets } from './redactSecrets'

/** `msg` and `errCode` are cut to this many characters after redaction (ADR-026 item 5). */
export const LOG_TEXT_MAX_CHARS = 300
/** `stack` keeps at most this many frames (ADR-026 item 5). */
export const LOG_STACK_MAX_FRAMES = 10
/** `stack` is at most this many characters (ADR-026 item 5). */
export const LOG_STACK_MAX_CHARS = 2000

/**
 * A home directory inside text: `C:\Users\<name>` (either slash, any case), `/home/<name>`,
 * `/Users/<name>`. The name runs to the next separator or the end of the line, so a name with spaces
 * is replaced whole; the rule is deliberately lossy, like `redactSecrets`.
 */
const HOME_DIR = /(?:\b[A-Za-z]:)?[\\/]+(?:Users|home)[\\/]+[^\\/\r\n]+/gi

function replaceHome(s: string): string {
  return s.replace(HOME_DIR, '~')
}

/** Cuts by code point, so a surrogate pair is never split. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

/** The pipeline for `msg` and `errCode` (ADR-026 item 5): home → `redactSecrets` → 300 characters. */
export function redactText(s: string): string {
  return truncate(redactSecrets(replaceHome(s)), LOG_TEXT_MAX_CHARS)
}

const FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/
const DEPENDENCY_FRAME = /^\s*at <dependency>\s*$/
const DEPENDENCY = '    at <dependency>'
const FUNCTION_NAME = /^[\w$.<> [\]]{1,200}$/
const RELATIVE_PATH = /^[\w@.+-]+(?:\/[\w@.+-]+)*$/
const ABSOLUTE_OR_SCHEME = /^(?:\/|[A-Za-z][\w+.-]*:)/

function normalizePath(p: string): string {
  let path = p.replace(/^file:\/\//i, '')
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path.replace(/\\/g, '/')
}

function underRoot(path: string, root: string): string | null {
  const prefix = `${root}/`
  const caseFold = /^[A-Za-z]:/.test(root)
  const head = path.slice(0, prefix.length)
  const same = caseFold ? head.toLowerCase() === prefix.toLowerCase() : head === prefix
  return same ? path.slice(prefix.length) : null
}

/** The relative path of a DwarfAI frame, or `null` for any frame that is not provably DwarfAI code. */
function dwarfaiPath(rawPath: string, appRoot: string | undefined): string | null {
  const path = normalizePath(rawPath)
  const relative =
    appRoot === undefined
      ? path
      : (underRoot(path, normalizePath(appRoot).replace(/\/+$/, '')) ?? path)
  if (ABSOLUTE_OR_SCHEME.test(relative) || !RELATIVE_PATH.test(relative)) return null
  return relative
}

/**
 * The bounded `stack` of ADR-026 item 5. Only frames are kept, never the message lines above them;
 * `node_modules` frames become `<dependency>`; a frame is kept only when its path is inside `appRoot`
 * (made relative to it) or already relative, so runtime internals and paths outside the app are
 * dropped; at most 10 frames and 2 000 characters, cut at a frame boundary. Idempotent: its own output
 * passes through unchanged, so a writer applies it with the app root and `toLogLine` again without.
 */
export function redactStack(stack: string, appRoot?: string): string {
  const frames: string[] = []
  let length = 0
  for (const line of stack.split(/\r\n|\r|\n/)) {
    if (frames.length === LOG_STACK_MAX_FRAMES) break
    const frame = toFrame(line, appRoot)
    if (frame === null) continue
    const added = (frames.length === 0 ? 0 : 1) + frame.length
    if (length + added > LOG_STACK_MAX_CHARS) break
    frames.push(frame)
    length += added
  }
  return frames.join('\n')
}

function toFrame(line: string, appRoot: string | undefined): string | null {
  if (DEPENDENCY_FRAME.test(line)) return DEPENDENCY
  const match = FRAME.exec(line)
  if (!match) return null
  const [, fn, rawPath = '', row, column] = match
  if (/(?:^|[\\/])node_modules[\\/]/.test(rawPath)) return DEPENDENCY
  const path = dwarfaiPath(rawPath, appRoot)
  if (path === null) return null
  const location = `${path}:${row}:${column}`
  const frame =
    fn !== undefined && FUNCTION_NAME.test(fn) ? `    at ${fn} (${location})` : `    at ${location}`
  return redactSecrets(replaceHome(frame))
}

/**
 * A third-party error reduced to `err.name` and `err.code` (ADR-026 item 5), each through the text
 * pipeline; its `message` is never read. Anything thrown that is not an object yields nothing.
 */
export function reduceThirdPartyError(err: unknown): Pick<LogRecord, 'msg' | 'errCode'> {
  if (typeof err !== 'object' || err === null) return {}
  const { name, code } = err as { name?: unknown; code?: unknown }
  const reduced: Pick<LogRecord, 'msg' | 'errCode'> = {}
  if (typeof name === 'string') reduced.msg = redactText(name)
  if (typeof code === 'string' || typeof code === 'number')
    reduced.errCode = redactText(String(code))
  return reduced
}
