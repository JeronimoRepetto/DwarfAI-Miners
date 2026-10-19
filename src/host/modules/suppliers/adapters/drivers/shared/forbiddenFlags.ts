// The forbidden-flag guard of ADR-008 item 3 (`15` §4 "Forbidden", C-24; `18` C-19): no driver
// passes a flag or option that bypasses the person's permission decisions. Every driver runs the
// argv and the option set it builds through `assertNoForbidden` before a spawn or a protocol call.
// The one named exception: the Jev entry (ADR-013 item 3) MAY pre-approve exactly DwarfAI's two
// delegation tools, only in a session launched with both delegation gates on (ADR-013 item 4).
// This file is the only place in `src/host` that spells the forbidden flags out (ADR-008
// Verification static test).
import { HostInvariantError } from '../../../../../kernel/domain/errors'

/**
 * ADR-008 item 3's list, verbatim. A token, key or value that contains one is refused, in any case.
 * The static test keeps each one out of src/host outside this guard (ADR-008 Verification).
 */
export const FORBIDDEN_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  'yoloMode',
  'acceptForSession'
]

/**
 * The "always" options ADR-008 item 3 names by kind: an ACP permission option of kind
 * `allow_always`. Refused like a flag, but kept apart from `FORBIDDEN_FLAGS`: the asking module
 * and an ACP driver must name this kind to refuse it (ADR-010 item 3, INV-73), so the static
 * test does not scan for it.
 */
export const ALWAYS_OPTION_KINDS: readonly string[] = ['allow_always']

/**
 * The permission modes that settle a tool use without asking (AMENDMENT-19): Claude Code 2.1.x's
 * `--permission-mode` choices `acceptEdits`, `auto` and `dontAsk` (its fourth such choice is
 * `bypassPermissions`, already in `FORBIDDEN_FLAGS`). Refused only as the value of a
 * `--permission-mode` flag or a `permissionMode` option, never as a substring: `auto` is an
 * ordinary word elsewhere (a model or effort value), so the static test does not scan for these.
 */
export const AUTO_APPROVE_PERMISSION_MODES: readonly string[] = ['acceptEdits', 'auto', 'dontAsk']

/** The two launch facts of ADR-013 item 4; the exception needs both on. */
export interface DelegationGate {
  readonly subagentDelegationOn: boolean
  readonly launchedWithLetJevChoose: boolean
}

/** The Jev MCP entry's server name and the two tools DwarfAI serves on it (ADR-013 items 1, 3). */
const JEV_SERVER = 'jev'
const JEV_TOOLS: readonly string[] = ['delegate_subtask', 'subtask_result']
/**
 * The name the Claude drivers register the same relay under (15 §4.2: it also serves
 * `mcp__dwarfai__permission`, which is never pre-approvable).
 */
const CLAUDE_RELAY_SERVER = 'dwarfai'
/** The same two tools as an allowed-tools list names them (`mcp__<server>__<tool>`). */
const JEV_TOOL_IDS: readonly string[] = [JEV_SERVER, CLAUDE_RELAY_SERVER].flatMap((server) =>
  JEV_TOOLS.map((tool) => `mcp__${server}__${tool}`)
)

/** A flag or key that sets an approval or permission: an "always" value there is refused. */
const APPROVAL_CONTEXT = /approv|permission/i
const ALLOWED_TOOLS_FLAG = /^--allowed-?tools(?:=(.*))?$/i
const ALLOWED_TOOLS_KEY = /^allowed_?tools$/i
const APPROVAL_MODE_KEY = /approval_mode$/i
const PRE_APPROVE = 'approve'

const PERMISSION_MODE_FLAG = /^--permission-mode(?:=(.*))?$/i
const PERMISSION_MODE_KEY = /^permission_?mode$/i

const REFUSED: readonly string[] = [...FORBIDDEN_FLAGS, ...ALWAYS_OPTION_KINDS]
const REFUSED_LOWER = REFUSED.map((flag) => flag.toLowerCase())
const AUTO_APPROVE_LOWER = AUTO_APPROVE_PERMISSION_MODES.map((mode) => mode.toLowerCase())

/** A permission-mode value that settles a tool use without asking is refused (AMENDMENT-19). */
function checkPermissionMode(value: string): void {
  if (AUTO_APPROVE_LOWER.includes(unquote(value).toLowerCase()))
    refuse(`a permission mode that does not ask (${value.trim()})`)
}

function refuse(reason: string): never {
  throw new HostInvariantError(
    `a driver passed a forbidden flag or option (ADR-008 item 3): ${reason}`
  )
}

function checkText(text: string): void {
  const lower = text.toLowerCase()
  const hit = REFUSED.find((_, index) => lower.includes(REFUSED_LOWER[index] ?? ''))
  if (hit !== undefined) refuse(hit)
}

function isAlways(value: string): boolean {
  return value.trim().toLowerCase() === 'always'
}

function unquote(value: string): string {
  const trimmed = value.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

/**
 * Validates the "approve" pre-approval of a value set at `path` (a Codex `-c` key or a nested
 * option path): accepted only as `mcp_servers.jev.tools.<one of the two>.approval_mode` with both
 * gates on. A server-wide default, an unscoped mode, a third tool or another server is refused.
 */
function checkSetting(path: readonly string[], value: string, gateOn: boolean): void {
  if (isAlways(value) && path.some((key) => APPROVAL_CONTEXT.test(key)))
    refuse('an "always" approval')
  const last = path[path.length - 1] ?? ''
  if (value.trim().toLowerCase() !== PRE_APPROVE || !APPROVAL_MODE_KEY.test(last)) return
  const [servers, server, tools, tool, mode] = path.slice(-5)
  const jevTool =
    path.length >= 5 &&
    servers === 'mcp_servers' &&
    server === JEV_SERVER &&
    tools === 'tools' &&
    tool !== undefined &&
    JEV_TOOLS.includes(tool) &&
    mode === 'approval_mode'
  if (!jevTool) refuse(`a pre-approval outside DwarfAI's two delegation tools (${path.join('.')})`)
  if (!gateOn) refuse('a delegation pre-approval without both delegation gates on')
}

/** An allowed-tools list pre-approves: it may name only the two Jev tools, with both gates on. */
function checkAllowedTools(tools: readonly string[], gateOn: boolean): void {
  const named = tools.map((tool) => tool.trim()).filter((tool) => tool !== '')
  if (named.length === 0) return
  if (!named.every((tool) => JEV_TOOL_IDS.includes(tool))) {
    refuse("an allowed-tools list naming a tool other than DwarfAI's two delegation tools")
  }
  if (!gateOn) refuse('a delegation pre-approval without both delegation gates on')
}

function checkArgv(argv: readonly string[], gateOn: boolean): void {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? ''
    checkText(token)
    const mode = PERMISSION_MODE_FLAG.exec(token)
    if (mode !== null) {
      const value = mode[1] ?? argv[++index] ?? ''
      checkText(value)
      checkPermissionMode(value)
      continue
    }
    const allowed = ALLOWED_TOOLS_FLAG.exec(token)
    if (allowed !== null) {
      const value = allowed[1] ?? argv[++index] ?? ''
      checkText(value)
      checkAllowedTools(value.split(/[\s,]+/), gateOn)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      const key = token.slice(0, equals).replace(/^-+/, '')
      checkSetting(key.split('.'), unquote(token.slice(equals + 1)), gateOn)
      continue
    }
    const next = argv[index + 1]
    if (
      token.startsWith('-') &&
      APPROVAL_CONTEXT.test(token) &&
      next !== undefined &&
      isAlways(next)
    ) {
      refuse('an "always" approval')
    }
  }
}

function checkOptions(value: unknown, path: readonly string[], gateOn: boolean): void {
  if (typeof value === 'string') {
    checkText(value)
    if (PERMISSION_MODE_KEY.test(path[path.length - 1] ?? '')) checkPermissionMode(value)
    checkSetting(path, value, gateOn)
    return
  }
  if (Array.isArray(value)) {
    const last = path[path.length - 1] ?? ''
    if (ALLOWED_TOOLS_KEY.test(last)) {
      checkAllowedTools(
        value.filter((item): item is string => typeof item === 'string'),
        gateOn
      )
    }
    for (const item of value) checkOptions(item, path, gateOn)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      checkText(key)
      checkOptions(item, [...path, key], gateOn)
    }
  }
}

/**
 * Throws `HostInvariantError` when `argv` or `options` (any nested option set a driver builds: SDK
 * options, protocol params, config overrides) holds a flag or option of ADR-008 item 3, or a
 * pre-approval outside its one named exception.
 */
export function assertNoForbidden(
  argv: readonly string[],
  options: unknown,
  ctx: { delegationGate: DelegationGate }
): void {
  const gateOn =
    ctx.delegationGate.subagentDelegationOn && ctx.delegationGate.launchedWithLetJevChoose
  checkArgv(argv, gateOn)
  checkOptions(options, [], gateOn)
}
