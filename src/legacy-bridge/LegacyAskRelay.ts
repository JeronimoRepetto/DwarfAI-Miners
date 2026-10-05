// `LegacyAskRelay` (21 §3, cuts 1–4; 14 §5, §8 I-11 "the legacy-held-session ask relay"), the cut-1 half: in cut 1
// every ask still belongs to today's runtime, while the board comes from the Host. The relay shows today's open asks as
// ask cards through `BoardFacadeAdapter`'s ask fields and routes the answers back to today's runtime:
//
// - It reads today's open asks (`LegacyOpenAsks`): what `LegacyAgentRegistryFeed` last wrote into today's in-memory agent
//   registry, Codex pending questions included (`legacyOpenAsksOf`). Each ask keeps today's shape, and its id moves into
//   the relay's own namespace `legacy:<legacyAskId>`, which is never a UUIDv7, so it cannot collide with a Host `AskId`
//   (21 §3). Today's asks are identified by their `toolUseId`, so that is the legacy ask id.
// - Its dwarf is the Host dwarf with the same provider identity (`LegacyDwarfIdBridge`, an exact join); an ask whose
//   dwarf has no Host match shows no card (never a guess).
// - `update()` re-reads after each feed cycle; when a card opened, changed or closed it calls `changed`, which pushes the
//   facade's board again (`BoardFacade.refresh`): a closed legacy ask leaves the board at the next push.
// - A-40 / A-41 (`agent:answerQuestion` / `agent:answerPermission`, `shape: 'today'`): an answer whose ask id is in the
//   namespace and is the ask open now on that Host dwarf reaches today's runtime with the legacy dwarf id and the legacy
//   ask id. A Host dwarf the bridge cannot join answers the row's not-found shape (./rowShapes/notFound.ts); an answer to
//   an ask that is not open now (closed, another dwarf's, or outside the namespace) is stale and dropped with today's
//   "no longer open" shape (./rowShapes/notOpen.ts; ADR-010 stale drop). A permission reaches today's runtime only as
//   Allow or Deny (INV-73), and only the three fields today's handler reads.
//
// It writes nothing the Host writes (21 §1 item 4) and has no Host command path: the only Host read is the bridge's B-M41.
// Composed only by `src/ui-main/index.ts` (R16), in the releases 21 §3 lists it for (cut 1 to the end of 4b); from cut 2
// it is the legacy source of the dual-source ask read model (later: ISSUE-137), and it is deleted at the end of cut 4
// with `LegacyDwarfIdBridge` (later: ISSUE-241).
//
// Candidate decision (21 §6): no candidate exists; new code.
import type { ProviderSnapshot } from '../main/domain/types'
import type { LegacyAskFields } from './BoardFacadeAdapter'
import type { LegacyDwarfIdBridge, LegacyRowTarget } from './LegacyDwarfIdBridge'
import { NOT_FOUND } from './rowShapes/notFound'
import { NOT_OPEN, type NotOpenRow } from './rowShapes/notOpen'

/** The relay's own AskId namespace (21 §3). */
export const LEGACY_ASK_NAMESPACE = 'legacy:'

/** The relayed id of a legacy ask: `legacy:<legacyAskId>`. */
export function relayedAskId(legacyAskId: string): string {
  return `${LEGACY_ASK_NAMESPACE}${legacyAskId}`
}

/** The legacy ask id inside a relayed id, or `null` for an id outside the namespace. */
export function legacyAskIdOf(askId: unknown): string | null {
  if (typeof askId !== 'string' || !askId.startsWith(LEGACY_ASK_NAMESPACE)) return null
  const legacyAskId = askId.slice(LEGACY_ASK_NAMESPACE.length)
  return legacyAskId.length > 0 ? legacyAskId : null
}

/** One legacy dwarf's open asks, in today's shape, with today's ids. */
export interface LegacyDwarfAsks {
  legacyDwarfId: string
  asks: LegacyAskFields
}

/** Today's runtime's open asks. */
export interface LegacyOpenAsks {
  openAsks(): readonly LegacyDwarfAsks[]
}

/** Today's ask fields of each dwarf in today's sessions that carries one (as the feed wrote them). */
export function legacyOpenAsksOf(sessions: readonly ProviderSnapshot[]): LegacyDwarfAsks[] {
  const found: LegacyDwarfAsks[] = []
  for (const session of sessions) {
    for (const dwarf of session.dwarfs) {
      const { pendingQuestion, pendingPermission, waitingReason } = dwarf
      if (pendingQuestion === undefined && pendingPermission === undefined) continue
      found.push({
        legacyDwarfId: dwarf.id,
        asks: {
          ...(pendingQuestion === undefined ? {} : { pendingQuestion }),
          ...(pendingPermission === undefined ? {} : { pendingPermission }),
          ...(waitingReason === undefined ? {} : { waitingReason })
        }
      })
    }
  }
  return found
}

export interface LegacyAskRelay {
  /** Today's ask fields of a Host dwarf, ids relayed; none when it has no open legacy ask. */
  askFields(dwarfId: string): LegacyAskFields
  /** Re-reads today's open asks; `changed` is called when a card opened, changed or closed. */
  update(): Promise<void>
  /** Serves A-40 / A-41 as above; every other row passes to today's runtime unchanged. */
  serve(channel: string, payload: unknown): Promise<unknown>
  /** The today wires of the rows the relay serves (A-40, A-41). */
  readonly requestChannels: readonly string[]
  /** Nothing is read or changed after. */
  dispose(): void
}

const QUESTION = 'agent:answerQuestion' // A-40
const PERMISSION = 'agent:answerPermission' // A-41
const ASK_ROWS: readonly NotOpenRow[] = [QUESTION, PERMISSION]

/** The fields with each ask id moved into the relay's namespace. */
function relayed(asks: LegacyAskFields): LegacyAskFields {
  const { pendingQuestion, pendingPermission, waitingReason } = asks
  return {
    ...(pendingQuestion === undefined
      ? {}
      : {
          pendingQuestion: {
            ...pendingQuestion,
            toolUseId: relayedAskId(pendingQuestion.toolUseId)
          }
        }),
    ...(pendingPermission === undefined
      ? {}
      : {
          pendingPermission: {
            ...pendingPermission,
            toolUseId: relayedAskId(pendingPermission.toolUseId)
          }
        }),
    ...(waitingReason === undefined ? {} : { waitingReason })
  }
}

function sameCards(
  a: ReadonlyMap<string, LegacyAskFields>,
  b: ReadonlyMap<string, LegacyAskFields>
) {
  if (a.size !== b.size) return false
  for (const [dwarfId, asks] of a) {
    const other = b.get(dwarfId)
    if (other === undefined || JSON.stringify(other) !== JSON.stringify(asks)) return false
  }
  return true
}

export function createLegacyAskRelay(deps: {
  bridge: Pick<LegacyDwarfIdBridge, 'toHost' | 'toLegacy'>
  asks: LegacyOpenAsks
  legacy: LegacyRowTarget
  changed(): void
}): LegacyAskRelay {
  const { bridge, asks, legacy } = deps
  /** The cards shown now: Host dwarf id → today's ask fields, ids relayed. */
  let cards: ReadonlyMap<string, LegacyAskFields> = new Map()
  /** Each read is numbered; a read older than the one already applied is dropped. */
  let started = 0
  let applied = 0
  let disposed = false

  async function update(): Promise<void> {
    if (disposed) return
    started += 1
    const mine = started
    const next = new Map<string, LegacyAskFields>()
    const joined = new Set<string>()
    for (const { legacyDwarfId, asks: open } of asks.openAsks()) {
      const hostId = await bridge.toHost(legacyDwarfId)
      if (hostId === null) continue
      // Two legacy dwarfs on one Host dwarf: the join is not exact, so neither shows (never a guess).
      if (joined.has(hostId)) next.delete(hostId)
      else next.set(hostId, relayed(open))
      joined.add(hostId)
    }
    if (disposed || mine <= applied) return
    applied = mine
    const before = cards
    cards = next
    if (!sameCards(before, next)) deps.changed()
  }

  async function answer(channel: NotOpenRow, payload: unknown): Promise<unknown> {
    const fields = (payload ?? {}) as { dwarfId?: unknown; toolUseId?: unknown; decision?: unknown }
    const legacyAskId = legacyAskIdOf(fields.toolUseId)
    if (legacyAskId === null) return NOT_OPEN[channel]
    const hostId = typeof fields.dwarfId === 'string' ? fields.dwarfId : null
    const legacyDwarfId = hostId === null ? null : await bridge.toLegacy(hostId)
    if (hostId === null || legacyDwarfId === null) return NOT_FOUND[channel]
    const open = cards.get(hostId)
    const card = channel === QUESTION ? open?.pendingQuestion : open?.pendingPermission
    if (card?.toolUseId !== fields.toolUseId) return NOT_OPEN[channel]
    if (channel === PERMISSION) {
      const { decision } = fields
      if (decision !== 'allow' && decision !== 'deny') return { answered: false }
      return legacy.serve(channel, { dwarfId: legacyDwarfId, toolUseId: legacyAskId, decision })
    }
    return legacy.serve(channel, {
      ...(payload as object),
      dwarfId: legacyDwarfId,
      toolUseId: legacyAskId
    })
  }

  return {
    askFields: (dwarfId) => cards.get(dwarfId) ?? {},
    update,
    serve(channel, payload) {
      if ((ASK_ROWS as readonly string[]).includes(channel)) {
        return answer(channel as NotOpenRow, payload)
      }
      return legacy.serve(channel, payload)
    },
    requestChannels: ASK_ROWS,
    dispose() {
      disposed = true
    }
  }
}
