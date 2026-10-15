// The guard's own test: the one test file that spells ADR-008 item 3's forbidden flags out, written
// by hand from the ADR so the list in `forbiddenFlags.ts` cannot shrink unseen.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import {
  ALWAYS_OPTION_KINDS,
  assertNoForbidden,
  FORBIDDEN_FLAGS,
  type DelegationGate
} from './forbiddenFlags'

/** ADR-008 item 3, verbatim. */
const ADR_008_ITEM_3: readonly string[] = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  'yoloMode',
  'acceptForSession'
]

/** The "always" option ADR-008 item 3 names by kind (an ACP permission option kind). */
const ALWAYS_KINDS: readonly string[] = ['allow_always']

const BOTH_ON: DelegationGate = { subagentDelegationOn: true, launchedWithLetJevChoose: true }
const GATES: readonly DelegationGate[] = [
  BOTH_ON,
  { subagentDelegationOn: true, launchedWithLetJevChoose: false },
  { subagentDelegationOn: false, launchedWithLetJevChoose: true },
  { subagentDelegationOn: false, launchedWithLetJevChoose: false }
]

function refuses(
  argv: readonly string[],
  options: unknown,
  gate: DelegationGate = BOTH_ON
): boolean {
  try {
    assertNoForbidden(argv, options, { delegationGate: gate })
    return false
  } catch (error) {
    if (error instanceof HostInvariantError) return true
    throw error
  }
}

/** The Jev entry's pre-approval of exactly DwarfAI's two delegation tools, in each form a driver builds. */
const JEV_PRE_APPROVALS: readonly { name: string; argv: readonly string[]; options: unknown }[] = [
  {
    name: 'Codex -c per-tool approval_mode',
    argv: [
      'app-server',
      '-c',
      'mcp_servers.jev.tools.delegate_subtask.approval_mode="approve"',
      '-c',
      'mcp_servers.jev.tools.subtask_result.approval_mode="approve"'
    ],
    options: {}
  },
  {
    name: 'allowed tools flag',
    argv: ['-p', '--allowedTools', 'mcp__jev__delegate_subtask,mcp__jev__subtask_result'],
    options: {}
  },
  {
    name: 'nested option set',
    argv: [],
    options: {
      mcp_servers: {
        jev: {
          tools: {
            delegate_subtask: { approval_mode: 'approve' },
            subtask_result: { approval_mode: 'approve' }
          }
        }
      }
    }
  }
]

describe('forbidden flags (ADR-008 item 3)', () => {
  it('[C-24] every forbidden flag and option is refused in argv and in an option set', () => {
    expect(FORBIDDEN_FLAGS).toEqual(expect.arrayContaining([...ADR_008_ITEM_3]))
    expect(ALWAYS_OPTION_KINDS).toEqual(expect.arrayContaining([...ALWAYS_KINDS]))
    for (const flag of [...FORBIDDEN_FLAGS, ...ALWAYS_OPTION_KINDS]) {
      expect(refuses([flag], {}), `argv ${flag}`).toBe(true)
      expect(refuses(['exec', `--permission-mode=${flag}`], {}), `argv value ${flag}`).toBe(true)
      expect(refuses([], { [flag]: true }), `option key ${flag}`).toBe(true)
      expect(refuses([], { [flag]: false }), `option key ${flag} set off`).toBe(true)
      expect(refuses([], { session: { permissionMode: flag } }), `option value ${flag}`).toBe(true)
      expect(refuses([], { modes: [flag.toUpperCase()] }), `option value ${flag} in any case`).toBe(
        true
      )
    }
  })

  it('[C-24] an "always" approval is refused wherever an approval or permission is set', () => {
    expect(refuses(['--approval-policy', 'always'], {})).toBe(true)
    expect(refuses(['--permission=always'], {})).toBe(true)
    expect(refuses([], { approvalPolicy: 'always' })).toBe(true)
    expect(refuses([], { permissions: { default: 'Always' } })).toBe(true)
  })

  it('[C-24] an argv and option set holding no forbidden flag passes', () => {
    expect(
      refuses(
        [
          'app-server',
          '-c',
          'approval_policy="on-request"',
          '--color',
          'always',
          '--model',
          'model-a'
        ],
        { approvalPolicy: 'on-request', sandbox: 'workspace-write', disableQuestionTools: true }
      )
    ).toBe(false)
  })

  it('[C-24] a delegation entry that pre-approves exactly the two DwarfAI tool names passes only with both gates on', () => {
    for (const form of JEV_PRE_APPROVALS) {
      for (const gate of GATES) {
        const bothOn = gate.subagentDelegationOn && gate.launchedWithLetJevChoose
        expect(refuses(form.argv, form.options, gate), `${form.name} ${JSON.stringify(gate)}`).toBe(
          !bothOn
        )
      }
    }
  })

  it('[C-24] a pre-approval of any third tool, a session-wide approval or an always option is refused', () => {
    const refused: readonly { name: string; argv: readonly string[]; options: unknown }[] = [
      {
        name: 'third Jev tool',
        argv: ['-c', 'mcp_servers.jev.tools.shell.approval_mode="approve"'],
        options: {}
      },
      {
        name: 'another server',
        argv: ['-c', 'mcp_servers.other.tools.delegate_subtask.approval_mode="approve"'],
        options: {}
      },
      {
        name: 'server-wide default',
        argv: ['-c', 'mcp_servers.jev.default_tools_approval_mode="approve"'],
        options: {}
      },
      { name: 'unscoped approval', argv: ['-c', 'approval_mode="approve"'], options: {} },
      { name: 'provider tool allowed', argv: ['--allowedTools', 'Bash'], options: {} },
      {
        name: 'a provider tool beside the two',
        argv: ['--allowedTools=mcp__jev__delegate_subtask,mcp__jev__subtask_result,Edit'],
        options: {}
      },
      { name: 'whole Jev server', argv: ['--allowed-tools', 'mcp__jev'], options: {} },
      { name: 'Jev wildcard', argv: ['--allowedTools', 'mcp__jev__*'], options: {} },
      {
        name: 'allowed tools option',
        argv: [],
        options: { allowedTools: ['mcp__jev__delegate_subtask', 'Write'] }
      },
      {
        name: 'third tool in an option set',
        argv: [],
        options: { mcp_servers: { jev: { tools: { read_file: { approval_mode: 'approve' } } } } }
      },
      { name: 'session-wide option', argv: [], options: { decision: 'acceptForSession' } },
      { name: 'always option', argv: [], options: { optionId: 'allow_always' } }
    ]
    for (const form of refused) {
      expect(refuses(form.argv, form.options, BOTH_ON), form.name).toBe(true)
    }
  })
})
