// L3 (17 §1.3): the permission prompt bridge (AMENDMENT-21, owner-approved 2026-10-17; ADR-013
// item 3; ADR-010 items 1, 5) between the Host MCP endpoint's `permission` tool (module
// delegation) and the Claude stream-json sessions (module suppliers): a relay credential reaches
// the session of its own launch only.
import { describe, expect, it } from 'vitest'
import type { LaunchId } from '../../kernel/domain/values'
import type { DelegationToken, PermissionPromptCall } from '../../modules/delegation'
import { PermissionPromptBridge } from './permissionPromptBridge'

const A = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const B = '01890a5d-ac96-774b-bcce-b302099a8a02' as LaunchId
const tokenOf = (launchId: LaunchId, revokedAt?: number): DelegationToken => ({
  launchId,
  parentDwarfId: null,
  mechanism: 'ticket-file',
  issuedAt: 0,
  ...(revokedAt === undefined ? {} : { revokedAt })
})
const CALL: PermissionPromptCall = {
  toolName: 'Bash',
  input: { command: 'pnpm test' },
  toolUseId: 'toolu_01'
}
const signal = new AbortController().signal
const UNGATED = { delegationGated: false }

describe('PermissionPromptBridge (AMENDMENT-21)', () => {
  it('[ADR-013] a credential reaches the session of its own launch only', async () => {
    const bridge = new PermissionPromptBridge()
    const asked: string[] = []
    bridge.register(A, UNGATED, async (call) => {
      asked.push(`A:${call.toolUseId}`)
      return 'allow'
    })
    bridge.register(B, UNGATED, async (call) => {
      asked.push(`B:${call.toolUseId}`)
      return 'deny'
    })

    expect(await bridge.decide(tokenOf(A), CALL, signal)).toBe('allow')
    expect(await bridge.decide(tokenOf(B), CALL, signal)).toBe('deny')
    expect(asked).toEqual(['A:toolu_01', 'B:toolu_01'])
  })

  it('[ADR-013] a launch with no owned stream-json session, or a revoked credential, is not served and is denied unasked', async () => {
    const bridge = new PermissionPromptBridge()
    const asked: string[] = []
    bridge.register(A, UNGATED, async () => {
      asked.push('A')
      return 'allow'
    })

    expect(bridge.serves(tokenOf(A))).toBe(true)
    expect(bridge.serves(tokenOf(B))).toBe(false)
    expect(bridge.serves(tokenOf(A, 5))).toBe(false)
    expect(await bridge.decide(tokenOf(B), CALL, signal)).toBe('deny')
    expect(await bridge.decide(tokenOf(A, 5), CALL, signal)).toBe('deny')
    expect(asked).toEqual([])
  })

  it('[ADR-013] unregistering ends the session service, and a late unregister never removes a newer session of the launch', async () => {
    const bridge = new PermissionPromptBridge()
    const first = bridge.register(A, UNGATED, async () => 'deny')
    first()
    expect(bridge.serves(tokenOf(A))).toBe(false)

    const old = bridge.register(A, UNGATED, async () => 'deny')
    bridge.register(A, UNGATED, async () => 'allow')
    old()

    expect(bridge.serves(tokenOf(A))).toBe(true)
    expect(await bridge.decide(tokenOf(A), CALL, signal)).toBe('allow')
  })

  it('[ADR-010] the session handler receives the call and the cancellation signal unchanged', async () => {
    const bridge = new PermissionPromptBridge()
    const abort = new AbortController()
    let seen: { call: PermissionPromptCall; signal: AbortSignal } | null = null
    bridge.register(A, UNGATED, async (call, received) => {
      seen = { call, signal: received }
      return 'deny'
    })

    await bridge.decide(tokenOf(A), CALL, abort.signal)

    expect(seen).toEqual({ call: CALL, signal: abort.signal })
  })

  it('[ADR-013, INV-80] each launch reports the delegation gate it registered with, and an unserved launch is never gated', () => {
    const bridge = new PermissionPromptBridge()
    bridge.register(A, { delegationGated: true }, async () => 'deny')
    bridge.register(B, UNGATED, async () => 'deny')

    expect(bridge.delegationGated(tokenOf(A))).toBe(true)
    expect(bridge.delegationGated(tokenOf(B))).toBe(false)
    expect(bridge.delegationGated(tokenOf(A, 5))).toBe(false)
    expect(
      bridge.delegationGated(tokenOf('01890a5d-ac96-774b-bcce-b302099a8a03' as LaunchId))
    ).toBe(false)
  })
})
