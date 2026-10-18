/*
 * The launcher label of a delegated worker's first message, the subtask brief (US-DLG-003; PO
 * decision 2026-09-28 #53; AMENDMENT-23). The Host names the launcher by its id alone
 * (`MessageView.issuer.dwarfId`, 14 §3.6), so the label reads the launcher as the board holds it
 * now: its custom name when the person set one, else its base name (US-DLG-003.AC03), and it
 * follows a later rename. Only the brief carries an issuer, so only the brief wears the label
 * (US-DLG-003.AC04).
 */
import type { Mine, MessageIssuer } from '../../types'
import { dwarfDisplayName } from '../dwarf/displayName'

/** Today's `MessageIssuer` of the launcher `launcherId` on the board, or undefined when it holds none. */
export function launcherIssuerOf(
  launcherId: string,
  mines: readonly Pick<Mine, 'dwarfs'>[]
): MessageIssuer | undefined {
  for (const mine of mines) {
    const launcher = mine.dwarfs.find((dwarf) => dwarf.id === launcherId)
    if (launcher !== undefined) {
      return { role: launcher.role, name: dwarfDisplayName(launcher), launcherId }
    }
  }
  return undefined
}

/** The label's words: "from `<dwarf>`" (PO decision 2026-09-28 #53). */
export function launcherLabel(issuer: Pick<MessageIssuer, 'name'>): string {
  return `from ${issuer.name}`
}
