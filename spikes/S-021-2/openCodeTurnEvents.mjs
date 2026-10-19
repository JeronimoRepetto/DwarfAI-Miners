#!/usr/bin/env node
/**
 * S-021-2 (ADR-021 item 4): which OpenCode server event marks a completed turn? Reads the session's event stream (one
 * JSON event per line, as `spikes/SP-06/captureTranscript.mjs --sse` keeps it) and prints how often each event kind
 * occurred and which kinds occurred exactly once per prompt sent. Counts and event names only: never a text or an id.
 *
 * Usage: node spikes/S-021-2/openCodeTurnEvents.mjs <events.jsonl> --turns <prompts sent>
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonl } from '../SP-06/idCorrespondence.mjs'

/**
 * The kind of one event: its type, with the status for `session.status`; a `message.updated` that carries a
 * completion time is `message.completed:<role>`, counted once per message id (it is sent again on later updates).
 */
function kindOf(event) {
  const type = typeof event?.type === 'string' ? event.type : '<no type>'
  const properties = event?.properties ?? {}
  if (type === 'session.status') {
    const status = properties.status
    return { kind: `session.status:${typeof status === 'string' ? status : (status?.type ?? '?')}` }
  }
  const info = properties.info
  if (type === 'message.updated' && info?.time?.completed !== undefined) {
    return { kind: `message.completed:${info.role ?? '?'}`, distinct: String(info.id) }
  }
  return { kind: type }
}

/** How often each event kind occurred, and the kinds that occurred exactly `turns` times (sorted). */
export function openCodeTurnEvents(events, turns) {
  const counts = new Map()
  const seen = new Map()
  for (const event of events) {
    const { kind, distinct } = kindOf(event)
    if (distinct !== undefined) {
      if (!seen.has(kind)) seen.set(kind, new Set())
      if (seen.get(kind).has(distinct)) continue
      seen.get(kind).add(distinct)
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return {
    turns,
    counts: Object.fromEntries(counts),
    oncePerTurn: [...counts]
      .filter(([, count]) => count === turns)
      .map(([kind]) => kind)
      .sort()
  }
}

function main(argv) {
  const [file] = argv
  const turnsIndex = argv.indexOf('--turns')
  const turns = turnsIndex >= 0 ? Number(argv[turnsIndex + 1]) : Number.NaN
  if (file === undefined || !Number.isInteger(turns) || turns < 1) {
    process.stderr.write(
      'usage: node spikes/S-021-2/openCodeTurnEvents.mjs <events.jsonl> --turns <n>\n'
    )
    process.exitCode = 2
    return
  }
  const result = openCodeTurnEvents(parseJsonl(readFileSync(file, 'utf8')), turns)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
