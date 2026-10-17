// The argv of the person's `claude` for a stream-json session (15 §4.2 Launch): the persistent
// `-p` print mode with stream-json in and out, the Host-assigned session id (or `--resume <id>`),
// the model and effort, the pinned permission mode (AMENDMENT-19: `--permission-mode default` or
// the DwarfAI permission mode's own value), DwarfAI's permission prompt tool, the question tool disallowed (ADR-009
// D4, until SP-08), and the `--mcp-config` file when a delegation relay is injected. The prompt and
// every turn travel on stdin, never in argv (15 §1.2). Every argv goes through `assertNoForbidden`
// (ADR-008 item 3, C-24), so the skip-permissions flag that `al@e631d18:chat.ts:471` passed (15
// §4.2 Quirks: "dropped") can never be added, by this builder or by a permission mode's own argv.
//
// Candidate decision (21 §6): `src/main/sessionLaunch/launch.ts` `buildClaudeLaunchArgs` is
// adapted: its `--model` / `--effort` flags (present only when the request carries them) and its
// prompt-on-stdin rule are kept; the rest is replaced, because it builds a detached one-shot
// `claude -p --input-format text` (one turn, then exit) with no stream-json output, no session id,
// no prompt tool and no forbidden-flag guard.
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { assertNoForbidden } from '../shared/forbiddenFlags'

/** The MCP server name the relay is registered under in the `--mcp-config` file. */
export const PERMISSION_SERVER = 'dwarfai'
/** `--permission-prompt-tool mcp__dwarfai__permission`, served by the relay (15 §4.2). */
export const PERMISSION_PROMPT_TOOL = `mcp__${PERMISSION_SERVER}__permission`
/** The question tool, disallowed while `question` is `none` (ADR-009 D4, SP-08). */
export const QUESTION_TOOL = 'AskUserQuestion'

const STREAM_JSON = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose'
]

/** No delegation pre-approval is ever passed by this driver (ISSUE-201 owns the Jev entry). */
const NO_DELEGATION_GATE = { subagentDelegationOn: false, launchedWithLetJevChoose: false }

export interface ArgvInput {
  /** `launch`: `--session-id <id>` pre-assigned by the Host; `resume`: `--resume <id>`. */
  readonly kind: 'launch' | 'resume'
  readonly sessionId: string
  readonly model?: string
  readonly effort?: string
  /** The Host-written `--mcp-config` file, when a delegation relay is injected (ADR-013 item 3). */
  readonly mcpConfigPath: string | null
  /** The permission mode's own flags (ADR-011 item 1 `ProviderPolicy.argv`). */
  readonly policyArgv: readonly string[]
}

/**
 * AMENDMENT-19: the permission mode is always pinned, so the person's own settings
 * `permissions.defaultMode` (which Claude Code reads) never applies and every tool use reaches the
 * prompt tool. `default` unless the DwarfAI permission mode's own argv sets the value.
 */
const PINNED_PERMISSION_MODE = ['--permission-mode', 'default']
const PERMISSION_MODE_FLAG = /^--permission-mode(?:=|$)/i

/**
 * The argv, checked against ADR-008 item 3; throws `HostInvariantError` on a forbidden flag or a
 * permission mode that does not ask, and when the policy sets the permission mode more than once.
 */
export function buildArgv(input: ArgvInput): string[] {
  const policyModes = input.policyArgv.filter((arg) => PERMISSION_MODE_FLAG.test(arg)).length
  if (policyModes > 1) {
    throw new HostInvariantError(
      `a permission mode's argv sets more than one --permission-mode (${policyModes})`
    )
  }
  const argv = [
    ...STREAM_JSON,
    ...(input.kind === 'launch'
      ? ['--session-id', input.sessionId]
      : ['--resume', input.sessionId]),
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    ...(policyModes === 0 ? PINNED_PERMISSION_MODE : []),
    '--permission-prompt-tool',
    PERMISSION_PROMPT_TOOL,
    '--disallowedTools',
    QUESTION_TOOL,
    ...(input.mcpConfigPath === null ? [] : ['--mcp-config', input.mcpConfigPath]),
    ...input.policyArgv
  ]
  assertNoForbidden(argv, {}, { delegationGate: NO_DELEGATION_GATE })
  return argv
}
