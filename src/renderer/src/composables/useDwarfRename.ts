import type { DwarfId, IpcResult } from '@dwarfai/contracts'
import type { DwarfNameRequest, DwarfNameResult } from '../types'
import { mintRequestId } from './requestIds'

/*
 * Where a dwarf's rename and reset go (14 §2.2 A-N08 / A-N09; ISSUE-172 lead decision, 2026-10-17; ISSUE-243).
 *
 * A-N08 `renameDwarf` and A-N09 `resetDwarfName` are routed `host` from cut 2: every dwarf is renamed and reset by the
 * Host (B-M22, B-M23), which normalizes the text, stores it and publishes `dwarf.changed` to every window, and refuses a
 * dwarf it does not know. Every dwarf can be renamed (US-MSG-005.AC14). AMENDED for ISSUE-243 (was: a dwarf only
 * today's runtime carried kept the legacy rows `dwarf:setName` / `dwarf:resetName` of 14 §8 I-21): the board is the
 * Host's alone since ISSUE-242, and those rows left with today's runtime (21 §2 cut 5).
 *
 * The answer is today's `DwarfNameResult`, which the panel announces (lib/message/rename): the Host's stored name,
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
  /** Back to the base name through A-N09 (B-M23), at once. */
  const hostReset = async (dwarfId: string): Promise<DwarfNameResult> => {
    const answer = await window.api.resetDwarfName({
      dwarfId: dwarfId as DwarfId,
      requestId: mintRequestId()
    })
    return answer.ok ? { saved: true } : notSaved
  }
  return {
    /** Save a custom name through A-N08; an empty name is A-N09's reset. */
    async setName(request: DwarfNameRequest): Promise<DwarfNameResult> {
      if (request.name.trim() === '') return hostReset(request.dwarfId)
      return renamed(
        await window.api.renameDwarf({
          dwarfId: request.dwarfId as DwarfId,
          name: request.name,
          requestId: mintRequestId()
        })
      )
    },
    /** Back to the base name through A-N09, at once. */
    resetName(dwarfId: string): Promise<DwarfNameResult> {
      return hostReset(dwarfId)
    }
  }
}
