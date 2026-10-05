// B-M08 `attention.clicked` (14 §2.3, §3.4; ADR-018 item 6; 07 S17.06): the tray process reports a
// click on a level-3 notification by its key, handed to `AttentionInputs.clicked` (16 §4.11), a
// diagnostics counter only. The UI process reveals the chat itself (`revealDwarfChat`, UI-local);
// the Host never raises a window.
//
// - `notifier` only (roles.ts): `ui` and `viewer` get FORBIDDEN before the handler runs (ADR-003
//   item 12). The params are the contract's strict() schema (INVALID_PARAMS otherwise).
// - Not mutating: no requestId (14 §1.6); a repeat counts again, which a counter allows.
// - Logged by method name only, by the dispatcher (14 §1.10; 19 §4 `debug`); the key is never
//   logged. The composition root registers it (later: ISSUE-119).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { AttentionInputs } from '../../modules/attention'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface AttentionClickedDeps {
  attention: Pick<AttentionInputs, 'clicked'>
}

/** Serves `attention.clicked` (B-M08) on `dispatcher`. */
export function registerAttentionClicked(dispatcher: Dispatcher, deps: AttentionClickedDeps): void {
  dispatcher.register(
    'attention.clicked',
    HOST_METHOD_SCHEMAS['attention.clicked'].params,
    METHOD_ROLES['attention.clicked'] ?? [],
    (params): HostMethods['attention.clicked']['result'] => {
      deps.attention.clicked(params.key)
      return {}
    }
  )
}
