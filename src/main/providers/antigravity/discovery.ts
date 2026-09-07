import { join } from 'node:path'
import type { DirEntry } from '../../adapters/fsLike'

/**
 * Finding the Antigravity CLI's conversations in its own store, and the one
 * fact the store records that this app cannot do without: which folder a
 * conversation belongs to.
 *
 * The layout, verified live on Antigravity CLI 1.1.26 (docs/provider-formats.md §3):
 *
 * ```
 * ~/.gemini/antigravity-cli/
 *   presence/<conversation-id>.lock                        a 0-byte lock, while the CLI runs
 *   history.jsonl                                          {display, timestamp, workspace, conversationId?}
 *   brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 * ```
 *
 * Two readings the validated scope of #237 corrected, and they are the reason
 * this module exists rather than a join or two inline:
 *
 * - **A lock is a hint, not a contract.** It matched a live conversation in the
 *   sample, which is evidence and not proof: a crash leaves the file behind,
 *   and there is no documented promise about when the CLI removes one. The
 *   provider therefore pairs it with a grace window on disappearance and a
 *   staleness bound, and never treats a lock alone as permanent liveness.
 * - **`conversation_summaries.db` is not the join.** None of the CLI
 *   conversation ids on the tested machine existed in that database, and the
 *   rows that were there had blank status/parent/depth columns. `history.jsonl`
 *   is what actually mapped them, so it is what is read here — and it is read
 *   defensively, because it also records prompts that belong to no
 *   conversation at all.
 */

/** Where the CLI writes one lock per running conversation. */
export function antigravityPresenceDir(storeRoot: string): string {
  return join(storeRoot, 'presence')
}

/** The prompt log that carries the conversation → workspace mapping. */
export function antigravityHistoryPath(storeRoot: string): string {
  return join(storeRoot, 'history.jsonl')
}

/** One conversation's step log — the file `feed()` reads and a terminal can tail. */
export function antigravityTranscriptPath(storeRoot: string, conversationId: string): string {
  return join(storeRoot, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
}

const LOCK_SUFFIX = '.lock'

/**
 * The conversations the CLI currently claims are running, in id order.
 *
 * Sorted rather than left in listing order so two scans of an unchanged store
 * produce the same sequence of snapshots — the determinism `createProviders`
 * keeps for the same reason.
 *
 * A bare `.lock` with no id in front of it is dropped: it names no
 * conversation, and an empty id would key a dwarf nothing could ever match.
 */
export function antigravityConversationIdsFromLocks(entries: readonly DirEntry[]): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(LOCK_SUFFIX)) continue
    const id = entry.name.slice(0, -LOCK_SUFFIX.length)
    if (id !== '') ids.push(id)
  }
  return ids.sort()
}

/** Where one conversation was last being used, and when that was recorded. */
export interface AntigravityWorkspace {
  /** The folder the CLI recorded, verbatim — this is what places the mine. */
  workspace: string
  /** The record's own `timestamp`, in epoch ms. */
  timestampMs: number
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The workspace behind every conversation `history.jsonl` names, newest record
 * per conversation.
 *
 * Newest by TIMESTAMP rather than by line, because a resumed conversation
 * keeps both records and the folder it is in now is the later one. Reading the
 * first would pin a dwarf to a mine its session had left.
 *
 * Three shapes are skipped, and each is ordinary rather than corrupt:
 *
 * - **No `conversationId`.** A slash command typed before any conversation
 *   existed writes a record with a workspace and no id (the first record on
 *   the captured machine was exactly this). There is nothing to attribute it to.
 * - **No `workspace`.** Nothing else in the store recovers one, and a mine
 *   invented from a conversation id would be a phantom project.
 * - **Not readable at all.** A half-written final line, or a byte-tail read
 *   that opened mid-record. Both are what reading a file the CLI is appending
 *   to looks like.
 */
export function parseAntigravityHistory(text: string): Map<string, AntigravityWorkspace> {
  const byConversation = new Map<string, AntigravityWorkspace>()
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
    const conversationId = parsed.conversationId
    const workspace = parsed.workspace
    const timestamp = parsed.timestamp
    if (typeof conversationId !== 'string' || conversationId === '') continue
    if (typeof workspace !== 'string' || workspace === '') continue
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
    const known = byConversation.get(conversationId)
    if (known !== undefined && known.timestampMs > timestamp) continue
    byConversation.set(conversationId, { workspace, timestampMs: timestamp })
  }
  return byConversation
}
