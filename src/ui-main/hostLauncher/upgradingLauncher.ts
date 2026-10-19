// The host launcher with the ADR-002 D8 upgrade handshake after it (UC-026; 07 S12.B01–S12.B03): what HostClient's
// attach runs as its `ensureHostRunning`, so that the UI applies the D8 table to every Host it attaches to before it
// says `hello` on its own connections (composeHostClient.ts).
//
// - First the launcher of ADR-002 D4 (attach to or spawn the Host); a launch that failed is answered as it is.
// - Then the handshake (upgradeFlow.ts) on its own `ui` link, answered at its first report: `attached` and `compat` are
//   an attach (HostClient's notifier then says `hello` and is `connected`, with `compat` when the protocol versions
//   differ, S12.B01, S12.B02); `incompatible` and `generation-restart` are that `unavailable` reason (S12.B03). A
//   handshake that could not attach reports nothing and is an attach too: HostClient's own `hello` finds what holds the
//   endpoint (the hung-Host and reconnect rules of ADR-002 D9 are HostClient's).
// - The handshake goes on after its answer: in compat mode it waits for the old Host's drain (D8 items 2–3), for an
//   older UI it waits until the app's Stop everything and quit has stopped the newer Host (D8 item 5). While it runs,
//   another attach does not start a second one and is answered as the first was. When it ended with a Host to attach
//   to again (the new Host after the swap, this build's own Host after the stop-all, or a link lost without
//   `host.closing`), `reattach` is called: HostClient's `ensureHost` (S12.B07, or a new run from `connecting`).
// - `dispose` closes the links the handshake opened; nothing is reattached after it.
import type { EnsureHostResult, HostLauncher } from './launcher'
import {
  runUpgradeFlow,
  type HostAttach,
  type UpgradeFlowDeps,
  type UpgradeFlowResult,
  type UpgradeFlowState
} from './upgradeFlow'

/** What the attach answers: the launcher's result, or the D8 `unavailable` reason of S12.B03. */
export type UpgradingLaunchResult =
  EnsureHostResult | { unavailable: 'incompatible' | 'generation-restart' }

export interface UpgradingLauncher {
  ensureHostRunning(): Promise<UpgradingLaunchResult>
  dispose(): void
}

export interface UpgradingLauncherDeps {
  /** ADR-002 D4 (launcher.ts); the handshake also starts the new Host through it. */
  launcher: HostLauncher
  /** The handshake's ports but the two this module binds (`ensureHostRunning`, `report`). */
  flow: Omit<UpgradeFlowDeps, 'ensureHostRunning' | 'report'>
  /** The handshake ended with a Host to attach to again. */
  reattach(): void
}

type Verdict = 'attach' | 'incompatible' | 'generation-restart'

export function createUpgradingLauncher(deps: UpgradingLauncherDeps): UpgradingLauncher {
  let running: Promise<Verdict> | null = null
  let disposed = false
  /** The links the handshake under way opened and has not given back. */
  const links = new Set<{ close(): void }>()

  const verdictOf = (state: UpgradeFlowState): Verdict =>
    state.phase === 'incompatible' || state.phase === 'generation-restart' ? state.phase : 'attach'

  /** The handshake ended (null: it threw, and nothing it did is relied on). */
  function settled(result: UpgradeFlowResult | null): void {
    running = null
    for (const link of links) link.close()
    links.clear()
    if (disposed || result === null) return
    if (result.kind === 'swapped' || result.kind === 'own-host' || result.kind === 'lost') {
      deps.reattach()
    }
  }

  function handshake(): Promise<Verdict> {
    let answer: (verdict: Verdict) => void = () => {}
    const verdict = new Promise<Verdict>((resolve) => (answer = resolve))
    void runUpgradeFlow({
      ...deps.flow,
      attach: async (generation): Promise<HostAttach> => {
        const attached = await deps.flow.attach(generation)
        if (attached.kind === 'attached') {
          if (disposed) attached.link.close()
          else links.add(attached.link)
        }
        return attached
      },
      ensureHostRunning: () => deps.launcher.ensureHostRunning(),
      report: (state) => answer(verdictOf(state))
    }).then(
      (result) => {
        answer('attach')
        settled(result)
      },
      () => {
        answer('attach')
        settled(null)
      }
    )
    return verdict
  }

  return {
    async ensureHostRunning() {
      const launched = await deps.launcher.ensureHostRunning()
      if (typeof launched === 'object' || disposed) return launched
      running ??= handshake()
      const verdict = await running
      return verdict === 'attach' ? launched : { unavailable: verdict }
    },
    dispose() {
      disposed = true
      for (const link of links) link.close()
      links.clear()
    }
  }
}
