// The DwarfAI handoff marker (ADR-013 item 6; 18 §4.3 T-25, C-26). A delegation result pushed to
// its parent as turn input carries the marker on its first line, and the marker names the
// delegation it was pushed for (architect-proposed in 18 T-25). Recognising the marker is not
// enough to hide a text: conversation hides only an echo whose marker names a delegation it pushed
// to that dwarf itself (application/deliverInvisibly.ts), so an agent printing a marker of its own
// makes nothing disappear.
//
// Package gap (resolved in dev): no document fixes the marker's spelling. It is one bracketed line
// a person or an agent would not write by chance, ahead of the result text, which stays whole.

const MARKER_LINE = /^\[DwarfAI handoff ([0-9A-Za-z-]{1,64})\]\r?\n/

/** The result text as it is pushed: the marker line, then the text unchanged. */
export function markHandoff(delegationId: string, text: string): string {
  return `[DwarfAI handoff ${delegationId}]\n${text}`
}

/** The delegation id the text's first line names, or null when it carries no marker there. */
export function handoffMarkOf(text: string): string | null {
  return MARKER_LINE.exec(text.trimStart())?.[1] ?? null
}
