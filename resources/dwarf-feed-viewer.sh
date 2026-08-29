#!/bin/sh
# Live viewer for a dwarf's transcript, opened by DwarfAI-Miners on macOS and
# Linux when no existing terminal window can be focused for a click-to-focus
# session (see src/main/terminalLauncher.ts and src/main/runtime.ts).
#
# POSIX counterpart of dwarf-feed-viewer.ps1: it pretty-prints the tail of a
# JSONL transcript (Claude Code session, Claude Code subagent, or Codex CLI
# rollout — the record shapes differ, see the formatter below), then follows
# the file live like `tail -f` so new turns keep appearing as the agent works.
#
# This is a debugging/visibility aid, not a parser of record: it only needs to
# be readable, not exhaustive. An unrecognized record is silently skipped.
#
# Why a JavaScript formatter instead of sed/awk: JSONL needs a real JSON
# parser, and every machine running this app already has one — the app ships
# its own Node runtime. --node receives that binary (process.execPath); an
# Electron binary runs as plain Node when ELECTRON_RUN_AS_NODE is set, and a
# real `node` simply ignores the variable. If the formatter cannot run at all,
# the raw JSONL is shown instead of nothing.
#
# Usage: sh dwarf-feed-viewer.sh --path <transcript> --title <name> [--node <bin>]

set -u

TRANSCRIPT=''
TITLE='dwarf'
NODE_BIN='node'
# How many past messages the opening history block shows.
HISTORY_MESSAGES=30
# How many trailing lines of the transcript are parsed for that history.
HISTORY_LINES=400
# How long to wait for a brand-new session's transcript file to appear.
WAIT_SECONDS=30

while [ $# -gt 0 ]; do
  case "$1" in
    --path) TRANSCRIPT="${2-}"; shift 2 || exit 1 ;;
    --title) TITLE="${2-}"; shift 2 || exit 1 ;;
    --node) NODE_BIN="${2-}"; shift 2 || exit 1 ;;
    *) shift ;;
  esac
done

if [ -z "$TRANSCRIPT" ]; then
  printf 'dwarf-feed-viewer: --path is required\n' >&2
  exit 2
fi

# Mirrors the PowerShell viewer's ConvertTo-DisplayMessage: turn one JSONL
# record into { role, text }, or nothing when it carries nothing worth showing.
# With DWARFAI_HISTORY set it buffers and prints only the last N messages;
# otherwise it streams each message as it arrives.
FORMATTER=$(cat <<'DWARF_FORMATTER_JS'
const readline = require('node:readline')
const MAX_CHARS = 600
const historyLimit = Number(process.env.DWARFAI_HISTORY ?? '0')
const buffered = []

function joined(blocks, type, key) {
  if (!Array.isArray(blocks)) return undefined
  const texts = blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === type)
    .map((block) => block[key])
    .filter((text) => typeof text === 'string' && text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

function toDisplayMessage(record) {
  if (record === null || typeof record !== 'object' || typeof record.type !== 'string') return null
  // Claude Code session and subagent transcripts: { type, message: {...} }
  if (record.type === 'assistant' && record.message) {
    const text = joined(record.message.content, 'text', 'text')
    return text === undefined ? null : { role: 'assistant', text }
  }
  if (record.type === 'user' && record.isMeta !== true && record.message) {
    const content = record.message.content
    if (typeof content === 'string' && !content.startsWith('<')) return { role: 'user', text: content }
    return null
  }
  // Codex CLI rollouts: { type, payload: {...} }
  if (record.type === 'event_msg' && record.payload && record.payload.type === 'user_message') {
    const message = record.payload.message
    return typeof message === 'string' && message !== '' ? { role: 'user', text: message } : null
  }
  if (
    record.type === 'response_item' &&
    record.payload &&
    record.payload.type === 'message' &&
    record.payload.role === 'assistant'
  ) {
    const text = joined(record.payload.content, 'output_text', 'text')
    return text === undefined ? null : { role: 'assistant', text }
  }
  return null
}

function render(message) {
  const label = message.role === 'assistant' ? 'Agent   ' : 'Request '
  const color = message.role === 'assistant' ? '\u001b[36m' : '\u001b[97m'
  const text =
    message.text.length > MAX_CHARS ? message.text.slice(0, MAX_CHARS) + ' [...]' : message.text
  process.stdout.write(`${color}[${label}]\u001b[0m ${text}\n\n`)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let record
  try {
    record = JSON.parse(trimmed)
  } catch {
    return // partial or corrupt line (a tail read can start mid-write) — skip
  }
  const message = toDisplayMessage(record)
  if (message === null) return
  if (historyLimit > 0) {
    buffered.push(message)
    if (buffered.length > historyLimit) buffered.shift()
    return
  }
  render(message)
})

process.stdin.on('end', () => {
  for (const message of buffered) render(message)
})
DWARF_FORMATTER_JS
)

# $1 is how many past messages to buffer and print at EOF; 0 (the default)
# streams every message as it arrives. It is an argument rather than a
# preceding assignment because POSIX assignments in front of a FUNCTION call
# persist in the shell, which would leave the live tail buffering forever.
format() {
  DWARFAI_HISTORY="${1-0}" ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e "$FORMATTER" 2>/dev/null || cat
}

# Set the window/tab title the way the PowerShell viewer sets $Host.UI.RawUI —
# an OSC escape works in every terminal this script is launched from, which
# keeps the launcher free of per-terminal title flags.
printf '\033]0;%s - DwarfAI-Miners\007' "$TITLE"
printf '\033[33m=== %s ===\033[0m\n' "$TITLE"
printf '\033[90mTranscript: %s\033[0m\n\n' "$TRANSCRIPT"

# A brand-new session's transcript file can lag a beat behind the process
# actually starting — wait briefly instead of failing immediately.
waited=0
while [ ! -f "$TRANSCRIPT" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do
  sleep 1
  waited=$((waited + 1))
done

if [ -f "$TRANSCRIPT" ]; then
  # Bounded tail read: readable history without loading a huge file whole.
  tail -n "$HISTORY_LINES" "$TRANSCRIPT" | format "$HISTORY_MESSAGES"
else
  printf '\033[31mTranscript not found after waiting: %s\033[0m\n' "$TRANSCRIPT"
  printf '\033[90mIt will keep being watched in case it appears.\033[0m\n'
fi

printf '\033[90m--- following live (Ctrl+C to stop) ---\033[0m\n\n'

# -F follows by name and retries, so a transcript that has not been created yet
# (or is rotated) still gets picked up. -n 0 streams only what is appended from
# here on: the history block above already covered the existing tail.
tail -n 0 -F "$TRANSCRIPT" 2>/dev/null | format
