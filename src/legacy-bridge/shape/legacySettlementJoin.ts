// The legacy settlement join (21 §3.1, steps 3a–4b; lead decision 2026-10-17): from 3a the renderer calls A-35 and A-23
// with the `14` shapes for every provider, and `PerProviderShapeAdapter` answers a launch or a send of a provider not yet
// moved with an id it mints (a UUIDv7 `LaunchId` or `MessageId`, 14 §1.6), because today's ids are not UUIDv7. The
// settlement of those calls stays on today's pushes until they retire at the end of 4b: A-P3 (`agent:launchFailed`)
// names today's receipt (`receipt:N`), A-P4 (`dwarf:sendText:settled`) today's `holdId`. This join remembers which
// minted id answered which legacy id, and its push mapping puts the minted id in the push's own field, so the renderer
// correlates the settlement with the id it was answered. A-P3 and A-P4 keep `shape: 'today'`: no field is added,
// renamed or removed (21 §3), only the id's value changes.
//
// - Each legacy id settles once: today's runtime pushes one A-P3 per failed launch and one A-P4 per held message, so a
//   second push naming the same id is stale and leaves untouched.
// - A legacy id the join does not hold (not minted by the adapter, already settled, or forgotten) leaves untouched:
//   never a guess, never withheld (lead decision 2026-10-17).
// - The join is bounded: a launch that does not fail never gets an A-P3, so its entry would never settle. Past
//   `capacity` entries per kind the oldest is forgotten first.
//
// Composed only by `src/ui-main/index.ts` (R16), together with `PerProviderShapeAdapter`; deleted with it after 4b
// (later: ISSUE-240).
//
// Candidate decision (21 §6): no candidate exists; new code.
import type { LegacyPushMap } from '../LegacyDwarfIdBridge'

const LAUNCH_FAILED_PUSH = 'agent:launchFailed' // A-P3
const SETTLED_PUSH = 'dwarf:sendText:settled' // A-P4

/** Entries kept per kind when none is given: far above the launches and held messages in flight at once. */
export const SETTLEMENT_JOIN_CAPACITY = 256

export interface LegacySettlementJoin {
  /** Today's receipt `receiptId` was answered to the renderer as the minted `launchId`. */
  recordLaunch(receiptId: string, launchId: string): void
  /** Today's held message `holdId` was answered to the renderer as the minted `messageId`. */
  recordHold(holdId: string, messageId: string): void
  /** The minted launch id of today's receipt, once; `null` when the join does not hold it. */
  settleLaunch(receiptId: string): string | null
  /** The minted message id of today's hold, once; `null` when the join does not hold it. */
  settleHold(holdId: string): string | null
}

/** One kind of entry, in the order recorded (a `Map` iterates in insertion order). */
function boundedEntries(capacity: number) {
  const entries = new Map<string, string>()
  return {
    record(legacyId: string, mintedId: string): void {
      entries.delete(legacyId)
      entries.set(legacyId, mintedId)
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value as string
        entries.delete(oldest)
      }
    },
    settle(legacyId: string): string | null {
      const minted = entries.get(legacyId)
      if (minted === undefined) return null
      entries.delete(legacyId)
      return minted
    }
  }
}

export function createLegacySettlementJoin(
  options: { capacity?: number } = {}
): LegacySettlementJoin {
  const capacity = options.capacity ?? SETTLEMENT_JOIN_CAPACITY
  const launches = boundedEntries(capacity)
  const holds = boundedEntries(capacity)
  return {
    recordLaunch: launches.record,
    recordHold: holds.record,
    settleLaunch: launches.settle,
    settleHold: holds.settle
  }
}

/** Which field of today's push names the legacy id, and how the join settles it. */
const JOINED_FIELDS: Readonly<
  Record<
    string,
    { field: string; settle: (join: LegacySettlementJoin, id: string) => string | null }
  >
> = {
  [LAUNCH_FAILED_PUSH]: { field: 'launchId', settle: (join, id) => join.settleLaunch(id) },
  [SETTLED_PUSH]: { field: 'holdId', settle: (join, id) => join.settleHold(id) }
}

/**
 * The push mapping of A-P3 and A-P4 for `LegacyPushTap`: `inner` (the id bridge's mapping, which gives A-P4 its Host
 * dwarf id or withholds it) maps first, then the joined id replaces today's id in its own field. A push `inner`
 * withholds stays withheld; one the join does not hold leaves as `inner` left it.
 */
export function createSettlementPushMap(deps: {
  join: LegacySettlementJoin
  inner?: LegacyPushMap
}): LegacyPushMap {
  const { join, inner } = deps
  const own = Object.keys(JOINED_FIELDS)
  const pushChannels = [...(inner?.pushChannels ?? []), ...own]
  return {
    pushChannels: pushChannels.filter((channel, index) => pushChannels.indexOf(channel) === index),
    async push(channel, payload) {
      const mapped =
        inner?.pushChannels.includes(channel) === true
          ? await inner.push(channel, payload)
          : payload
      const joined = JOINED_FIELDS[channel]
      if (joined === undefined || mapped === null || typeof mapped !== 'object') return mapped
      const legacyId = (mapped as Record<string, unknown>)[joined.field]
      if (typeof legacyId !== 'string') return mapped
      const minted = joined.settle(join, legacyId)
      return minted === null ? mapped : { ...mapped, [joined.field]: minted }
    }
  }
}
