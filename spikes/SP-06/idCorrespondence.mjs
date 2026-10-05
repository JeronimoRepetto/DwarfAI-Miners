#!/usr/bin/env node
/**
 * SP-06 (ADR-006, ADR-007): do the live stream and the provider's transcript name the same units with the same ids?
 * Reads two JSONL files of one session and prints counts only: never an id, a text or a path.
 *
 * Usage: node spikes/SP-06/idCorrespondence.mjs --provider <claude|codex|opencode> --stream <file> --transcript <file>
 *
 * - `sharedIdPaths`: for every id value present in both files, the key path that holds it on each side
 *   (`uuid` ↔ `uuid`, `message.id` ↔ `message.id`, `payload.turn_id` ↔ `turn_id`), with how many values they share.
 * - `units` (Claude only): the ADR-006 `unitKey` is the assistant `message.id`; its usage is the last row that
 *   carries one (HR O4, the final stop-state row). Reports the keys on each side, the shared ones, and on how many
 *   of the shared ones the usage numbers agree.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The keys whose value is an id that could name one unit on both paths. */
export const ID_KEYS = new Set([
  'id',
  'uuid',
  'session_id',
  'sessionId',
  'sessionID',
  'message_id',
  'messageId',
  'messageID',
  'turn_id',
  'turnId',
  'item_id',
  'itemId',
  'call_id',
  'callID'
])

/** One JSON value per non-empty line; a line that is not JSON is skipped (counted by the caller as records). */
export function parseJsonl(text) {
  const records = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn or foreign line: skipped, as the observer skips it (INV-38).
    }
  }
  return records
}

/**
 * The id values of a set of records by key path (`message.id`, `payload.turn_id`; array positions left out).
 *
 * @returns {Map<string, Set<string>>}
 */
export function collectIds(records) {
  const ids = new Map()
  const walk = (value, prefix) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, prefix)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      const keyPath = prefix === '' ? key : `${prefix}.${key}`
      if (ID_KEYS.has(key) && (typeof item === 'string' || typeof item === 'number')) {
        if (!ids.has(keyPath)) ids.set(keyPath, new Set())
        ids.get(keyPath).add(String(item))
      } else {
        walk(item, keyPath)
      }
    }
  }
  for (const record of records) walk(record, '')
  return ids
}

/** Claude's ADR-006 units: assistant `message.id` → the usage of the last row that carries one. */
function claudeUnits(records) {
  const units = new Map()
  for (const record of records) {
    const message = record?.type === 'assistant' ? record.message : undefined
    if (typeof message?.id !== 'string') continue
    if (message.usage !== undefined && message.usage !== null) units.set(message.id, message.usage)
    else if (!units.has(message.id)) units.set(message.id, null)
  }
  return units
}

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
]

const sameUsage = (a, b) =>
  a !== null && b !== null && USAGE_FIELDS.every((field) => (a[field] ?? 0) === (b[field] ?? 0))

/** Counts only: which ids the two paths share, under which keys, and (Claude) whether shared units agree. */
export function idCorrespondence(provider, stream, transcript) {
  const streamIds = collectIds(stream)
  const transcriptIds = collectIds(transcript)
  const sharedIdPaths = []
  for (const [streamPath, streamValues] of streamIds) {
    for (const [transcriptPath, transcriptValues] of transcriptIds) {
      let shared = 0
      for (const value of streamValues) if (transcriptValues.has(value)) shared++
      if (shared > 0) sharedIdPaths.push({ stream: streamPath, transcript: transcriptPath, shared })
    }
  }
  let units = null
  if (provider === 'claude') {
    const streamUnits = claudeUnits(stream)
    const transcriptUnits = claudeUnits(transcript)
    const shared = [...streamUnits.keys()].filter((key) => transcriptUnits.has(key))
    const usageEqual = shared.filter((key) =>
      sameUsage(streamUnits.get(key), transcriptUnits.get(key))
    ).length
    units = {
      stream: streamUnits.size,
      transcript: transcriptUnits.size,
      shared: shared.length,
      onlyStream: streamUnits.size - shared.length,
      onlyTranscript: transcriptUnits.size - shared.length,
      usageEqual,
      usageDiffers: shared.length - usageEqual
    }
  }
  return {
    stream: { records: stream.length },
    transcript: { records: transcript.length },
    sharedIdPaths,
    units
  }
}

function main(argv) {
  const args = {}
  for (let i = 0; i + 1 < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!args.provider || !args.stream || !args.transcript) {
    process.stderr.write(
      'usage: node spikes/SP-06/idCorrespondence.mjs --provider <p> --stream <file> --transcript <file>\n'
    )
    process.exitCode = 2
    return
  }
  const read = (file) => parseJsonl(readFileSync(file, 'utf8'))
  const result = idCorrespondence(args.provider, read(args.stream), read(args.transcript))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
