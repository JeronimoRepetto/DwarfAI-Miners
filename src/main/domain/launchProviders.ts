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
 * The providers a launch can be started for.
 *
 * The rule this list is under has not changed, only its contents (#168):
 * widening it is widening the ENGINE, never the other way round. A name here
 * that no launch path answers is a chip that responds to Enter with a session
 * nobody starts.
 *
 * Both names earn their place differently, and the difference is real rather
 * than cosmetic. Claude can be HELD — an Agent SDK stream the panel keeps, so
 * its words reach a MessagePanel live. Codex can only be DETACHED: it has no
 * held-session engine in this app, so `codex exec` is started in the mine's
 * folder and let go of, and its dwarf arrives when the poll reads Codex's own
 * rollout storage. Both are launches; only one can be watched. `launchable`
 * answers the first question and deliberately not the second — what the panel
 * does with each is the renderer's, and it is where that difference is drawn.
 *
 * AMENDED for #237, step 4 (was: `['claude', 'codex']`, with Antigravity
 * deliberately absent because the observer slice had proven no `agy`
 * invocation). It has one now — see `buildAntigravityLaunchArgs` in
 * launch.ts for the verified argv — so a chip for it answers Enter with a
 * real, DETACHED, one-shot session, discovered afterwards by the ordinary
 * poll exactly as a detached Codex launch is. That is a different claim from
 * membership in `HELDABLE_PROVIDERS` (shared/contracts.ts): this list says a
 * launch can be STARTED, that one says it can be WATCHED, and Antigravity
 * stays out of the second — no round trip through its documented
 * stream-json protocol has been proven by this app.
 */
export const LAUNCHABLE_PROVIDERS: readonly DwarfProvider[] = ['claude', 'codex', 'antigravity']

/**
 * What a detected provider with no launch path says for itself.
 *
 * AMENDED for #237, step 4. This comment used to record the one case this
 * constant had been reached for: an installed Antigravity, detected but not
 * yet launchable. That case is gone now that every `DWARF_PROVIDERS` member
 * is also a `LAUNCHABLE_PROVIDERS` member — so this string is, once again,
 * unreachable through any real provider in this build. It is kept exactly
 * as #168's own original comment kept it: for the next provider that can be
 * READ but has no launch invocation yet, so a detected-but-unlaunchable CLI
 * always has honest copy waiting rather than a hole that needs filling under
 * pressure.
 *
 * Fixed copy this app wrote, which is the whole reason it is safe to publish:
 * the detector's own reasons name `~/.local/bin` and, for a configured
 * override, a path verbatim. Those are this machine's filesystem and they stop
 * at the wire (docs/privacy.md, #59) — the panel never needs them, because the
 * only thing it can act on is that the launch is not built.
 */
export const NOT_LAUNCHABLE = 'That agent cannot be started from the panel yet.'

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
