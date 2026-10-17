import type { DwarfId, IpcResult } from '@dwarfai/contracts'
import type { DwarfNameRequest, DwarfNameResult } from '../types'
import { mintRequestId } from './requestIds'
import { useMines } from './useMines'

/*
 * Where a dwarf's rename and reset go (14 §2.2 A-N08 / A-N09, §8 I-21; ISSUE-172 lead decision, 2026-10-17).
 *
 * A-N08 `renameDwarf` and A-N09 `resetDwarfName` are routed `host` from cut 2: they are NEW rows with no legacy owner,
 * and the renderer's board is the Host's once its first snapshot is read (useMines, one writer, A-N01 / A-N02), so a
 * dwarf the Host's board carries is renamed and reset by the Host (B-M22, B-M23), which normalizes the text, stores
 * it and publishes `dwarf.changed` to every window. A dwarf only today's runtime carries (a board still fed by today's
 * feed, e.g. a build whose table refuses A-N01) keeps the legacy rows `dwarf:setName` / `dwarf:resetName`, which
 * today's runtime serves until cut 5. Every dwarf can be renamed (US-MSG-005.AC14); the Host board is read through its
 * published `state.mines` so a caller's computed follows every board change.
 *
 * Both paths answer today's `DwarfNameResult`, which the panel announces (lib/message/rename): the Host's stored name,
 * nothing for the base name, and today's own words when nothing was stored. An empty save is a reset (US-MSG-005.AC04).
 *
 * The panel's rename calls live here (ADR-033 item 2; 05 §5.1 R13: `window.api` only in composables).
 */

/** Today's words when a name was not stored, as today's main says them (`DWARF_NAME_NOT_SAVED`). */
export const NAME_NOT_SAVED = 'The name could not be saved.'

const notSaved: DwarfNameResult = { saved: false, reason: NAME_NOT_SAVED }

/** A-N08's answer as today's verdict: the stored name, nothing for the base name, else not saved. */
function renamed(
  answer: IpcResult<
    { ok: true; value: { customName: string | null } } | { ok: false; error: 'empty' }
  >
): DwarfNameResult {
  if (!answer.ok || !answer.value.ok) return notSaved
  const { customName } = answer.value.value
  return customName === null ? { saved: true } : { saved: true, customName }
}

export function useDwarfRename() {
  const mines = useMines()
  /** Whether the Host's board carries this dwarf, so the Host renames it. */
  const onHostBoard = (dwarfId: string): boolean => {
    void mines.state.mines
    return mines.hostDwarfs().some((dwarf) => dwarf.id === dwarfId)
  }
  /** Back to the base name through A-N09 (B-M23), at once. */
  const hostReset = async (dwarfId: string): Promise<DwarfNameResult> => {
    const answer = await window.api.resetDwarfName({
      dwarfId: dwarfId as DwarfId,
      requestId: mintRequestId()
    })
    return answer.ok ? { saved: true } : notSaved
  }
  return {
    /** Save a custom name: A-N08 for a Host dwarf (an empty name is its reset), else I-21 `dwarf:setName`. */
    async setName(request: DwarfNameRequest): Promise<DwarfNameResult> {
      if (!onHostBoard(request.dwarfId)) return window.api.setDwarfName(request)
      if (request.name.trim() === '') return hostReset(request.dwarfId)
      return renamed(
        await window.api.renameDwarf({
          dwarfId: request.dwarfId as DwarfId,
          name: request.name,
          requestId: mintRequestId()
        })
      )
    },
    /** Back to the base name: A-N09 for a Host dwarf, else I-21 `dwarf:resetName`, with the same verdict. */
    resetName(dwarfId: string): Promise<DwarfNameResult> {
      if (onHostBoard(dwarfId)) return hostReset(dwarfId)
      return window.api.resetDwarfNameToday(dwarfId)
    }
  }
}
