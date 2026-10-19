// Where the Antigravity CLI (`agy`) keeps what the observer reads, and the two facts its store
// records beside the step logs (15 §5 Antigravity row; #237; docs/provider-formats.md §3.1). Pure:
// paths and text in, facts out; no I/O.
//
// ```
// ~/.gemini/antigravity-cli/
//   brain/<conversationId>/.system_generated/logs/transcript.jsonl   the step log (`parse.ts`)
//   presence/<conversationId>.lock                                   a 0-byte lock while it runs
//   history.jsonl                                                    {display, timestamp, workspace, conversationId?}
//   conversations/<conversationId>.db                                usage (`conversationDb.ts`)
// ~/.gemini/antigravity/conversations/<conversationId>.db           the IDE tree (agy-backed clients)
// ~/.gemini/antigravity-acp/conversations/<conversationId>.db       the ACP tree
// ```
//
// - The lock is a hint, not a contract: a lock can be replaced between two reads, so the adapter
//   reads its disappearance only after a grace (`ANTIGRAVITY_LOCK_GRACE_MS`).
// - `history.jsonl` is what maps a conversation to its folder (the candidate found that
//   `conversation_summaries.db` does not). The newest record per conversation by timestamp wins:
//   a conversation resumed elsewhere keeps both records. A record without a conversation id (a
//   slash command typed before any conversation), without a workspace, or that is not JSON names
//   nothing.
//
// Never read here or anywhere in this adapter (ADR-008 item 2, Reuse; 18 C-18): credential files,
// `.pb` conversation files, keychain items, the local language server.
//
// Reimplemented from the candidate `src/main/providers/antigravity/discovery.ts` (R16).
import { join } from 'node:path'
import type { DirEntry } from '../../../../kernel/ports/fileSystem'

/** The agy CLI's store under `~/.gemini`. */
export const ANTIGRAVITY_CLI_TREE = 'antigravity-cli'

/** The three trees whose `conversations/` folders hold usage databases (15 §5, AMENDMENT-13). */
export const ANTIGRAVITY_TREES = [ANTIGRAVITY_CLI_TREE, 'antigravity', 'antigravity-acp'] as const

/** The folder holding the step logs, one sub-folder per conversation. */
export function brainDirOf(geminiDir: string): string {
  return join(geminiDir, ANTIGRAVITY_CLI_TREE, 'brain')
}

/** The folder the CLI writes one lock per running conversation into. */
export function presenceDirOf(geminiDir: string): string {
  return join(geminiDir, ANTIGRAVITY_CLI_TREE, 'presence')
}

/** The prompt log that maps a conversation to its workspace. */
export function historyPathOf(geminiDir: string): string {
  return join(geminiDir, ANTIGRAVITY_CLI_TREE, 'history.jsonl')
}

/** The `conversations/` folders of the three trees. */
export function conversationsDirsOf(geminiDir: string): string[] {
  return ANTIGRAVITY_TREES.map((tree) => join(geminiDir, tree, 'conversations'))
}

/** The step log's file name (the CLI's truncated view; `transcript_full.jsonl` is not read). */
export const TRANSCRIPT_NAME = 'transcript.jsonl'

const CONVERSATION_ID = /^[0-9A-Za-z][0-9A-Za-z-]*$/

/**
 * The conversation a step log belongs to: the folder under `brain/` that holds
 * `.system_generated/logs/transcript.jsonl`; null for any other file.
 */
export function conversationIdOfTranscript(path: string): string | null {
  const parts = path.split(/[\\/]/)
  const n = parts.length
  if (n < 5 || parts[n - 1] !== TRANSCRIPT_NAME) return null
  if (parts[n - 2] !== 'logs' || parts[n - 3] !== '.system_generated') return null
  const id = parts[n - 4]!
  return CONVERSATION_ID.test(id) ? id : null
}

/** The conversation a usage database belongs to (`<conversationId>.db`), or null. */
export function conversationIdOfDbName(name: string): string | null {
  if (!name.endsWith('.db')) return null
  const id = name.slice(0, -'.db'.length)
  return CONVERSATION_ID.test(id) ? id : null
}

const LOCK_SUFFIX = '.lock'

/** The conversations the CLI claims are running: one `<id>.lock` file each. */
export function lockedConversations(entries: readonly DirEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(LOCK_SUFFIX)) continue
    const id = entry.name.slice(0, -LOCK_SUFFIX.length)
    if (CONVERSATION_ID.test(id)) ids.add(id)
  }
  return ids
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The workspace of every conversation `history.jsonl` names: the newest record by timestamp. */
export function workspacesOfHistory(text: string): Map<string, string> {
  const newest = new Map<string, { workspace: string; at: number }>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const { conversationId, workspace, timestamp } = parsed
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) continue
    if (typeof workspace !== 'string' || workspace === '') continue
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
    const known = newest.get(conversationId)
    if (known !== undefined && known.at > timestamp) continue
    newest.set(conversationId, { workspace, at: timestamp })
  }
  return new Map([...newest].map(([id, { workspace }]) => [id, workspace]))
}
