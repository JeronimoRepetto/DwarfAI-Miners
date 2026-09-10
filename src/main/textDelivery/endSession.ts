/**
 * What both end tiers say, and how long either waits — the parts of
 * `endConsoleSession` that must not differ per operating system (#366).
 *
 * Kick means one thing on all three platforms since #366, and a person reading
 * the panel must not be able to tell which platform refused them. The two
 * verdicts below were written for the Windows tier (#329, #231, #358) and are
 * shared rather than re-typed because the WORDING is not the point: the meaning
 * is, and a second copy is how one of them would drift into claiming something
 * the other does not.
 *
 * The mechanisms stay per-OS and stay in their own ports: a tree kill on
 * Windows, a direct signal to the pid on macOS and Linux (see processEnd.ts on
 * why the two cannot be one act).
 */

/**
 * What an end that did not happen is called (#329).
 *
 * Never "the session was ended": the platform reports false for a refusal, a
 * missing tool and a pid it cannot find alike, and the last of those is what a
 * second kick on an already-ended session looks like.
 */
export const SESSION_NOT_ENDED = 'This session could not be ended.'

/**
 * Why nothing was signalled: the pid could not be proved to still be this
 * session (#231's rule, applied to #329's act).
 *
 * The provider verified this pid's creation time at the last poll, which can be
 * seconds old, and a pid is a number the OS recycles. So the pid is re-probed
 * inside the act and compared again, and the comparison must AGREE — a mismatch
 * and an unreadable process list are both refusals. That asymmetry is
 * deliberate and is the opposite of the liveness guard's: an unknown there fails
 * open, because a wrong "dead" only hides a dwarf, and an unknown here fails
 * closed, because ending a recycled pid ends a stranger's program and no verdict
 * afterwards can take that back.
 */
export const SESSION_NOT_VERIFIED =
  "This session's process could not be verified, so nothing was ended."

/**
 * How long a cleanly-asked session is given to exit before it is forced, and how
 * often the pid is looked at in that window (#358).
 *
 * About three seconds, ten looks ~300ms apart — measured against the Claude Code
 * TUI's own Ctrl+C-twice exit: long enough for it to tear down and restore the
 * terminal, short enough that a person waiting on a kick is not left wondering
 * whether it worked. The same window covers the POSIX tier's SIGTERM (#366),
 * because what is being waited on is the same CLI running the same teardown —
 * only the way it was asked differs.
 *
 * The whole window still counts as the one act the person waits through, so both
 * ports measure it inside the same `spawn` stage as the forced end behind it.
 */
export const GRACEFUL_EXIT_POLL_COUNT = 10
export const GRACEFUL_EXIT_POLL_INTERVAL_MS = 300
