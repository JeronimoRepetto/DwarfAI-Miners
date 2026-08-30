import type { MaterialTotals, Mine } from '../../shared/contracts'

/**
 * Decides whether one poll's result is worth pushing to the renderer (#25).
 *
 * The poller is the ground truth and runs every 2 seconds forever, but most of
 * those polls re-observe a state that did not move: an idle session's
 * transcript mtime is unchanged, its token counter is unchanged, and the vault
 * accrued nothing. Pushing that identical snapshot still costs a structured
 * clone in main, a wake-up in the renderer, and a Vue re-render — measured at
 * roughly two style recalculations per push — for a panel that would paint
 * exactly the same pixels.
 *
 * Suppression is safe precisely because the test is EQUALITY with what was
 * last sent: when this says no, the renderer is already holding that exact
 * state, so nothing can be missed. Anything that moves — a dwarf's status, a
 * token count, a mine arriving or leaving, the vault growing — differs and
 * publishes immediately, so latency is unchanged.
 */
export class PublishGate {
  private lastPublished: string | undefined

  /**
   * True when this snapshot differs from the one last published (and should
   * therefore be sent). Remembers it either way, so callers stay stateless.
   *
   * Compared as JSON rather than field by field on purpose: every field of
   * every mine and dwarf is included automatically, so a future field added to
   * the contract cannot silently fall outside the comparison and strand the
   * panel on a stale value.
   */
  shouldPublish(mines: Mine[], materials: MaterialTotals | undefined): boolean {
    const serialized = JSON.stringify({ mines, materials })
    if (serialized === this.lastPublished) return false
    this.lastPublished = serialized
    return true
  }
}
