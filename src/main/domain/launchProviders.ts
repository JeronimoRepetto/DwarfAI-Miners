import { DWARF_PROVIDERS, type AgentProviderList, type DwarfProvider } from './types'

/**
 * Which providers the Add Panel may offer, and which of them a launch can
 * actually be started for (#86).
 *
 * Two different questions, deliberately answered side by side. "Installed" is
 * detection's (#91): is this CLI on this machine at all. "Launchable" is this
 * app's: does the launch path it would go down exist yet. A chip drawn from the
 * first alone would promise something the second cannot keep.
 *
 * Pure, and structurally typed on its input, so it never reaches into
 * `platform/` from `domain/` — the detector's verdict satisfies `CliPresence`
 * without this module knowing what produced it.
 */

/** The shape of a detection verdict this reads. Satisfied by CliDetection (#91). */
export interface CliPresence {
  cli: DwarfProvider
  installed: boolean
  /** Detection's own explanation. Read here, and deliberately never published. */
  reason?: string
}

/**
 * The providers a launch can be started for today.
 *
 * Claude and nothing else, because both launch paths resolve exactly one CLI:
 * `HeldSessionRegistry.launch` detects `'claude'`, and so does
 * `launchClaudeSession`. Widening this is widening THEM — it is not a list to
 * grow on its own, and a second name here would be a chip that answers Enter
 * with a session nobody starts.
 */
export const LAUNCHABLE_PROVIDERS: readonly DwarfProvider[] = ['claude']

/**
 * What a detected provider with no launch path says for itself.
 *
 * Fixed copy this app wrote, which is the whole reason it is safe to publish:
 * the detector's own reasons name `~/.local/bin` and, for a configured
 * override, a path verbatim. Those are this machine's filesystem and they stop
 * at the wire (docs/privacy.md, #59) — the panel never needs them, because the
 * only thing it can act on is that the launch is not built.
 */
export const NOT_LAUNCHABLE = 'Only Claude can be started from the panel today.'

/**
 * Every known provider, in the contract's own order.
 *
 * Ordered by `DWARF_PROVIDERS` rather than by whatever order the detections
 * arrived in, so the chips keep their places across refreshes; a row that
 * reshuffled under the pointer would be its own bug. A provider with no
 * detection at all is reported absent rather than dropped — a silent omission
 * looks identical to "you have no agents", which is detection's own stated
 * fail-safe.
 */
export function agentProviderList(detections: readonly CliPresence[]): AgentProviderList {
  return {
    providers: DWARF_PROVIDERS.map((provider) => {
      const installed = detections.some((entry) => entry.cli === provider && entry.installed)
      const launchable = installed && LAUNCHABLE_PROVIDERS.includes(provider)
      return {
        provider,
        installed,
        launchable,
        // An absent CLI needs no refusal copy: it is not offered as a chip at
        // all, and saying "only Claude can start" about a Claude nobody has
        // would answer a question the panel is not asking.
        ...(installed && !launchable ? { reason: NOT_LAUNCHABLE } : {})
      }
    })
  }
}
