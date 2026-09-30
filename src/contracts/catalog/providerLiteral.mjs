// R12's provider-literal regex source (05 §5.3), derived from the catalog ids, never hand-kept (ADR-004 P9).
// Plain ESM so the ESLint flat config can import it (later: ISSUE-005).

/**
 * @param {ReadonlyArray<string>} ids
 * @returns {string}
 */
export function providerLiteralPattern(ids) {
  return `/^(${ids.map((id) => id.replace(/[-]/g, '\\-')).join('|')})$/`
}
