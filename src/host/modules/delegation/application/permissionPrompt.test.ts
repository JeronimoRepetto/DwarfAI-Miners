// L2 (17 §1.2): `answerPermissionPrompt`, the `permission` tool over the PermissionPromptEndpoint
// port (AMENDMENT-21, owner-approved 2026-10-17; 15 §2.7; ADR-010 items 1, 5; ADR-013 item 3).
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import type { LaunchId } from '../../../kernel/domain/values'
import {
  PERMISSION_DENIED_MESSAGE,
  PERMISSION_UNAVAILABLE_MESSAGE,
  type PermissionPromptCall
} from '../domain/permissionPrompt'
import type { DelegationToken } from '../ports/delegationStores'
import type { PermissionPromptEndpoint } from '../ports/permissionPrompt'
import { answerPermissionPrompt } from './permissionPrompt'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const TOKEN: DelegationToken = {
  launchId: LAUNCH,
  parentDwarfId: null,
  mechanism: 'ticket-file',
  issuedAt: 0
}
const ARGS = {
  tool_name: 'Write',
  input: { file_path: '/work/mine/marker.txt', content: 'marker' },
  tool_use_id: 'toolu_01'
}

/** An endpoint that answers `decision` (or throws it) and records what it was asked. */
function endpoint(
  decision: 'allow' | 'deny' | Error,
  served = true
): PermissionPromptEndpoint & { asked: PermissionPromptCall[] } {
  const asked: PermissionPromptCall[] = []
  return {
    asked,
    serves: (token) => served && token.launchId === LAUNCH,
    delegationGated: () => false,
    decide: async (token, call) => {
      expect(token.launchId).toBe(LAUNCH)
      asked.push(call)
      if (decision instanceof Error) throw decision
      return decision
    }
  }
}

const signal = new AbortController().signal

describe('answerPermissionPrompt (AMENDMENT-21)', () => {
  it('[ADR-010] an Allow of the session answers behavior allow with the input as updatedInput', async () => {
    const served = endpoint('allow')
    const reply = await answerPermissionPrompt(
      served,
      TOKEN,
      ARGS,
      signal,
      new RecordingDiagnosticsLog()
    )
    expect(reply).toEqual({ behavior: 'allow', updatedInput: ARGS.input })
    expect(served.asked).toEqual([{ toolName: 'Write', input: ARGS.input, toolUseId: 'toolu_01' }])
  })

  it('[ADR-010] a Deny of the session answers behavior deny with the denied message', async () => {
    const reply = await answerPermissionPrompt(
      endpoint('deny'),
      TOKEN,
      ARGS,
      signal,
      new RecordingDiagnosticsLog()
    )
    expect(reply).toEqual({ behavior: 'deny', message: PERMISSION_DENIED_MESSAGE })
  })

  it('[ADR-010] a bridge error answers deny and logs its class only, never the tool input', async () => {
    const log = new RecordingDiagnosticsLog()
    const failure = Object.assign(new Error(`could not reach ${ARGS.input.file_path}`), {
      code: 'EPIPE'
    })
    const reply = await answerPermissionPrompt(endpoint(failure), TOKEN, ARGS, signal, log)
    expect(reply).toEqual({ behavior: 'deny', message: PERMISSION_UNAVAILABLE_MESSAGE })
    expect(log.refused).toEqual([])
    expect(log.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'delegation.permission.failed',
        subsystem: 'delegation',
        outcome: 'failed',
        causeClass: 'EPIPE'
      })
    ])
    expect(JSON.stringify(log.entries)).not.toContain('marker')
  })

  it('[ADR-013] a token whose launch is not an owned stream-json session is denied and never asked', async () => {
    const foreign = endpoint('allow', false)
    const reply = await answerPermissionPrompt(
      foreign,
      TOKEN,
      ARGS,
      signal,
      new RecordingDiagnosticsLog()
    )
    expect(reply).toEqual({ behavior: 'deny', message: PERMISSION_UNAVAILABLE_MESSAGE })
    expect(foreign.asked).toEqual([])
  })

  it('[ADR-010] a malformed call is denied and opens no ask (fail closed)', async () => {
    const served = endpoint('allow')
    for (const args of [{ ...ARGS, input: 'rm -rf /' }, { tool_name: 'Write' }, null]) {
      expect(
        await answerPermissionPrompt(served, TOKEN, args, signal, new RecordingDiagnosticsLog())
      ).toEqual({ behavior: 'deny', message: PERMISSION_UNAVAILABLE_MESSAGE })
    }
    expect(served.asked).toEqual([])
  })
})
