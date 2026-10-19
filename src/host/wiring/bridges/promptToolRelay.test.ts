// L3 (17 §1.3): the stream-json driver's PromptToolRelay over the delegation lifecycle
// (AMENDMENT-21, owner-approved 2026-10-17; ADR-013 item 3; INV-83), and the reissue a restarted
// Host's resume asks (ISSUE-182): the live relay of the launch, with the credential file it has.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchId } from '../../kernel/domain/values'
import { RunDirCredentialFileStore } from '../../modules/delegation/adapters/fs/RunDirCredentialFileStore'
import type { DelegationInjection } from '../../modules/suppliers'
import { createPromptToolRelay, credentialFilePathOf } from './promptToolRelay'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const RELAY = { program: '/opt/dwarfai/DwarfAI-Miners', args: ['--dwarfai-relay-entry'] }
const HOST_DATA = '/host-data'
const INJECTION: DelegationInjection = {
  mechanism: 'ticket-file',
  relay: RELAY,
  credentialFilePath: credentialFilePathOf(HOST_DATA, LAUNCH)
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

function relayOver(
  lifecycle: ReturnType<typeof recordingLifecycle>,
  stored: { live?: boolean; file?: boolean } = {}
) {
  return createPromptToolRelay({
    lifecycle,
    tokens: {
      byLaunch: (id) =>
        stored.live === true && id === LAUNCH
          ? { launchId: id, parentDwarfId: null, mechanism: 'ticket-file', issuedAt: 0 }
          : null
    },
    files: { list: async () => (stored.file === true ? [LAUNCH] : []) },
    relay: RELAY,
    hostDataDir: HOST_DATA
  })
}

describe('createPromptToolRelay (AMENDMENT-21)', () => {
  it('[ADR-013] issue gives the lifecycle prompt relay of the launch, null when it has none', async () => {
    const lifecycle = recordingLifecycle()
    expect(await relayOver(lifecycle).issue(LAUNCH)).toEqual(INJECTION)
    expect(await relayOver(recordingLifecycle(null)).issue(LAUNCH)).toBeNull()
    expect(lifecycle.calls).toEqual([`issue ${LAUNCH}`])
  })

  it('[ADR-013, INV-83] release revokes the launch token row and deletes its credential file', async () => {
    const lifecycle = recordingLifecycle()

    await relayOver(lifecycle).release(LAUNCH)

    expect(lifecycle.calls).toEqual([`revoke ${LAUNCH}`])
  })
})

describe('reissue for a restarted Host (ISSUE-182)', () => {
  it('[S4.18, ADR-013] a launch whose token is live and whose credential file is on disk gets the relay it had, with no new credential', async () => {
    const lifecycle = recordingLifecycle()

    expect(await relayOver(lifecycle, { live: true, file: true }).reissue(LAUNCH)).toEqual(
      INJECTION
    )
    expect(lifecycle.calls).toEqual([])
  })

  it('[ADR-013, INV-83] a revoked or unknown token, or a credential file that is gone, reissues nothing', async () => {
    const lifecycle = recordingLifecycle()

    expect(await relayOver(lifecycle, { live: false, file: true }).reissue(LAUNCH)).toBeNull()
    expect(await relayOver(lifecycle, { live: true, file: false }).reissue(LAUNCH)).toBeNull()
  })

  it('[ADR-013] the reissued path is the one the credential file store writes for the launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-182-cred-'))
    roots.push(root)
    const written = await new RunDirCredentialFileStore({ hostDataDir: root }).write(
      LAUNCH,
      'a'.repeat(64)
    )

    expect(written).toEqual({ ok: true, value: { path: credentialFilePathOf(root, LAUNCH) } })
  })
})
