// The ActivityLog double (16 §4.6, §2.8). Never imported by production code (R14). It lives in
// `testing/`, not `ports/fakes/`: it imports values (the invariant error, the cap), and `ports/` is
// type-only (05 R2) — the `InMemoryMessageLog` precedent.
//
// The same rules as `SqliteActivityLog`: a save inserts the run or updates it in place under its
// id (the dwarf, the key and the opening instant kept); a second open run of a dwarf, or a second
// run under the same `(dwarfId, turnKey)`, is refused like `activity_disclosures_one_open` and the
// UNIQUE of 09 §4.4; then the dwarf's newest `ACTIVITY_RUNS_PER_DWARF` runs stay, the open one
// ranked first (09 §5.2 step 4). An outcome line is kept per dwarf, a save replacing the previous
// one (09 §4.4). Every call runs only inside the caller's transaction; a test's transaction rolls it
// back with `snapshot` / `restore`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine } from '../domain/outcomeLine'
import { ACTIVITY_RUNS_PER_DWARF } from '../domain/retention'
import type { ActivityLog } from '../ports/activityLog'

export interface InMemoryActivityLogDeps {
  /** The caller's transaction probe (16 §2.2). */
  scope: TransactionScope
}

/** What the store holds: the runs and each dwarf's outcome line. */
export interface ActivityStore {
  runs: ActivityDisclosure[]
  outcomes: Map<DwarfId, OutcomeLine>
}

export class InMemoryActivityLog implements ActivityLog {
  /** The stored runs and lines, shared with every store `reopen` returns. */
  private readonly box: ActivityStore

  constructor(
    private readonly deps: InMemoryActivityLogDeps,
    box: ActivityStore = { runs: [], outcomes: new Map() }
  ) {
    this.box = box
  }

  /** A new store over the same stored runs: what a Host restart opens. */
  reopen(): InMemoryActivityLog {
    return new InMemoryActivityLog(this.deps, this.box)
  }

  saveDisclosure(d: ActivityDisclosure): void {
    this.inTransaction('saveDisclosure')
    const at = this.box.runs.findIndex((r) => r.id === d.id)
    const saved: ActivityDisclosure =
      at === -1
        ? structuredClone(d)
        : {
            ...structuredClone(d),
            dwarfId: this.box.runs[at]!.dwarfId,
            turnKey: this.box.runs[at]!.turnKey,
            openedAt: this.box.runs[at]!.openedAt
          }
    const others = this.box.runs.filter((r) => r.id !== d.id)
    if (saved.open && others.some((r) => r.dwarfId === saved.dwarfId && r.open)) {
      throw new HostInvariantError('a second open activity run for the dwarf (INV-66)')
    }
    if (others.some((r) => r.dwarfId === saved.dwarfId && r.turnKey === saved.turnKey)) {
      throw new HostInvariantError('a second activity run under the same (dwarf_id, turn_key)')
    }
    if (at === -1) this.box.runs.push(saved)
    else this.box.runs[at] = saved
    this.trim(saved.dwarfId)
  }

  saveOutcome(o: OutcomeLine): void {
    this.inTransaction('saveOutcome')
    this.box.outcomes.set(o.dwarfId, structuredClone(o))
  }

  outcomeOf(dwarfId: DwarfId): OutcomeLine | null {
    this.inTransaction('outcomeOf')
    return this.outcome(dwarfId)
  }

  /** The dwarf's stored outcome line, or null: the test probe, outside any transaction. */
  outcome(dwarfId: DwarfId): OutcomeLine | null {
    const line = this.box.outcomes.get(dwarfId)
    return line === undefined ? null : structuredClone(line)
  }

  openRun(dwarfId: DwarfId): ActivityDisclosure | null {
    this.inTransaction('openRun')
    const run = this.box.runs.find((r) => r.dwarfId === dwarfId && r.open)
    return run === undefined ? null : structuredClone(run)
  }

  /** Every stored run of the dwarf, by `openedAt` then id. */
  runs(dwarfId: DwarfId): ActivityDisclosure[] {
    return structuredClone(
      this.box.runs
        .filter((r) => r.dwarfId === dwarfId)
        .sort((a, b) => a.openedAt - b.openedAt || compareIds(a.id, b.id))
    )
  }

  /** Test seam for the Reset step double (09 §7.2): every run, open ones included, and every line go. */
  clearAll(): void {
    this.inTransaction('clearAll')
    this.box.runs = []
    this.box.outcomes = new Map()
  }

  snapshot(): ActivityStore {
    return structuredClone(this.box)
  }

  restore(snapshot: ActivityStore): void {
    const copy = structuredClone(snapshot)
    this.box.runs = copy.runs
    this.box.outcomes = copy.outcomes
  }

  /** 09 §5.2 step 4: `ORDER BY open DESC, opened_at DESC, id DESC LIMIT 50`, closed runs only go. */
  private trim(dwarfId: DwarfId): void {
    const kept = new Set(
      this.box.runs
        .filter((r) => r.dwarfId === dwarfId)
        .sort(
          (a, b) =>
            Number(b.open) - Number(a.open) || b.openedAt - a.openedAt || compareIds(b.id, a.id)
        )
        .slice(0, ACTIVITY_RUNS_PER_DWARF)
        .map((r) => r.id)
    )
    this.box.runs = this.box.runs.filter((r) => r.dwarfId !== dwarfId || r.open || kept.has(r.id))
  }

  private inTransaction(member: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `ActivityLog.${member} runs inside the caller transaction (16 §2.2)`
      )
    }
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
