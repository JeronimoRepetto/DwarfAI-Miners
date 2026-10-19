#!/usr/bin/env node
/**
 * S-021-1 (ADR-021 item 4): is a terminal `stop_reason` on the last assistant record of a Claude transcript one
 * reliable end per turn? Reads one transcript (JSONL) and prints, per turn, counts and stop reasons only: never a
 * text, an id or a path.
 *
 * Usage: node spikes/S-021-1/claudeTurnEnds.mjs <transcript.jsonl> [--turns <prompts sent>]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonl } from '../SP-06/idCorrespondence.mjs'

/** The stop reasons that end a turn; `tool_use` and `pause_turn` continue it, `null` is a partial row. */
export const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

/** A prompt the person (or the scripted recorder) sent: a user record that is not a tool result or a summary. */
export function isClaudePrompt(record) {
  if (record?.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
    return false
  }
  if (record.isSidechain === true) return false
  const content = record.message?.content
  if (typeof content === 'string') return true
  return (
    Array.isArray(content) &&
    content.some((block) => block?.type === 'text') &&
    !content.some((block) => block?.type === 'tool_result')
  )
}

/**
 * Per main-chain turn: its assistant messages (one per `message.id`, the stop reason of its last row that has one),
 * the tool uses, how many messages ended with a terminal stop reason, and the markers of the cases S-021-1 lists
 * (compaction, side-chain records of a subagent). A turn has one reliable end when exactly one message ended it and
 * that message is the turn's last.
 */
export function claudeTurnEnds(records) {
  const turns = []
  let current = null
  let sidechainRecords = 0
  for (const record of records) {
    if (record?.isSidechain === true) {
      sidechainRecords++
      if (current !== null) current.sidechainRecords++
      continue
    }
    if (isClaudePrompt(record)) {
      current = { stops: new Map(), toolUses: new Set(), compaction: false, sidechainRecords: 0 }
      turns.push(current)
      continue
    }
    if (current === null) continue
    if (record?.type === 'system' && record.subtype === 'compact_boundary')
      current.compaction = true
    const message = record?.type === 'assistant' ? record.message : undefined
    if (typeof message?.id !== 'string') continue
    if (!current.stops.has(message.id)) current.stops.set(message.id, null)
    if (message.stop_reason !== null && message.stop_reason !== undefined) {
      current.stops.set(message.id, message.stop_reason)
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool_use') current.toolUses.add(block.id)
    }
  }
  const perTurn = turns.map((turn) => {
    const stops = [...turn.stops.values()]
    const ends = stops.filter((stop) => TERMINAL_STOP_REASONS.has(stop)).length
    const lastStopReason = stops.length === 0 ? null : stops[stops.length - 1]
    return {
      assistantMessages: stops.length,
      toolUses: turn.toolUses.size,
      ends,
      lastStopReason,
      compaction: turn.compaction,
      sidechainRecords: turn.sidechainRecords,
      oneEnd: ends === 1 && TERMINAL_STOP_REASONS.has(lastStopReason)
    }
  })
  const turnsWithOneEnd = perTurn.filter((turn) => turn.oneEnd).length
  return {
    turns: perTurn.length,
    turnsWithOneEnd,
    reliable: perTurn.length > 0 && turnsWithOneEnd === perTurn.length,
    perTurn,
    sidechainRecords
  }
}

function main(argv) {
  const [file] = argv
  if (file === undefined) {
    process.stderr.write('usage: node spikes/S-021-1/claudeTurnEnds.mjs <transcript.jsonl>\n')
    process.exitCode = 2
    return
  }
  const result = claudeTurnEnds(parseJsonl(readFileSync(file, 'utf8')))
  const turnsIndex = argv.indexOf('--turns')
  if (turnsIndex >= 0) result.promptsSent = Number(argv[turnsIndex + 1])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
