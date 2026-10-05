// The board frames of seam B (14 §2.4 B-F06, B-F08, B-F09, B-F10; 14 §3.5, §3.6, frozen),
// projected from the mines and crew events (08 §2.1, §2.2). Each event is published after its
// commit (16 §2.3) and handled synchronously, so its frame is enqueued before the command that
// caused it answers (14 §1.7 "effects before response"). A frame carries the full read model as it
// is after the commit — the mine or the dwarf read through the modules' public queries and mapped
// by mappers/wire.ts — never the event payload, so every frame of one kind has the same shape as
// the snapshot section it updates (sections/mines.ts, sections/dwarfs.ts).
//
// - `mine.changed {mine}` (B-F06) ← `MineCreated`, `MineReattached`. The measurement events
//   (`MineMeasurementStarted`, `MineMeasured`, `MineBecameUnenterable/Enterable`) join with their
//   module (later: ISSUE-065), `DwarfWorkplaceChanged` (→ `dwarf.changed`) with the workplace
//   stamp (ADR-030 D4). A mine no longer on the board when its event is handled sends nothing: it
//   is `mine.removed`'s (later: ISSUE-080).
// - `dwarf.arrived {dwarf, announce}` (B-F08) ← `DwarfArrived`. `announce` is the toast "`<d>`
//   started in `<mine>`" (08 §2.2; US-OBS-002.AC07): true for an observed arrival in a known mine.
//   Observed: the dwarf is not `owned` (no live `LaunchRecord`, 14 §3.6, INV-30). Known: the mine
//   was on the board before this arrival — not created or reattached in the same Host turn, which
//   is how the observer's one route lands a session in a folder that was not a mine (US-OBS-001;
//   US-OBS-002.AC08; 11 §2 steps 4–7). Package gap: 08 §2.2 does not define "known"; this is the
//   owner-consistent reading, recorded in the ISSUE-082 hand-off.
// - `dwarf.changed {dwarf}` (B-F09) ← `DwarfStatusChanged`, `DwarfPresenceChanged`; `DwarfRenamed`,
//   `DwarfStopRequested` and `OutcomeLineChanged` join with their commands and owners (later:
//   ISSUE-079, EPIC-10, EPIC-06). The outbound queue folds a waiting `dwarf.changed` into the newer
//   one of the same dwarf within a Host tick (14 §1.8, events/outbound.ts); each frame here is the
//   whole dwarf, so the one that stays is the latest. A departed dwarf sends no `dwarf.changed`:
//   `dwarf.departed` is its last frame.
// - `dwarf.departed {dwarfId, mineId, cause}` (B-F10) ← `DwarfDeparted`, for `ui` and the viewer of
//   that dwarf (ADR-031 item 2). It is the only walk-out trigger (14 §4.3 rule 6), and no departure
//   cause sends anything else from here: an observed dwarf whose process died on its own departs
//   `closed-elsewhere` with no toast, like any outside closure (S2.06; US-RES-001.AC01; FM-059).
//   The other toasts of 14 §2.4 B-F28 come from their own events (later: ISSUE-080).
// - `toast {kind: 'provider-error', providerId, cause, dwarfId?}` (B-F28, 14 §3.6 `HostToast`) ←
//   observation's `ProviderErrorObserved` (ISSUE-084; 05 §4; US-RES-004), for `ui`. Observation
//   already folds it to one per `(providerId, cause, dwarfId?)` and poll cycle (08 §2.3), so each
//   event is one toast. The frame is built field by field from the event: a typed cause, never
//   the provider's text (16 §2.1; ADR-026 item 4). A drift that surfaced is the same toast, worded
//   no differently (US-RES-004.AC04). Nothing else is sent: the dwarf keeps its status, with no
//   errored state (US-RES-004.AC02; ADR-032), and a session that did not survive departs through
//   crew's own `DwarfDeparted` (US-RES-004.AC03).
// - `DwarfRebound` has no frame (14 §2.4 "No frame exists for").
//
// Nothing here logs: the board frames carry custom names, folder paths and provider causes (14 §3.5
// SENSITIVE_FRAMES).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { CrewEvent, CrewQueries } from '../../modules/crew'
import type { MinesEvent, MinesQueries } from '../../modules/mines'
import type { ObservationEvent } from '../../modules/observation'
import type { FrameAudience } from '../events/framePublisher'
import { toDwarfWire, toMineWire, type MineTotalsReader } from '../mappers/wire'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const BOARD_FRAMES: readonly HostFrameName[] = Object.freeze([
  'mine.changed',
  'dwarf.arrived',
  'dwarf.changed',
  'dwarf.departed',
  'toast'
])

/** Where the frames go: the connection registry (connectionRegistry.ts). */
export interface BoardFramePublisher {
  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void
}

export interface BoardFramesDeps {
  /** The Host's event bus, as each module's events (16 §2.3). */
  events: {
    mines: Pick<DomainEventBus<MinesEvent>, 'subscribe'>
    crew: Pick<DomainEventBus<CrewEvent>, 'subscribe'>
    observation: Pick<DomainEventBus<ObservationEvent>, 'subscribe'>
  }
  mines: Pick<MinesQueries, 'get'>
  crew: Pick<CrewQueries, 'get'>
  /** The ledger's totals (`NO_LEDGER_TOTALS` until the ledger is wired, later: ISSUE-096). */
  ledger: MineTotalsReader
  frames: BoardFramePublisher
}

/** Routes the board events to their frames; returns the unsubscribe. */
export function publishBoardFrames(deps: BoardFramesDeps): () => void {
  const { frames } = deps
  /** The mines that came onto the board in this Host turn: an arrival there is not announced. */
  const newThisTurn = new Set<MineId>()
  const cameOntoBoard = (mineId: MineId): void => {
    newThisTurn.add(mineId)
    queueMicrotask(() => newThisTurn.delete(mineId))
  }

  const mineChanged = (mineId: MineId): void => {
    const view = deps.mines.get(mineId)
    if (view === null) return
    frames.publishFrame('mine.changed', {
      mine: toMineWire(view, deps.ledger.totalsOf(mineId))
    })
  }
  const dwarfChanged = (dwarfId: DwarfId): void => {
    const view = deps.crew.get(dwarfId)
    if (view === null || view.departed) return
    frames.publishFrame('dwarf.changed', { dwarf: toDwarfWire(view) })
  }

  const unsubscribes = [
    deps.events.mines.subscribe('MineCreated', (event) => {
      cameOntoBoard(event.payload.mineId)
      mineChanged(event.payload.mineId)
    }),
    deps.events.mines.subscribe('MineReattached', (event) => {
      cameOntoBoard(event.payload.mineId)
      mineChanged(event.payload.mineId)
    }),
    deps.events.crew.subscribe('DwarfArrived', (event) => {
      const view = deps.crew.get(event.payload.dwarfId)
      if (view === null || view.departed) return
      const announce = !view.owned && !newThisTurn.has(view.mineId)
      frames.publishFrame('dwarf.arrived', { dwarf: toDwarfWire(view), announce })
    }),
    deps.events.crew.subscribe('DwarfStatusChanged', (event) =>
      dwarfChanged(event.payload.dwarfId)
    ),
    deps.events.crew.subscribe('DwarfPresenceChanged', (event) =>
      dwarfChanged(event.payload.dwarfId)
    ),
    deps.events.crew.subscribe('DwarfDeparted', (event) => {
      const { dwarfId, mineId, cause } = event.payload
      frames.publishFrame('dwarf.departed', { dwarfId, mineId, cause }, { dwarfId })
    }),
    deps.events.observation.subscribe('ProviderErrorObserved', (event) => {
      const { providerId, cause, dwarfId } = event.payload
      frames.publishFrame('toast', {
        kind: 'provider-error',
        providerId,
        cause,
        ...(dwarfId === undefined ? {} : { dwarfId })
      })
    })
  ]
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
