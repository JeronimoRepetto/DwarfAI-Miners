// The stream-json driver's `PromptToolRelay` over module delegation's lifecycle (AMENDMENT-21,
// owner-approved 2026-10-17; ADR-013 item 3; INV-83):
//
// - `issue(launchId)` → `DelegationLifecycle.issuePromptRelay`: the hash-only row, then the
//   owner-only credential file, for a launch the delegation gates left out.
// - `release(launchId)` → `DelegationLifecycle.revokeLaunch`: the driver calls it when a launch it
//   issued a credential for failed to start, so the row and the file never outlive a launch that
//   never ran. A credential that cannot be deleted is left to the boot sweep (`sweepOrphans`).
//
// - `reissue(launchId)` (ISSUE-182): a restarted Host's resume of the launch's session gets the
//   relay it already had — the same relay program and credential FILE PATH — when its token row is
//   still live (`byLaunch` never answers a revoked row, 16 §5.7) and its credential file is still on
//   disk. Nothing is minted or written: the row is keyed by its launch (09 §4.6) and the relay
//   authenticates with the file it has. Otherwise `null`, and the resume runs without the tool.
//   The file's path follows `RunDirCredentialFileStore` (`<hostDataDir>/run/mcp/<launchId>.cred`,
//   ADR-013 item 3); promptToolRelay.test.ts holds the two to the same path.
//
// Composed with the driver by the composition root (wiring/promptTool.ts).
import { join } from 'node:path'
import type { LaunchId } from '../../kernel/domain/values'
import type {
  DelegationLifecycle,
  DelegationTokenStore,
  PermissionPromptRelayIssuer
} from '../../modules/delegation'
import type { PromptToolRelay } from '../../modules/suppliers/adapters/drivers/claude-stream-json/promptTool'

export interface PromptToolRelayDeps {
  lifecycle: PermissionPromptRelayIssuer & Pick<DelegationLifecycle, 'revokeLaunch'>
  tokens: Pick<DelegationTokenStore, 'byLaunch'>
  files: { list(): Promise<LaunchId[]> }
  relay: { program: string; args: readonly string[] }
  hostDataDir: string
}

/** `<hostDataDir>/run/mcp/<launchId>.cred`, where the credential file store writes it. */
export function credentialFilePathOf(hostDataDir: string, launchId: LaunchId): string {
  return join(hostDataDir, 'run', 'mcp', `${launchId}.cred`)
}

export function createPromptToolRelay(deps: PromptToolRelayDeps): PromptToolRelay {
  const { lifecycle } = deps
  return {
    issue: (launchId: LaunchId) => lifecycle.issuePromptRelay(launchId),
    release: (launchId: LaunchId) => lifecycle.revokeLaunch(launchId),
    reissue: async (launchId: LaunchId) => {
      if (deps.tokens.byLaunch(launchId) === null) return null
      if (!(await deps.files.list()).includes(launchId)) return null
      return {
        mechanism: 'ticket-file',
        relay: { program: deps.relay.program, args: [...deps.relay.args] },
        credentialFilePath: credentialFilePathOf(deps.hostDataDir, launchId)
      }
    }
  }
}
