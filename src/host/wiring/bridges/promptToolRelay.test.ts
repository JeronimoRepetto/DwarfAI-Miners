// L3 (17 §1.3): the stream-json driver's PromptToolRelay over the delegation lifecycle
// (AMENDMENT-21, owner-approved 2026-10-17; ADR-013 item 3; INV-83).
import { describe, expect, it } from 'vitest'
import type { LaunchId } from '../../kernel/domain/values'
import type { DelegationInjection } from '../../modules/suppliers'
import { createPromptToolRelay } from './promptToolRelay'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const INJECTION: DelegationInjection = {
  mechanism: 'ticket-file',
  relay: { program: '/opt/dwarfai/DwarfAI-Miners', args: ['--dwarfai-relay-entry'] },
  credentialFilePath: `/host-data/run/mcp/${LAUNCH}.cred`
}

function recordingLifecycle(issued: DelegationInjection | null = INJECTION) {
  const calls: string[] = []
  return {
    calls,
    issuePromptRelay: async (launchId: LaunchId) => {
      calls.push(`issue ${launchId}`)
      return issued
    },
    revokeLaunch: async (launchId: LaunchId) => {
      calls.push(`revoke ${launchId}`)
    }
  }
}

describe('createPromptToolRelay (AMENDMENT-21)', () => {
  it('[ADR-013] issue gives the lifecycle prompt relay of the launch, null when it has none', async () => {
    const lifecycle = recordingLifecycle()
    expect(await createPromptToolRelay(lifecycle).issue(LAUNCH)).toEqual(INJECTION)
    expect(await createPromptToolRelay(recordingLifecycle(null)).issue(LAUNCH)).toBeNull()
    expect(lifecycle.calls).toEqual([`issue ${LAUNCH}`])
  })

  it('[ADR-013, INV-83] release revokes the launch token row and deletes its credential file', async () => {
    const lifecycle = recordingLifecycle()

    await createPromptToolRelay(lifecycle).release(LAUNCH)

    expect(lifecycle.calls).toEqual([`revoke ${LAUNCH}`])
  })
})
