// UI main's Host attach as the composition root wires it (ISSUE-051; ADR-002 D4, D8, D9): HostClient over the host
// launcher with the ADR-002 D8 upgrade handshake after it (hostLauncher/upgradingLauncher.ts, upgradeFlow.ts), so
// every Host the app attaches to — at start, after a respawn, after the person's retry — is first held to the D8
// table (UC-026):
//
// - the same `protocolVersion` attaches normally (S12.B01);
// - an older Host is attached in compat mode and asked to upgrade to this build's versioned copy; once it drained and
//   closed with `host.closing {reason:'upgrade'}`, the new Host is started and the client attaches again (S12.B02,
//   S12.13…S12.16): DwarfAI's own stop, never a lost connection, so no PO #62 toast;
// - a newer Host is `unavailable {reason:'incompatible'}` and is never asked to upgrade (D8 item 5, IR-21-08). The
//   Host-state message offers only Stop everything and quit, which the app's own flow runs (A-N34 → A-N26 through
//   LegacyEndFirstAdapter); once that Host closed, this build's Host is started and the client attaches to it. The
//   client held no notifier on the newer Host, so its `host.closing {stop-all}` never reaches the tray process: the
//   app does not quit, it starts its own Host (21 §2.1 item 3);
// - a Host of another generation is `unavailable {reason:'generation-restart'}` (D8 item 4). Dormant in v1, where
//   generation 1 is the only one and A-N33 `confirmHostRestart` is not routed: the notice is never confirmed, so
//   nothing is sent and the Host keeps its sessions (S12.B16 guard).
//
// Disposing the client also closes the handshake's links (HostClient disposes its launcher).
import { randomBytes } from 'node:crypto'
import type { HostLauncher } from '../hostLauncher/launcher'
import type { UpgradeFlowDeps } from '../hostLauncher/upgradeFlow'
import { createUpgradingLauncher } from '../hostLauncher/upgradingLauncher'
import { createHostClient, type HostClientDeps, type HostClientService } from './HostClient'
import { mintRequestId } from './requestIds'

/** The one `endpointGeneration` of v1 (ADR-003 item 5; `hello`'s literal). */
const ENDPOINT_GENERATION = 1

export interface ComposeHostClientDeps extends Omit<HostClientDeps, 'launcher'> {
  /** ADR-002 D4 (hostLauncher/launcher.ts). */
  launcher: HostLauncher
  /** The handshake's `ui` link to the running Host and this UI's versioned copy (createNodeUpgradePorts). */
  upgrade: Pick<UpgradeFlowDeps, 'attach' | 'prepareTarget'>
  /** A UUIDv7 per intent (14 §1.6), for `host.upgrade.request`; default minted from the client's clock. */
  newRequestId?(): string
}

export function composeHostClient(deps: ComposeHostClientDeps): HostClientService {
  const {
    launcher,
    upgrade,
    newRequestId = () => mintRequestId({ now: deps.timers.now, random: (n) => randomBytes(n) }),
    ...clientDeps
  } = deps
  let client: HostClientService | null = null
  const upgrading = createUpgradingLauncher({
    launcher,
    flow: {
      build: {
        protocolVersion: deps.protocolVersion,
        endpointGeneration: ENDPOINT_GENERATION,
        appVersion: deps.client.appVersion
      },
      attach: upgrade.attach,
      prepareTarget: upgrade.prepareTarget,
      // Dormant in v1 (above): the blocking notice is never confirmed.
      confirm: () => Promise.resolve(false),
      newRequestId,
      log: deps.log
    },
    reattach: () => void client?.ensureHost()
  })
  client = createHostClient({ ...clientDeps, launcher: upgrading })
  return client
}
