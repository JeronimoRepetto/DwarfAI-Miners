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
 *
 * AMENDED for #534 (was: `['claude', 'codex', 'antigravity']`, with OpenCode
 * deliberately absent per #444's own D5 — "OpenCode reads opencode.db
 * only"). D5 stood on "no launch invocation this app has measured"; #534
 * measured one — `opencode run -m <provider/model> --variant <effort>
 * --format json` with the prompt on stdin (docs/opencode-format.md) — so
 * OpenCode joins on the same DETACHED, one-shot terms Codex and Antigravity
 * already do: no held-session engine, discovered afterwards by the ordinary
 * poll off `opencode.db`. HELDABLE_PROVIDERS does not grow — no round trip
 * through a bidirectional protocol has been proven for OpenCode either.
 */
export const LAUNCHABLE_PROVIDERS: readonly DwarfProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode'
]

/**
 * What a detected provider with no launch path says for itself.
 *
 * AMENDED for #444. The previous comment (written for #237, step 4) recorded
 * this string as unreachable again — every `DWARF_PROVIDERS` member was also
 * a `LAUNCHABLE_PROVIDERS` member at the time. OpenCode ends that: it reads
 * `opencode.db` only and is never added to `LAUNCHABLE_PROVIDERS` (D5), so a
 * detected OpenCode CLI is exactly the "installed, not yet launchable" case
 * this string exists for — see
 * `launchProviders.test.ts > pins that a detected OpenCode is marked
 * installed but not launchable`. Kept in the same words either way, as
 * #168's original comment intended: honest copy waiting for whichever
 * provider can be READ but has no launch invocation yet, so the next one
 * finds it already written rather than a hole to fill under pressure.
 *
 * AMENDED for #534. OpenCode's own D5 ended too — the measured `run` route
 * (docs/opencode-format.md) joined it to `LAUNCHABLE_PROVIDERS` above, so
 * this string is unreachable again: every `DWARF_PROVIDERS` member is also
 * a `LAUNCHABLE_PROVIDERS` member once more, exactly the state this
 * comment's own #444 paragraph describes ending and then re-entered. Kept
 * in the same words regardless, for the same reason: honest copy waiting
 * for whichever provider arrives next with a store this app can read but
 * no launch invocation yet.
 *
 * Fixed copy this app wrote, which is the whole reason it is safe to publish:
 * the detector's own reasons name `~/.local/bin` and, for a configured
 * override, a path verbatim. Those are this machine's filesystem and they stop
 * at the wire (docs/privacy.md, #59) — the panel never needs them, because the
 * only thing it can act on is that the launch is not built.
 */
export const NOT_LAUNCHABLE = 'That agent cannot be started from the panel yet.'

/**
 * What each CLI is called when the panel has to name it.
 *
 * Per provider rather than one string, because these are the sentences a user
 * acts on: "Claude Code is not installed" shown for a Codex chip would send
 * somebody to install the wrong program at the one moment the message was
 * supposed to help (#168).
 *
 * Moved here from launchRunner.ts for #237, step 5, unchanged. It had two
 * readers by then — the detached engine and the held registry, which could
 * only ever say "Claude Code" before a second provider could be held — and a
 * second copy is how the same missing CLI comes to be named two ways. `domain/`
 * because it is a table about providers and nothing else, with no `node:`
 * import behind it.
 */
export const PRODUCT_NAME: Readonly<Record<DwarfProvider, string>> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  // Reachable since #237 step 4: a detached Antigravity launch runs through
  // the same engine, and a refusal — not installed, could not be started —
  // must name the product, not its `agy` executable.
  antigravity: 'Antigravity CLI',
  // AMENDED for #534 (was: "Observed only — this name reaches the panel
  // through NOT_LAUNCHABLE and nothing else, since OpenCode never reaches a
  // launch attempt" — #444's own claim, made false by the measured `run`
  // route joining OpenCode to LAUNCHABLE_PROVIDERS). Reachable the same way
  // Claude's, Codex's and Antigravity's own names above are: a missing
  // CLI's refusal (notInstalledReason) and a spawn failure's (couldNotStart,
  // launchRunner.ts) both name it.
  opencode: 'OpenCode'
}

/** That name inside the one sentence both launch engines say about a missing CLI. */
export function notInstalledReason(provider: DwarfProvider): string {
  return `${PRODUCT_NAME[provider]} is not installed on this machine.`
}

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
