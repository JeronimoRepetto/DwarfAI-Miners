/**
 * Which Codex threads can be handed a queued message (#97).
 *
 * `codex queue --thread <UUID> --message <text>` persists an item on a thread's
 * own queue and the thread drains it at its next idle boundary. The addressing
 * needs nothing new — the UUID is exactly the `CodexThread.threadId` the
 * registry read already carries — so the whole question is which threads the
 * drain has been WATCHED happening on.
 *
 * Two conditions, and both are evidence rather than inference:
 *
 * - `source = 'cli'`. The live experiment (2026-09-02, Codex 0.151.0, Windows)
 *   queued to an idle TUI thread and watched the row appear in
 *   `queue_1.sqlite`, disappear 6-8s later, and the message render in the TUI
 *   with a reply. No app-server daemon was involved, which is what makes this
 *   channel exist on Windows at all — `codex app-server daemon` is Unix-only.
 *   Desktop-app (`vscode`) threads are UNPROVEN, not disproven: nobody has
 *   watched one drain, so they report no channel. A queue that accepts an item
 *   and never drains it is the exit-0-shaped lie this gate exists to prevent —
 *   the send would exit 0, the row would land, the panel would show a ✓, and
 *   nothing would ever read it.
 * - The thread's own `cli_version` is at or above CODEX_QUEUE_MIN_VERSION. Per
 *   THREAD, not per machine: a session opened by an older Codex is honestly
 *   unreachable even on a machine whose installed CLI is new enough.
 */

/**
 * The Codex release that added `codex queue` — "Added `codex queue` for sending
 * messages to existing local or remote sessions", rust-v0.149.0, 2026-08-20.
 */
export const CODEX_QUEUE_MIN_VERSION = '0.149.0'

const MIN_COMPONENTS: readonly [number, number, number] = [0, 149, 0]

/** The leading numeric triple of a build string, or null when it has none. */
function parseVersionTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether `version` is at or above the floor. Compared as numbers, because as
 * text '0.99.0' sorts after '0.149.0' while being the older Codex.
 *
 * An absent, blank or unparseable version is false. `threads.cli_version` is a
 * `NOT NULL DEFAULT ''` column, so "never written" arrives here as nothing at
 * all, and nothing is not a version that clears a floor. A prerelease suffix is
 * ignored rather than ranked: `0.149.0-rc.1` reads as 0.149.0, which is one
 * patch-level of optimism on a build the user chose to install.
 */
export function meetsCodexQueueVersionFloor(version: string | undefined): boolean {
  if (version === undefined) return false
  const parsed = parseVersionTriple(version)
  if (parsed === null) return false
  for (const [index, floor] of MIN_COMPONENTS.entries()) {
    const component = parsed[index] as number
    if (component > floor) return true
    if (component < floor) return false
  }
  return true
}

/** The registry facts the queue capability is decided from, and nothing else. */
export interface CodexQueueCandidate {
  /** The plain `threads.source` tag; absent for a sub-agent spawn blob. */
  sourceTag?: string
  /** The Codex build that opened this thread, from the same registry row. */
  cliVersion?: string
}

/** Whether this thread's queue is one a message has been proven to reach. */
export function canQueueToCodexThread(thread: CodexQueueCandidate): boolean {
  return thread.sourceTag === 'cli' && meetsCodexQueueVersionFloor(thread.cliVersion)
}
