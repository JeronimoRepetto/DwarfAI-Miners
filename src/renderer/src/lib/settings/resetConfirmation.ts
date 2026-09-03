/**
 * The Settings reset-metrics modal's typed confirmation (#138).
 *
 * `components.md`'s confirmation-modal spec says the user types `Yes`/`yes`
 * to confirm, and states plainly that the PDF does not define case
 * sensitivity or whitespace handling. DECISION (#138): accept a
 * case-insensitive, trimmed 'yes' — trimmed because a stray leading or
 * trailing space is a typing accident rather than a different answer, and
 * case-insensitive because the source shows both cases as valid examples
 * without choosing between them. Pure so the gate on Confirm is unit tested
 * rather than eyeballed in a template.
 */
export function isValidResetConfirmation(typed: string): boolean {
  return typed.trim().toLowerCase() === 'yes'
}
