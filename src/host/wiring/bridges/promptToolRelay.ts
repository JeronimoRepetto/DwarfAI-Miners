// The stream-json driver's `PromptToolRelay` over module delegation's lifecycle (AMENDMENT-21,
// owner-approved 2026-10-17; ADR-013 item 3; INV-83):
//
// - `issue(launchId)` → `DelegationLifecycle.issuePromptRelay`: the hash-only row, then the
//   owner-only credential file, for a launch the delegation gates left out.
// - `release(launchId)` → `DelegationLifecycle.revokeLaunch`: the driver calls it when a launch it
//   issued a credential for failed to start, so the row and the file never outlive a launch that
//   never ran. A credential that cannot be deleted is left to the boot sweep (`sweepOrphans`).
//
// Composed with the driver by the composition root (no stream-json driver is composed yet).
import type { LaunchId } from '../../kernel/domain/values'
import type { DelegationLifecycle, PermissionPromptRelayIssuer } from '../../modules/delegation'
import type { PromptToolRelay } from '../../modules/suppliers/adapters/drivers/claude-stream-json/promptTool'

export function createPromptToolRelay(
  lifecycle: PermissionPromptRelayIssuer & Pick<DelegationLifecycle, 'revokeLaunch'>
): PromptToolRelay {
  return {
    issue: (launchId: LaunchId) => lifecycle.issuePromptRelay(launchId),
    release: (launchId: LaunchId) => lifecycle.revokeLaunch(launchId)
  }
}
