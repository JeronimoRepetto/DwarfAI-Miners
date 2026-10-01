// Stop everything and quit, UI main's half (07 S10.18…S10.21; ADR-002 D7 steps 1–4; 14 §6.3; UC-023):
//
// 1. `request` (the tray's secondary action, or the window's where no tray exists, FM-050) runs on
//    `HostClient.withUiConnection`: the window's `ui` connection, or a short-lived one when no window holds one; the
//    `notifier` connection stays mutation-free (ADR-003 item 12). It reads the owned-session count from
//    `session.snapshot` (`dwarfs`, `owned` only: the Host-owned count, 14 §2.2 A-N25 Notes; the sessions the legacy
//    runtime launched are not in it, accepted difference OQ-78), opens a window per "Mode at launch" when none is
//    open, and pushes A-N25 `{ confirmationId }` to the confirmation surface. The renderer shows the count from its
//    own read model, which follows live frames.
// 2. `cancel` (A-N27) ends the confirmation: nothing is sent, the short-lived connection closes (S10.19).
// 3. `confirm` (A-N26) relays `host.shutdown {mode:'stop-all', requestId}` on that same `ui` connection and answers
//    the `StopAllOutcome` (S10.20). The relay is a seam: through cut 4 `LegacyEndFirstAdapter` (ISSUE-054) wraps it to
//    end the legacy-launched sessions first.
// 4. The process never exits on the outcome: it exits only when the Host closes with the clean-shutdown marker
//    (`host.closing {reason:'stop-all'}`, handled by the tray process, trayMenu.ts). With `failed ≠ []` the Host keeps
//    running (INV-121) and so does this process: windows, the `notifier` connection and the icon stay, a window
//    opens per "Mode at launch" if none is open, and the renderer shows the one danger message from the answer
//    (S10.21; ADR-014 item 9: no per-dwarf toast).
//
// A new request while a confirmation is open replaces it (the older one is cancelled); a Confirm or Cancel that names
// no open confirmation reaches nothing (A-N26 answers INVALID_PARAMS).
import type {
  ChannelKey,
  DwarfWire,
  HostResult,
  IpcError,
  IpcResult,
  SnapshotPage,
  StopAllOutcome
} from '@dwarfai/contracts'
import type { HostClient } from '../ports/hostClient'

/** A-N25 `onStopEverythingRequested` (14 §2.2). */
export const STOP_EVERYTHING_REQUESTED = 'tray:stopEverything:requested' satisfies ChannelKey

/**
 * How A-N26 reaches the Host: `shutdown(requestId)` sends `host.shutdown {mode:'stop-all', requestId}` on the
 * confirmation's `ui` connection and answers its outcome. The default relays at once; `LegacyEndFirstAdapter`
 * (ISSUE-054) ends the legacy-launched sessions first and relays only when every one of them ended.
 */
export type StopAllRelay = (
  requestId: string,
  shutdown: (requestId: string) => Promise<StopAllOutcome>
) => Promise<StopAllOutcome>

/** The mode windows as the confirmation flow uses them; bound by the composition root to the window module. */
export interface StopEverythingWindows {
  /** Whether a window is open (a hidden or minimized one counts, ADR-018 D2). */
  anyOpen(): boolean
  /** Opens the app per "Mode at launch", or shows the open window. */
  open(): void
  /** Pushes a 14 §2.2 M→R member to the shown mode window (the confirmation surface). */
  push(channel: ChannelKey, payload: unknown): void
}

export interface StopEverythingDeps {
  host: Pick<HostClient, 'withUiConnection'>
  windows: StopEverythingWindows
  /** A new confirmation id (a UUID, the A-N25 schema). */
  newConfirmationId(): string
  relay?: StopAllRelay
}

/** The confirmation open now. */
export interface PendingConfirmation {
  confirmationId: string
  /** The Host-owned sessions alive when the confirmation was asked for (S10.18). */
  ownedCount: number
}

export interface StopEverything {
  /** S10.18: asks for the confirmation; settles once it was pushed, or nothing could be asked. */
  request(): Promise<void>
  /** A-N26 (S10.20, S10.21). */
  confirm(p: { confirmationId: string; requestId: string }): Promise<IpcResult<StopAllOutcome>>
  /** A-N27 (S10.19). */
  cancel(p: { confirmationId: string }): void
  pending(): PendingConfirmation | null
}

type Decision = { kind: 'cancel' } | { kind: 'confirm'; requestId: string }

interface Open extends PendingConfirmation {
  decide(d: Decision): void
  /** Whether Confirm was chosen (a second Confirm gets the same answer, a later Cancel changes nothing). */
  confirmed: boolean
  /** What A-N26 answers once the relay settled. */
  answered: Promise<IpcResult<StopAllOutcome>>
}

const relayAtOnce: StopAllRelay = (requestId, shutdown) => shutdown(requestId)

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : { code: 'INTERNAL', message: 'the stop-all relay failed', retryable: false }
}

const noOpenConfirmation = (): IpcResult<StopAllOutcome> => ({
  ok: false,
  error: { code: 'INVALID_PARAMS', message: 'no such confirmation is open', retryable: false }
})

/** The owned dwarfs of every page of a `dwarfs` snapshot (14 §4; DwarfWire.owned). */
async function ownedCount(c: Pick<HostClient, 'snapshot'>): Promise<number> {
  const count = (page: SnapshotPage): number =>
    page.chunks
      .flatMap((chunk) => (chunk.section === 'dwarfs' ? (chunk.data as DwarfWire[]) : []))
      .filter((d) => d.owned).length
  let page = await c.snapshot({ sections: ['dwarfs'] })
  let owned = count(page)
  while (page.next !== undefined) {
    page = await c.snapshot({ snapshotId: page.snapshotId, cursor: page.next })
    owned += count(page)
  }
  return owned
}

function outcomeOf(result: HostResult['host.shutdown']): StopAllOutcome {
  if (result.mode !== 'stop-all') throw new Error(`host.shutdown answered mode ${result.mode}`)
  return result.outcome
}

export function createStopEverything(deps: StopEverythingDeps): StopEverything {
  const { host, windows, newConfirmationId, relay = relayAtOnce } = deps
  let open: Open | null = null

  function close(confirmation: Open): void {
    if (open === confirmation) open = null
  }

  async function run(c: Pick<HostClient, 'call' | 'snapshot'>, asked: () => void): Promise<void> {
    const owned = await ownedCount(c)
    let decide: (d: Decision) => void = () => {}
    const decided = new Promise<Decision>((resolve) => (decide = resolve))
    let settle: (answer: IpcResult<StopAllOutcome>) => void = () => {}
    const answered = new Promise<IpcResult<StopAllOutcome>>((resolve) => (settle = resolve))
    open?.decide({ kind: 'cancel' })
    const confirmation: Open = {
      confirmationId: newConfirmationId(),
      ownedCount: owned,
      decide,
      confirmed: false,
      answered
    }
    open = confirmation
    if (!windows.anyOpen()) windows.open()
    windows.push(STOP_EVERYTHING_REQUESTED, { confirmationId: confirmation.confirmationId })
    asked()

    const decision = await decided
    if (decision.kind === 'cancel') {
      close(confirmation)
      return
    }
    try {
      const outcome = await relay(decision.requestId, async (requestId) =>
        outcomeOf(await c.call('host.shutdown', { mode: 'stop-all', requestId }))
      )
      // Some owned session could not be ended: the Host keeps running and so does this process; the answer is
      // shown in a window (S10.21).
      if (outcome.failed.length > 0 && !windows.anyOpen()) windows.open()
      settle({ ok: true, value: outcome })
    } catch (error) {
      settle({ ok: false, error: ipcErrorOf(error) })
    } finally {
      close(confirmation)
    }
  }

  return {
    request() {
      return new Promise<void>((asked) => {
        host
          .withUiConnection((c) => run(c, asked))
          .then(
            () => asked(),
            // No ui connection could be opened or the count could not be read: nothing is asked for (S10.18 guard:
            // Host connected), and nothing changes.
            () => asked()
          )
      })
    },

    confirm({ confirmationId, requestId }) {
      const confirmation = open
      if (confirmation === null || confirmation.confirmationId !== confirmationId) {
        return Promise.resolve(noOpenConfirmation())
      }
      if (!confirmation.confirmed) {
        confirmation.confirmed = true
        confirmation.decide({ kind: 'confirm', requestId })
      }
      return confirmation.answered
    },

    cancel({ confirmationId }) {
      const confirmation = open
      if (confirmation === null || confirmation.confirmationId !== confirmationId) return
      if (confirmation.confirmed) return // Confirm was chosen already; its relay runs to its end
      close(confirmation)
      confirmation.decide({ kind: 'cancel' })
    },

    pending() {
      return open === null
        ? null
        : { confirmationId: open.confirmationId, ownedCount: open.ownedCount }
    }
  }
}
