// The resume-context bridge (ISSUE-173; ADR-015 items 2, 5): what a provider driver's `resume`
// needs that `SessionRef` does not carry, read from launching's stored launch record when the
// driver instance did not launch the session itself (a restarted Host). The folder is the record's
// `cwd`; the resumed process is tagged `DWARFAI_SPAWN=v1:<installId>:<launchId>:<hostEpoch>` with
// this Host's epoch (the Host that spawns it), and the launch is named, so the Claude stream-json
// driver can ask its live relay again (ISSUE-182). The bridge lives in host/wiring because suppliers
// never imports launching (R3, R4): each driver takes it as its `resumeContext` dependency.
import type { HostEpoch, LaunchId } from '../../kernel/domain/values'
import { spawnTagFor, type OwnedLaunches } from '../../modules/launching'
import type { SessionRef } from '../../modules/suppliers'

export function createResumeContextLookup(deps: {
  owned: Pick<OwnedLaunches, 'liveRecordOfSession'>
  installId: string
  hostEpoch: HostEpoch
}): (ref: SessionRef) => { cwd: string; spawnTag: string; launchId: LaunchId } | null {
  return (ref) => {
    const record = deps.owned.liveRecordOfSession({
      providerId: ref.providerId,
      providerSessionId: ref.providerSessionId,
      ...(ref.providerAgentId === undefined ? {} : { providerAgentId: ref.providerAgentId })
    })
    if (record === null) return null
    return {
      cwd: record.cwd,
      spawnTag: spawnTagFor(deps.installId, record.launchId, deps.hostEpoch),
      launchId: record.launchId
    }
  }
}
