// The launch env tag of ADR-015 item 2: `DWARFAI_SPAWN=v1:<installId>:<launchId>:<hostEpoch>`, no
// secret. A launch tags its process with its own epoch; a Host-driven resume tags the resumed
// process with the epoch of the Host that spawns it (ISSUE-173). Pure (R1).
import type { HostEpoch, LaunchId } from '../../../kernel/domain/values'

export function spawnTagFor(installId: string, launchId: LaunchId, hostEpoch: HostEpoch): string {
  return `v1:${installId}:${launchId}:${hostEpoch}`
}
