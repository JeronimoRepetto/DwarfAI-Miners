// The normalized comparison of a driver's `DriverEvent[]` with a hand-written expected file
// (17 §1.4 golden transcripts, 15 §6): the 15 §1.4 obligations checked on the stream itself, then
// every expected event found in order with an equal identity key (`sourceKey`, `turnKey`,
// `providerRequestId`, `unitKey`). A driver may coalesce or repeat `message` chunks and `activity`
// updates (15 §1.4), so an extra event whose identity key is expected is tolerated by the
// comparison; whether it may repeat at all is the ordering rules' question, never the comparison's.
import type { DriverEvent } from '../ports/providerDriver'

/** A JSON value as an expected file holds it. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

/** In an expected file, a string value that matches any string (a diagnostic `detail`, a reason). */
export const ANY_STRING = '$string'

/** Values the harness learns during a run, written `{name}` in an expected file (`{session}`). */
export type Bindings = Readonly<Record<string, string>>

/** `expected` with every `{name}` token of a string replaced by its binding. */
export function bind(expected: Json, bindings: Bindings): Json {
  if (typeof expected === 'string') {
    return expected.replace(/\{([a-zA-Z]+)\}/g, (token, name: string) => bindings[name] ?? token)
  }
  if (Array.isArray(expected)) return expected.map((item: Json) => bind(item, bindings))
  if (expected !== null && typeof expected === 'object') {
    const out: Record<string, Json> = {}
    for (const [key, value] of Object.entries(expected)) out[key] = bind(value as Json, bindings)
    return out
  }
  return expected
}

/**
 * Where `actual` differs from `expected` (already bound), as `path: why` lines; empty when equal.
 * Objects compare key for key in both directions: an extra field the driver adds is a difference.
 */
export function differences(actual: unknown, expected: Json, at = '$'): string[] {
  if (expected === ANY_STRING) {
    return typeof actual === 'string' ? [] : [`${at}: expected any string, got ${show(actual)}`]
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected an array, got ${show(actual)}`]
    if (actual.length !== expected.length) {
      return [`${at}: expected ${expected.length} items, got ${actual.length}`]
    }
    return expected.flatMap((item: Json, index) =>
      differences(actual[index], item, `${at}[${index}]`)
    )
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${at}: expected an object, got ${show(actual)}`]
    }
    const real = actual as Record<string, unknown>
    const keys = new Set([...Object.keys(expected), ...Object.keys(real)])
    const out: string[] = []
    for (const key of [...keys].sort()) {
      const want = (expected as Record<string, Json>)[key]
      if (real[key] === undefined && want === undefined) continue
      if (want === undefined) out.push(`${at}.${key}: unexpected ${show(real[key])}`)
      else out.push(...differences(real[key], want, `${at}.${key}`))
    }
    return out
  }
  return Object.is(actual, expected)
    ? []
    : [`${at}: expected ${show(expected)}, got ${show(actual)}`]
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/** The identity key of one event: what makes two events the same fact (15 §1.4, §1.5). */
export function identityOf(event: DriverEvent | Json): string {
  const e = event as Record<string, Record<string, unknown> | string | undefined>
  const field = (holder: string, name: string): string =>
    String((e[holder] as Record<string, unknown> | undefined)?.[name])
  switch (e.t) {
    case 'message':
      return `message ${field('record', 'sourceKey')}`
    case 'activity':
      return `activity ${field('step', 'sourceKey')}`
    case 'turn.ended':
      return `turn.ended ${field('end', 'turnKey')}`
    case 'usage':
      return `usage ${field('observation', 'unitKey')}`
    case 'ask.opened':
      return `ask.opened ${field('ask', 'providerRequestId')}`
    case 'ask.resolved':
      return `ask.resolved ${String(e.providerRequestId)}`
    case 'status':
      return `status ${String(e.value)}`
    case 'error':
      return `error ${field('cause', 'kind')}`
    case 'subagent':
      return `subagent ${field('childRef', 'providerSessionId')}:${field('childRef', 'providerAgentId')}`
    default:
      return String(e.t)
  }
}

/**
 * The 15 §1.4 obligations broken by a stream: `turn.ended` at most once per `turnKey` and after
 * every `activity` of its turn; `ask.opened` before any `ask.resolved` of the same id; `exited`
 * exactly last and at most once.
 */
export function orderingViolations(events: readonly DriverEvent[]): string[] {
  const out: string[] = []
  const ended = new Set<string>()
  const opened = new Set<string>()
  events.forEach((event, index) => {
    if (event.t === 'turn.ended') {
      if (ended.has(event.end.turnKey)) {
        out.push(`turn.ended for turnKey ${event.end.turnKey} more than once (15 §1.4)`)
      }
      ended.add(event.end.turnKey)
    }
    if (event.t === 'activity' && event.step.turnKey !== null && ended.has(event.step.turnKey)) {
      out.push(`activity of turn ${event.step.turnKey} after its turn.ended (15 §1.4)`)
    }
    if (event.t === 'ask.opened') opened.add(event.ask.providerRequestId)
    if (event.t === 'ask.resolved' && !opened.has(event.providerRequestId)) {
      out.push(`ask.resolved for ${event.providerRequestId} before its ask.opened (15 §1.4)`)
    }
    if (event.t === 'exited' && index !== events.length - 1) {
      out.push('exited is not the last event (15 §1.4)')
    }
  })
  return out
}

/**
 * The differences between a run's events and the expected ones: the ordering rules on the run,
 * then every expected event matched in order, then every unmatched actual event whose identity
 * key no expected event has (an event the contract did not expect).
 */
export function compareEvents(
  actual: readonly DriverEvent[],
  expected: readonly Json[],
  bindings: Bindings
): string[] {
  const out = orderingViolations(actual)
  const wanted = expected.map((event) => bind(event, bindings))
  const matched = new Set<number>()
  let cursor = 0
  for (const [index, want] of wanted.entries()) {
    let found = -1
    for (let at = cursor; at < actual.length; at++) {
      if (differences(actual[at], want).length === 0) {
        found = at
        break
      }
    }
    if (found === -1) {
      const near = actual.slice(cursor).find((event) => identityOf(event) === identityOf(want))
      const why = near === undefined ? 'no such event' : differences(near, want).join('; ')
      out.push(`expected event #${index} (${identityOf(want)}) not found in order: ${why}`)
      continue
    }
    matched.add(found)
    cursor = found + 1
  }
  const known = new Set(wanted.map((want) => identityOf(want)))
  actual.forEach((event, index) => {
    if (!matched.has(index) && !known.has(identityOf(event))) {
      out.push(`unexpected event #${index}: ${JSON.stringify(event)}`)
    }
  })
  return out
}

/** The `sourceKey`s of the facts a run produced (messages, activity, usage), in order (15 §1.5). */
export function sourceKeysOf(events: readonly DriverEvent[]): string[] {
  const keys: string[] = []
  for (const event of events) {
    if (event.t === 'message') keys.push(event.record.sourceKey)
    if (event.t === 'activity') keys.push(event.step.sourceKey)
    if (event.t === 'usage') keys.push(event.observation.sourceKey)
  }
  return keys
}
