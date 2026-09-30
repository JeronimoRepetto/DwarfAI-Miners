import { describe, expect, it } from 'vitest'
import { SETTLE_DRAIN_LIMIT, settleDrainOutcome } from './renderer.mjs'

/*
 * The settle drain loop's own stopping rule (#635), pinned without a browser or a design
 * repository. A mount can still be waiting on a microtask chain that only queues its virtual
 * animation frame after that microtask resolves — DwarfMessagePanel's showLatest scrolls to the
 * newest message one frame after the panel is built — so a settle() that advances the clock once
 * and calls it done can capture a page whose rAF-gated write never landed (organisms/message-panel
 * #conversation and #asking, 31.7% differing). This is the pure half of settle()'s drain loop:
 * given one pass's probe (a signature of the mounted stage), decide whether to keep draining,
 * declare the page settled, or give up.
 *
 * Whether a virtual timer is still queued is deliberately not an input here (AMENDED, #635): the
 * first version gated on window.__snapRuntime.clock().pending reaching 0, which never happens for
 * a state whose component keeps an ordinary setInterval running for its own lifetime
 * (DwarfMessagePanel's idle-time ticker) — the real golden run for organisms/message-panel
 * #conversation proved this by draining all 20 passes without ever settling. The signature alone
 * is what a capture actually grades.
 */
describe('settleDrainOutcome', () => {
  it('keeps draining until the stage has been probed at least twice', () => {
    // No previous signature to compare against yet: one probe alone proves no stability, even one
    // that already looks like the state it will settle into.
    expect(settleDrainOutcome({ pass: 1, signature: 'a', previousSignature: null })).toEqual({
      done: false,
      exceeded: false
    })
  })

  it('keeps draining while the stage is still changing between passes', () => {
    expect(settleDrainOutcome({ pass: 2, signature: 'b', previousSignature: 'a' })).toEqual({
      done: false,
      exceeded: false
    })
  })

  it('settles once the signature holds across a pass', () => {
    expect(settleDrainOutcome({ pass: 3, signature: 'b', previousSignature: 'b' })).toEqual({
      done: true,
      exceeded: false
    })
  })

  it('gives up loudly once the pass cap is reached without settling', () => {
    expect(
      settleDrainOutcome({
        pass: SETTLE_DRAIN_LIMIT,
        signature: 'still moving',
        previousSignature: 'a'
      })
    ).toEqual({ done: true, exceeded: true })
  })

  it('settling wins over the cap when both are reached on the same pass', () => {
    expect(
      settleDrainOutcome({ pass: SETTLE_DRAIN_LIMIT, signature: 'b', previousSignature: 'b' })
    ).toEqual({ done: true, exceeded: false })
  })
})
