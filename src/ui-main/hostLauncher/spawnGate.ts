// The spawn gate (ADR-002 D3; 07 S12.01; 13 FM-010): `<hostDataDir>/run/spawn.gate`, so that two
// UIs (an old window dying, a new one starting) never spawn two Hosts at once.
//
// - take: exclusive-create the gate with `{pid, processStartTimeMs, at}` of this UI. When a gate
//   exists, read it and apply the takeover table: it is taken over only if its owner's identity no
//   longer matches a live process or it is older than HOST_SPAWN_GATE_STALE_MS. A gate whose
//   content is not a record (a file another tool wrote, a torn write) has no owner to wait for and
//   is stale. Takeover removes exactly the gate that was judged (removeIf), then creates ours; if
//   another UI was faster, the gate is held.
// - release: removes the gate only while it is still ours.
//
// The gate is the courtesy lock; the Host's endpoint bind stays the real mutex (ADR-002 D3), so a
// lost race costs at most one extra Host that exits ALREADY_RUNNING.
import type { GateFiles, LauncherClock, ProcessIdentityProbe, ProcessStart } from './ports'

/** ADR-002 D3 (HO-03): a gate older than this is stale whoever owns it. */
export const HOST_SPAWN_GATE_STALE_MS = 60_000

export interface GateRecord extends ProcessStart {
  /** When the gate was taken, epoch ms. */
  at: number
}

export interface GateOwnerFacts {
  /** Whether the owner's `(pid, processStartTimeMs)` still matches a live process. */
  ownerAlive: boolean
  /** How long ago the gate was taken (negative when it was stamped in the future). */
  ageMs: number
}

/** The ADR-002 D3 takeover table. */
export function shouldTakeOver(facts: GateOwnerFacts): boolean {
  return !facts.ownerAlive || facts.ageMs > HOST_SPAWN_GATE_STALE_MS
}

export interface SpawnGateDeps {
  files: GateFiles
  probe: ProcessIdentityProbe
  clock: LauncherClock
  /** This UI process's identity, written into the gate it takes. */
  self: () => Promise<ProcessStart>
}

/** One takeover attempt is enough: a second loss means another UI holds a fresh gate. */
const TAKE_ATTEMPTS = 2

export class SpawnGate {
  /** The content of the gate this instance holds, or null. */
  private mine: string | null = null

  constructor(private readonly deps: SpawnGateDeps) {}

  async take(): Promise<'taken' | 'held'> {
    const self = await this.deps.self()
    for (let attempt = 0; attempt < TAKE_ATTEMPTS; attempt += 1) {
      const content = JSON.stringify({ ...self, at: this.deps.clock.now() } satisfies GateRecord)
      if ((await this.deps.files.create(content)) === 'created') {
        this.mine = content
        return 'taken'
      }
      const existing = await this.deps.files.read()
      if (existing === null) continue // released meanwhile: try again
      if (!(await this.isStale(existing))) return 'held'
      await this.deps.files.removeIf(existing)
    }
    return 'held'
  }

  async release(): Promise<void> {
    const mine = this.mine
    if (mine === null) return
    this.mine = null
    await this.deps.files.removeIf(mine)
  }

  private async isStale(content: string): Promise<boolean> {
    const record = parseGateRecord(content)
    if (record === null) return true
    const ownerAlive = await this.deps.probe({
      pid: record.pid,
      processStartTimeMs: record.processStartTimeMs
    })
    return shouldTakeOver({ ownerAlive, ageMs: this.deps.clock.now() - record.at })
  }
}

function parseGateRecord(content: string): GateRecord | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { pid, processStartTimeMs, at } = value as Record<string, unknown>
  if (!isCount(pid) || !isCount(processStartTimeMs) || !isCount(at)) return null
  return { pid, processStartTimeMs, at }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
