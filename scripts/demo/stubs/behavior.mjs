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

/**
 * The reply of the `n`th time a behaviour runs (from 0): its `replies` in turn, so a dwarf asked the same thing again,
 * or a worker on its next pass, never says the same words twice in a row. A behaviour with one reply keeps it.
 */
export function replyOf(behavior, n) {
  const replies = behavior.replies ?? []
  return replies.length === 0 ? behavior.reply : replies[n % replies.length]
}
