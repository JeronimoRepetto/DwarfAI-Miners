// First-message detection (06 INV-39; PO #14): a session in a folder the app never knew becomes a
// mine and a dwarf on its first message, which is the first entry the person wrote. Today's
// `providers/firstPrompt.ts` finds the same thing in a transcript's head; here it is a rule over
// the parsed entries of a batch. Pure: no I/O, no clock read (05 §2.2, R1).

/** Whether the entries hold a message the person wrote (a `person` row, 15 §1.2). */
export function holdsFirstMessage(entries: ReadonlyArray<{ role: string }>): boolean {
  return entries.some((entry) => entry.role === 'person')
}
