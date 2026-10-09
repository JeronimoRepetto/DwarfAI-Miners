// UI main's half of `DwarfAI-Miners --revert-integrations` (ADR-016 item 7; 13 FM-128; ISSUE-225).
// The revert needs the Host's config writer and database, and R10 keeps UI main from importing the
// Host (lead decision 2026-09-30): UI main recognises the flag and runs this build's Host from its
// versioned copy (ADR-002 D5), started as the launcher starts it (spawnHost.ts: the copy's
// executable and entry, `ELECTRON_RUN_AS_NODE=1`, `DWARFAI_HOST_DATA_DIR`, every other `DWARFAI_*`
// name removed) with the flag after the entry, waits for it to exit and answers its exit code. The
// Host's revert mode (host/wiring/revertIntegrations.ts) stops a running Host, takes the endpoint
// and reverts; this half opens no window, takes no single-instance lock and composes nothing else.
//
// - The copy is made or reused with the spawn gate held (UC-002), as before every Host start. A
//   gate another launcher holds is waited for within REVERT_GATE_BOUND_MS, polled every
//   GATE_POLL_MS; the gate is a courtesy lock, the endpoint bind stays the mutex (ADR-002 D3). The
//   gate stays held until the revert Host exited, so no launcher of this profile starts a Host
//   meanwhile.
// - Any failure — the gate never freed, no copy, a Host that could not start or ended without an
//   exit code — is REVERT_FAILED_EXIT_CODE: the uninstall goes on and the person can run the
//   command again (FM-128). Logged as `host.revert-integrations` with its code, never a path.
//
// The flag is the Host's too (host/wiring/revertIntegrations.ts): R10 keeps the two trees from
// sharing the constant, so each names it, and argv carries nothing else (NFR-SEC-05).
import type { UiLog, UiLogEntry } from '../diagnostics/uiLogger'
import type { HostCopyPreparer, HostSpawnRequest, LauncherClock, Sleep } from './ports'
import { buildHostSpawn, hostSpawnInputFromCopy, type HostSpawnInput } from './spawnHost'

/** The command-line flag (ADR-016 item 7; `20` §6). */
export const REVERT_INTEGRATIONS_FLAG = '--revert-integrations'
/** How long a spawn gate another launcher holds is waited for: the command's own 30 s bound (ADR-016 item 7). */
export const REVERT_GATE_BOUND_MS = 30_000
/** The poll of a held gate: the launcher's loser poll (ADR-002 D4 item 3). */
export const GATE_POLL_MS = 250
/** The Host copy could not run the revert (ADR-016 item 7: "a non-zero code"). */
export const REVERT_FAILED_EXIT_CODE = 1

/** Whether this process was started to revert the integrations. */
export function wantsRevertIntegrations(argv: readonly string[]): boolean {
  return argv.includes(REVERT_INTEGRATIONS_FLAG)
}

/** The Host start of spawnHost.ts with the flag after the entry. */
export function buildRevertSpawn(input: HostSpawnInput): HostSpawnRequest {
  const request = buildHostSpawn(input)
  return { ...request, args: [...request.args, REVERT_INTEGRATIONS_FLAG] }
}

/** Starts the request and settles with its exit code, or null when it never ran or ended without one. */
export type RunToExit = (request: HostSpawnRequest) => Promise<number | null>

export interface HostRevertDeps {
  gate: { take(): Promise<'taken' | 'held'>; release(): Promise<void> }
  /** The versioned copy the Host starts from (ADR-002 D5). */
  prepareCopy: HostCopyPreparer
  /** The Host as the running app holds it; started from its copy, never from here. */
  host: HostSpawnInput
  run: RunToExit
  clock: LauncherClock
  sleep: Sleep
  log: UiLog
}

export async function runHostRevertIntegrations(deps: HostRevertDeps): Promise<number> {
  const record = (entry: Omit<UiLogEntry, 'event' | 'subsystem'>): void =>
    deps.log.record({ ...entry, event: 'host.revert-integrations', subsystem: 'host-launcher' })
  const fail = (errCode: string): number => {
    record({ level: 'warn', outcome: 'failed', errCode })
    return REVERT_FAILED_EXIT_CODE
  }

  const deadline = deps.clock.now() + REVERT_GATE_BOUND_MS
  while ((await deps.gate.take()) === 'held') {
    if (deps.clock.now() >= deadline) return fail('SPAWN_GATE_HELD')
    await deps.sleep(GATE_POLL_MS)
  }
  try {
    const copy = await deps.prepareCopy()
    if (!copy.ok) return fail(copy.errCode)
    const host = hostSpawnInputFromCopy(deps.host, copy)
    if (!host.ok) return fail(host.errCode)
    const code = await deps.run(buildRevertSpawn(host.value))
    if (code === null) return fail('HOST_EXIT_UNKNOWN')
    record(
      code === 0
        ? { level: 'info', outcome: 'ok' }
        : { level: 'warn', outcome: 'failed', errCode: `HOST_EXIT_${code}` }
    )
    return code
  } finally {
    await deps.gate.release()
  }
}
