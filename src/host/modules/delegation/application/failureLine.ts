// The parent's chat line of a failed delegation (US-DLG-005.AC01, PO #45; 07 S8.02, S8.04–S8.07,
// S8.09, S8.11, S8.13; 08 §2.8 `DelegationFailed` consumer; 16 §5.4 "Parent chat line"; ISSUE-206).
//
// - Every 06 `DelegationFailure` but `parent-gone` gives the parent's chat exactly one ordinary
//   `system-line` (`producesParentLine`, 16 §5.4); `parent-gone` has none (S8.11: the parent's chat
//   cannot receive it). The limits and an unknown ticket create no delegation, so no
//   `DelegationFailed` and no line, at all.
// - The text is the approved US-DLG-005.AC01 line, the same for every cause: no reason sentence is
//   part of it (the `effort-ceiling` reason sentence is design's, ADR-028 open item, and still
//   `⟦COPY NEEDED: effort-ceiling reason sentence⟧`). `<dwarf>` is the parent's display name,
//   `customName ?? baseName` (ADR-018 item 9), resolved by the caller when the line is written.
// - The line's natural key is `delegation-failed:<delegationId>` (16 §4.6 `ingest`; the
//   `message_keys` claim), so a replayed `DelegationFailed` appends nothing (INV-82).
//
// The line is persisted as a message row, so it is written as its approved text here, as asking's
// auto-denied line is (`asking/domain/emission.ts`); it is not looked up from the UI copy dictionary.
//
// Pure: no I/O, no clock (05 §2.2).
import type { DwarfId } from '../../../kernel/domain/values'
import type { DelegationId } from '../domain/delegation'
import type { DelegationFailed } from '../domain/events'
import { producesParentLine } from '../domain/toolFailure'

/** One `system-line` for the parent's own conversation. */
export interface ParentFailureLine {
  readonly parentDwarfId: DwarfId
  /** The line's natural key in the parent's log (INV-82). */
  readonly sourceKey: string
  readonly text: string
}

/** The natural key of the failure line of `delegationId`. */
export function delegationFailedLineKey(delegationId: DelegationId): string {
  return `delegation-failed:${delegationId}`
}

/** The approved PO #45 line, `<dwarf>` being the parent's display name. */
export function delegationFailedLineText(parentName: string): string {
  return `Jev could not take this subtask. ${parentName} continues it with its own subagent.`
}

/** The parent's line for `failed`, or `null` when its failure shows none (`parent-gone`). */
export function parentFailureLine(
  failed: DelegationFailed['payload'],
  parentName: string
): ParentFailureLine | null {
  if (!producesParentLine(failed.failure)) return null
  return {
    parentDwarfId: failed.parentDwarfId,
    sourceKey: delegationFailedLineKey(failed.delegationId),
    text: delegationFailedLineText(parentName)
  }
}
