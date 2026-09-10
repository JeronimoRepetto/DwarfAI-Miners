import type { SimulationConfig } from '../../config/config'
import type { FeedMessage, FeedPageCursor, ProviderSnapshot } from '../../domain/types'
import type { FeedWindowRead } from '../feedWindow'
import type { Provider } from '../provider'
import { hashInt, hashPick } from './rng'
import { simulatedMines, simulatedSnapshots, type SimulatedMine } from './world'

/**
 * A Provider that reports a valley nobody is running (issue #42).
 *
 * The thin runner over `world.ts`: it owns the clock, turns it into a tick, and
 * answers the same questions the real detectors answer. It reads no disk,
 * spawns no process and probes no pid — every scan is arithmetic.
 *
 * Its value is precisely that it is NOT a mock. It is wired in where
 * ClaudeProvider and CodexProvider are wired in, so aggregation, the lifecycle
 * grace window, the ledger, the publish gate, IPC and the whole renderer run
 * exactly the code they run in production. A mock would prove the panel can
 * draw a fixture; this proves the pipeline survives a crowd.
 */

/** Transcript lines the fake feed is assembled from. */
const FEED_LINES = [
  'Opened the seam and checked the timbering.',
  'Ran the numbers on the last cart of ore.',
  'Rerouted the lantern line past the wet section.',
  'Marked the face for tomorrow morning.',
  'Sorted the tailings back into the side gallery.',
  'Checked in with the foreman about the schedule.'
] as const

export interface SimulatedProviderOptions {
  config: SimulationConfig
  /** Injected for tests; defaults to the real clock. Drives ticks and `updatedAt`. */
  now?: () => number
}

export class SimulatedProvider implements Provider {
  /**
   * One of the two REAL provider identities, still, after #78.
   *
   * The reason used to be the cost of the edit: `DwarfProvider` was a closed
   * literal union, so admitting a third member meant finding every
   * hand-written copy of the list. #78 removed that reason — `DWARF_PROVIDERS`
   * is one table now and a new member is one entry — and this stays 'claude'
   * anyway, for the two reasons the edit cost was hiding.
   *
   * The first is the renderer: it still switches on provider identity for
   * sprite art and for a CSS class per provider, so a 'simulated' value would
   * arrive with no art behind it and draw wrong. That is the last of #78's
   * four places, and it waits on the UI rebuild in #105.
   *
   * The second outlives #105. This union is the WIRE contract a packaged build
   * publishes to the renderer, and a development-only tool has no business
   * adding a member to the product's own vocabulary — every consumer of a
   * dwarf would then owe an answer for a value that can only ever appear in an
   * unpackaged run. Claiming 'claude' costs nothing that matters (the field is
   * a label for logs and perf stages) and keeps the simulation
   * indistinguishable downstream, which is the entire point of #42. Individual
   * dwarfs still carry a mix of both providers, so both sprite sets are drawn.
   */
  readonly kind = 'claude' as const

  private readonly config: SimulationConfig
  private readonly now: () => number
  /** Tick 0 is the moment this provider was built, so a run always starts at the beginning. */
  private readonly startedAt: number
  private readonly mines: readonly SimulatedMine[]
  /**
   * Every id any scan has reported, so feed() can refuse a dwarf that was never
   * here — and still answer one that has since left (#192), the way a real
   * provider's transcript stays on disk after its session ends.
   */
  private readonly known = new Set<string>()

  constructor(options: SimulatedProviderOptions) {
    this.config = options.config
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    // Built once: mines are places, and a place must not be re-invented on
    // every poll or the map would reshuffle itself two seconds at a time.
    this.mines = simulatedMines(options.config)
  }

  async scan(): Promise<ProviderSnapshot[]> {
    const nowMs = this.now()
    const snapshots = simulatedSnapshots(this.config, this.mines, this.tick(nowMs), nowMs)
    for (const snapshot of snapshots) {
      for (const dwarf of snapshot.dwarfs) this.known.add(dwarf.id)
    }
    return snapshots
  }

  /**
   * A plausible transcript tail, so clicking a dwarf shows something rather
   * than an empty panel. Deterministic per dwarf, like everything else here.
   */
  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    if (!this.known.has(dwarfId)) return null
    const messages: FeedMessage[] = []
    for (let index = 0; index < Math.max(0, limit); index++) {
      messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: hashPick(`${dwarfId}:feed:${index}`, FEED_LINES),
        // A stable label rather than a real timestamp: nothing happened, and a
        // convincing time would be the one invented detail worth mistrusting.
        timestamp: `sim+${String(hashInt(`${dwarfId}:feed-age:${index}`, 60)).padStart(2, '0')}s`
      })
    }
    return messages
  }

  /**
   * One page of older conversation (#364), invented the same way the newest one
   * is — so the simulated valley exercises the panel's scrollback rather than
   * being the one provider where the control does nothing.
   *
   * Seeded off the CURSOR's own text rather than off a depth, because a
   * simulated session has no file whose start could be counted back to. It
   * answers exactly one page and then `reachedStart: true`, which walks the
   * panel through both halves of the behaviour — a page prepended without the
   * viewport moving, and the notice that there is nothing older — deterministically
   * and without an infinite scrollback nobody could ever reach the end of.
   */
  async feedPage(
    dwarfId: string,
    limit: number,
    before: FeedPageCursor
  ): Promise<FeedWindowRead | null> {
    if (!this.known.has(dwarfId)) return null
    const messages: FeedMessage[] = []
    for (let index = 0; index < Math.max(0, limit); index++) {
      const seed = `${dwarfId}:page:${before.text}:${index}`
      messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: hashPick(seed, FEED_LINES),
        timestamp: `sim+${String(hashInt(`${seed}:age`, 60)).padStart(2, '0')}s`
      })
    }
    return { messages, reachedStart: true }
  }

  /**
   * No file backs the feed, so there is nothing a terminal could tail. The
   * runtime treats undefined as "no transcript" and falls back to the in-panel
   * feed above, which is exactly the right outcome.
   */
  transcriptPath(_dwarfId: string): string | undefined {
    return undefined
  }

  /**
   * No channel, ever.
   *
   * A simulated dwarf has no session to type into, and the honest answer makes
   * the panel render Send and Kick disabled with a reason. Inventing a channel
   * would mean inventing a pid or a session name, and both are things the
   * delivery tier would then act on against a real process.
   */
  textDelivery(_dwarfId: string): null {
    return null
  }

  /** Whole ticks elapsed since this provider was built; never negative. */
  private tick(nowMs: number): number {
    return Math.max(0, Math.floor((nowMs - this.startedAt) / this.config.stepMs))
  }
}
