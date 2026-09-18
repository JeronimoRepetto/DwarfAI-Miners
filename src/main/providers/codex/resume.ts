import { isCodexOneShotThread } from './state'

/**
 * Which Codex threads can be handed a message by starting their next turn
 * (#450) — the other half of the registry row `queue.ts` answers.
 *
 * `codex exec [OPTIONS] resume <SESSION_ID> -` was measured live (Codex CLI
 * 0.153.4): the session id comes back unchanged, the earlier context is intact,
 * the prompt is read from stdin, and Codex's registry still holds ONE row whose
 * `source` stays `'exec'`. So this is the channel for exactly the threads the
 * queue refuses, and the two gates are disjoint by construction rather than by
 * agreement — one `threads.source` value cannot be both.
 *
 * ## Why every exec thread, not only the ones this panel launched
 *
 * The measurement itself resumed a thread the panel never started — an ordinary
 * `codex exec` typed in a shell — so narrowing to a panel launch would refuse
 * a route that was proven on the other case. And "this panel launched it" is
 * not a fact that survives: LaunchedSessionRegistry forgets a launch the moment
 * its process exits, which is precisely when a resume becomes useful. The
 * registry row records the SHAPE of the session and nothing about who typed it,
 * which is the same reasoning `isCodexOneShotThread` is written under.
 *
 * ## Why no version floor
 *
 * The queue carries one (#97) because its failure is silent: an item accepted
 * onto a queue nothing drains exits 0, and the panel would show a ✓ for a
 * message nobody reads. A Codex build with no `exec resume` refuses the argv
 * outright and the process dies inside the delivery tier's start window, so the
 * person reads a refusal. The measurement is 0.153.4 and no older build has
 * been tried; that is stated rather than encoded, because here the unproven
 * case fails loudly on its own.
 */
export interface CodexResumeCandidate {
  /** The plain `threads.source` tag; absent for a sub-agent spawn blob. */
  sourceTag?: string
  /** The build that opened the thread. Read by nothing here — see above. */
  cliVersion?: string
}

/**
 * Whether this thread is one a resumed turn can reach.
 *
 * Deliberately the same comparison `isCodexOneShotThread` makes, and made
 * THROUGH it rather than beside it: one prompt and one turn is the same
 * registry fact as "nothing is running to hand a message to", and two spellings
 * of one fact is how they start disagreeing. The name is its own because the
 * question is — #231 asks what shape the session has, this asks how to reach it.
 */
export function canResumeCodexThread(thread: CodexResumeCandidate): boolean {
  return isCodexOneShotThread(thread)
}

/**
 * Everything one resumed turn has to be addressed by: the thread, and the
 * folder it runs in.
 *
 * The folder is here rather than looked up at delivery time because it is a
 * fact the scan already resolved — the same value the snapshot reports — and
 * because there is no second place to get it from once the thread is gone.
 */
export interface CodexResumeAddress {
  threadId: string
  cwd: string
  /**
   * The thread's own observed model/effort (#462, D2), read off the same
   * registry row/rollout `turn_context` the label on screen is drawn from.
   * This is a RECORD of what the thread already shows, never a claim about
   * what the next turn will run — that is `resumeTuning`'s job, one layer up,
   * where it is merged against what a launch may have explicitly asked for.
   * Absent when nothing observed it, which keeps a "no tuning anywhere"
   * address bare rather than carrying `undefined`-valued keys.
   */
  model?: string
  effort?: string
}
