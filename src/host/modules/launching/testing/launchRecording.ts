// The recovery-table seed (16 §4.5 "a `processes` row exists for every live owned session after a
// crash mid-handshake"; ADR-015 Verification): the order in which a launch writes its rows (16 §4.5
// `launch` Tx column, 16 §2.2 record before acting, 07 S4.01), as three steps a test drives and can
// stop between, the way a Host crash stops a launch. The launch use case (later: ISSUE-162) owns the
// production order; ISSUE-173's recovery pass reads what these steps leave. Never imported by
// production code (R14).
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import { applyLaunchEvent, type Launch, type LaunchEvent } from '../domain/launch'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { LaunchStore } from '../ports/launchStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'

export interface LaunchingStores {
  launches: LaunchStore
  processes: ProcessRecordStore
  records: LaunchRecordStore
  inTransaction<T>(work: () => T): T
}

export interface LaunchRecording {
  /** Send: the `launches` row is committed before any driver is asked (16 §2.9). */
  requested(launch: Launch): Launch
  /** The OS spawn returned: the `processes` row, before the handshake wait (16 §2.2). */
  spawned(launch: Launch, identity: ProcessIdentity, at: Instant): Launch
  /** The handshake answered: the session is owned (`launch_records`) and the launch succeeded. */
  handshaken(launch: Launch, dwarfId: DwarfId, record: LaunchRecord): Launch
}

function step(launch: Launch, event: LaunchEvent): Launch {
  const result = applyLaunchEvent(launch, event)
  if (!result.ok) throw new Error(`launch transition refused: ${event.t}`)
  return result.value.launch
}

export function launchRecording(stores: LaunchingStores): LaunchRecording {
  return {
    requested: (launch) => {
      stores.inTransaction(() => stores.launches.put(launch))
      return launch
    },
    spawned: (launch, identity, at) => {
      const next = step(launch, { t: 'spawned', at })
      stores.inTransaction(() => {
        stores.processes.put({
          identity,
          purpose: 'session',
          launchId: launch.id,
          hostEpoch: launch.hostEpoch
        })
        stores.launches.put(next)
      })
      return next
    },
    handshaken: (launch, dwarfId, record) => {
      const next = step(launch, { t: 'succeeded', dwarfId })
      stores.inTransaction(() => {
        stores.records.put(record)
        stores.launches.put(next)
      })
      return next
    }
  }
}
