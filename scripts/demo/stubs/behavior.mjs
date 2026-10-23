/**
 * How a demo stub picks what to do for one turn: the scripted behaviour for the turn's words (trimmed), else the
 * script's fallback. With no script at all, an empty turn with a plain reply, so a stub never fails a turn.
 */

const EMPTY = Object.freeze({ steps: [], stepMs: 0, ask: null, reply: 'Noted.', tokens: 0 })

export function behaviorFor(script, text) {
  if (script === null || typeof script !== 'object') return EMPTY
  const words = String(text).trim()
  return script.behaviors?.[words] ?? script.fallback ?? EMPTY
}
