import type { SimulationConfig } from '../../config/config'
import type { FeedMessage, ProviderSnapshot } from '../../domain/types'
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
   * One of the two REAL provider identities.
   *
   * `DwarfProvider` has exactly two members, and widening it to admit a third
   * would ripple through the wire contract, the renderer's sprite art and every
   * consumer of a dwarf — turning a development-only tool into a change to the
   * product's own vocabulary. Claiming 'claude' costs nothing that matters
   * (the field is a label for logs and perf stages) and keeps the simulation
   * indistinguishable downstream, which is the entire point of #42. Individual
   * dwarfs still carry a mix of both providers, so both sprite sets are drawn.
   */
  readonly kind = 'claude' as const

  private readonly config: SimulationConfig
  private readonly now: () => number
  /** Tick 0 is the moment this provider was built, so a run always starts at the beginning. */
  private readonly startedAt: number
  private readonly mines: readonly SimulatedMine[]
  /** Ids from the latest scan, so feed() can refuse a dwarf that was never here. */
  private known = new Set<string>()

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
    this.known = new Set(snapshots.flatMap((snapshot) => snapshot.dwarfs.map((dwarf) => dwarf.id)))
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
