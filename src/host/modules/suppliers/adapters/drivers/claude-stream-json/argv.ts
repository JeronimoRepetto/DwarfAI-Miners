// The argv of the person's `claude` for a stream-json session (15 §4.2 Launch): the persistent
// `-p` print mode with stream-json in and out, the Host-assigned session id (or `--resume <id>`),
// the model and effort, the pinned permission mode (AMENDMENT-19: `--permission-mode default` or
// the DwarfAI permission mode's own value), DwarfAI's permission prompt tool, the question tool disallowed (ADR-009
// D4, until SP-08), and the `--mcp-config` file of the relay entry, which every launch and resume
// carries because the relay serves the permission prompt tool (AMENDMENT-21), with the
// pre-approval of DwarfAI's two delegation tools only on a launch both delegation gates let in
// (ISSUE-201). The permission tool itself is never pre-approved: Claude calls it as its prompt
// tool, and `assertNoForbidden` refuses any allowed-tools list that names it. The prompt and
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
import { delegationToolIds } from '../shared/relayEntry'

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

/**
 * DwarfAI's two delegation tools (`delegationToolIds`), pre-approved only on a launch whose
 * request carried a gated `DelegationInjection` (`delegationGateOn`, ISSUE-201).
 */
export const DELEGATION_TOOLS = delegationToolIds(PERMISSION_SERVER)
const GATE_ON = { subagentDelegationOn: true, launchedWithLetJevChoose: true }
const GATE_OFF = { subagentDelegationOn: false, launchedWithLetJevChoose: false }

export interface ArgvInput {
  /** `launch`: `--session-id <id>` pre-assigned by the Host; `resume`: `--resume <id>`. */
  readonly kind: 'launch' | 'resume'
  readonly sessionId: string
  readonly model?: string
  readonly effort?: string
  /** The Host-written `--mcp-config` file of the relay entry (ADR-013 item 3; AMENDMENT-21). */
  readonly mcpConfigPath: string | null
  /**
   * Both delegation gates let the launch in (its request carried a `DelegationInjection`): the
   * two delegation tools are pre-approved. Absent or false: no pre-approval. Needs the file.
   */
  readonly delegationGateOn?: boolean
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
  const gateOn = input.delegationGateOn === true
  if (gateOn && input.mcpConfigPath === null) {
    throw new HostInvariantError('a delegation pre-approval without the relay --mcp-config entry')
  }
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
    ...(gateOn ? ['--allowedTools', DELEGATION_TOOLS.join(',')] : []),
    ...input.policyArgv
  ]
  // The gate covers only the entry's own pre-approval: a permission mode's argv that names the two
  // tools on an ungated launch is still refused, and any other allowed tool always is.
  const delegationGate = gateOn ? GATE_ON : GATE_OFF
  assertNoForbidden(argv.slice(0, argv.length - input.policyArgv.length), {}, { delegationGate })
  assertNoForbidden(input.policyArgv, {}, { delegationGate: GATE_OFF })
  return argv
}
