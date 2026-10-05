#!/usr/bin/env node
/**
 * S-032-1 (ADR-032 items 4–5): the inputs of the inferred-end rule and of `INFERRED_TURN_END_MS` per adapter, and
 * whether an observed ask leaves evidence. Reads one transcript (Claude JSONL or a Codex rollout) and prints, per
 * turn, its duration and its longest silence between two records, and what the capture ends on (a tool call still
 * waiting for its result is the candidate evidence of an observed ask). Durations, kinds and tool names only.
 *
 * Usage: node spikes/S-032-1/turnGaps.mjs --provider <claude|codex> <transcript.jsonl>
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isClaudePrompt } from '../S-021-1/claudeTurnEnds.mjs'
import { parseJsonl } from '../SP-06/idCorrespondence.mjs'

const startsTurn = {
  claude: isClaudePrompt,
  codex: (record) => record?.type === 'event_msg' && record.payload?.type === 'task_started'
}

/** The tool calls still waiting for their result, in call order: `[id, name]`. */
function waitingCalls(provider, records) {
  const calls = new Map()
  for (const record of records) {
    if (provider === 'codex') {
      const payload = record?.payload
      if (payload?.type === 'function_call') calls.set(payload.call_id, payload.name)
      if (payload?.type === 'function_call_output') calls.delete(payload.call_id)
      continue
    }
    const content = Array.isArray(record?.message?.content) ? record.message.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') calls.set(block.id, block.name)
      if (block?.type === 'tool_result') calls.delete(block.tool_use_id)
    }
  }
  return [...calls]
}

/** What the capture ends on: a tool call still waiting, the provider's own turn end, or the last record's kind. */
function endsOn(provider, records) {
  const waiting = waitingCalls(provider, records)
  if (waiting.length > 0) {
    return { kind: 'tool-call-waiting', tool: waiting[waiting.length - 1][1] ?? null }
  }
  const last = records[records.length - 1]
  if (provider === 'codex') {
    const type = last?.payload?.type ?? last?.type
    return { kind: type === 'task_complete' ? 'turn-complete' : String(type), tool: null }
  }
  return { kind: last?.type === 'assistant' ? 'assistant-message' : String(last?.type), tool: null }
}

/**
 * Per turn (from one prompt, or one Codex `task_started`, to the next): how many records it holds, how long it ran
 * and its longest silence between two consecutive records; the longest silence of all; and what the capture ends on.
 * Records without a readable timestamp are left out of the timing.
 */
export function turnGaps(provider, records) {
  const turns = []
  for (const record of records) {
    const at = Date.parse(record?.timestamp)
    if (startsTurn[provider](record)) turns.push([])
    if (turns.length === 0 || !Number.isFinite(at)) continue
    turns[turns.length - 1].push(at)
  }
  const measured = turns.map((times) => {
    let maxGapMs = 0
    for (let i = 1; i < times.length; i++) maxGapMs = Math.max(maxGapMs, times[i] - times[i - 1])
    return {
      records: times.length,
      durationMs: times.length === 0 ? 0 : times[times.length - 1] - times[0],
      maxGapMs
    }
  })
  return {
    turns: measured,
    maxGapMs: measured.reduce((max, turn) => Math.max(max, turn.maxGapMs), 0),
    endsOn: endsOn(provider, records)
  }
}

function main(argv) {
  const providerIndex = argv.indexOf('--provider')
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined
  const file = argv.find((arg, index) => !arg.startsWith('--') && index !== providerIndex + 1)
  if (file === undefined || (provider !== 'claude' && provider !== 'codex')) {
    process.stderr.write(
      'usage: node spikes/S-032-1/turnGaps.mjs --provider <claude|codex> <transcript.jsonl>\n'
    )
    process.exitCode = 2
    return
  }
  const result = turnGaps(provider, parseJsonl(readFileSync(file, 'utf8')))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
