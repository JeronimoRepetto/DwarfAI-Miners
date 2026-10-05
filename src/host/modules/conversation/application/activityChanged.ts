// `ActivityChanged` (08 §0, §2.6) for a run that a committed transaction changed: its final state,
// keyed (disclosureId, stepCount, open). Built after the commit by ingest, recordTurnEnd and
// recordSessionEnd alike, so the three routes publish one shape.
import type { EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { ActivityChanged } from '../domain/events'

export interface EventStamp {
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
}

export function activityChanged(run: ActivityDisclosure, stamp: EventStamp): ActivityChanged {
  return {
    type: 'ActivityChanged',
    v: 1,
    id: stamp.ids.uuidv7() as EventId,
    at: stamp.clock.now(),
    hostEpoch: stamp.hostEpoch,
    payload: {
      dwarfId: run.dwarfId,
      disclosureId: run.id,
      open: run.open,
      stepCount: run.stepCount
    }
  }
}
