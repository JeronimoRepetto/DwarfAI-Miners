// The mines' own folder-check schedule (05 §3.1 "Folder check", AMENDMENT-2 SC-AR-04; 07 S3.12
// trigger (c), the "observation poll"; 16 §4.1 `MinesCommands.checkFolder`): every
// `MINE_FOLDER_CHECK_MS` each mine with a present dwarf has its folder checked. A mine with no
// present dwarf is not polled: resolution and the provider and driver error routes check it.
//
// - Time is the kernel `Scheduler` and nothing else: one task armed at a time, re-armed when it
//   runs, so a stopped schedule leaves nothing behind.
// - Which mines have a present dwarf is read at each tick (the crew edge, 05 §1.3; until ISSUE-094
//   the repository's join, `index.ts`).
// - A check still running from the previous tick is not doubled: `checkFolder` serializes the
//   checks of one mine and lets a further ask share the waiting one.
// - Started and stopped by `host/wiring` after boot (later: ISSUE-093).
import type { MineId } from '../../../kernel/domain/values'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { MinesCommands } from './declare'

/**
 * The architect's period of the folder check (05 §3.1), in ms. A config key: `host/wiring` passes
 * `AppConfig`'s value as `intervalMs` once the key exists (later: ISSUE-093).
 */
export const MINE_FOLDER_CHECK_MS = 30_000

export interface FolderCheckScheduleDeps {
  readonly scheduler: Scheduler
  readonly intervalMs: number
  /** The mines with at least one present dwarf, read at each tick. */
  minesWithPresentDwarfs(): readonly MineId[]
  checkFolder: MinesCommands['checkFolder']
}

export class FolderCheckSchedule {
  private task: { cancel(): void } | null = null
  /** Every check a tick started that has not answered yet. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly deps: FolderCheckScheduleDeps) {}

  /** Arms the first tick, `intervalMs` from now; a started schedule is left as it is. */
  start(): void {
    if (this.task === null) this.arm()
  }

  /** Cancels the next tick; checks already running finish on their own. */
  stop(): void {
    this.task?.cancel()
    this.task = null
  }

  /** Resolves once every check a tick started has answered (tests; the Host's drain). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  private arm(): void {
    this.task = this.deps.scheduler.after(this.deps.intervalMs, () => {
      this.task = null
      this.arm()
      this.tick()
    })
  }

  private tick(): void {
    for (const mineId of this.deps.minesWithPresentDwarfs()) {
      // A check that fails (the database, not the folder) waits for the next tick.
      const check = this.deps
        .checkFolder(mineId)
        .then(
          () => undefined,
          () => undefined
        )
        .finally(() => this.inFlight.delete(check))
      this.inFlight.add(check)
    }
  }
}
