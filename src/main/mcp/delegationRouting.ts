import type { JevRouteLaunchResult } from '../domain/types'
import type { DelegationFailure, DelegationRouting } from './delegationProtocol'
// `delegationFailure` is a RUNTIME import — taken from the server-only twin,
// never `./delegationProtocol` directly, so this main-only module never
// pulls that file into `jevMcpServer.js`'s own build graph. See
// `delegationServerProtocol.ts`'s own top comment for the full reasoning.
import { delegationFailure } from './delegationServerProtocol'

/**
 * Turns one Jev routing call's own verdict (`jev/routeLaunch.ts`'s
 * `JevLaunchRouter.route`) into either a `DelegationRouting` to launch the
 * delegated child with, or a typed `DelegationFailure` — pure, so the many
 * ways Jev can fail to give a usable answer are provable with plain objects
 * (#511).
 *
 * A `fallback` result that still carries the person's OWN configured default
 * (`fallbackTo`) is used exactly as an ordinary launch already uses it —
 * this is not a Jev DECISION (see `AgentLaunchRequest.routedByJev`'s own
 * honesty rule in contracts.ts), but it is still a provider the person chose
 * to fall back to, so a delegated subtask may as well run there rather than
 * fail outright. This applies whatever the fallback reason is, including
 * `'low-confidence'` — a configured default always wins over failing.
 *
 * A `fallback` with no configured default is the case the feature document
 * names directly: `'low-confidence'` becomes `jev-unsure` (Jev answered but
 * was not sure enough to act on); every other fallback reason — no key, no
 * launchable provider, unreachable, timeout, rate-limited, unauthorized, an
 * unparsable response, or the request's own token budget exceeded — becomes
 * `jev-unreachable`, the one bucket for "no usable answer came back at all".
 */
export function resolveDelegationRouting(
  result: JevRouteLaunchResult
): { routing: DelegationRouting } | { failure: DelegationFailure } {
  if (result.kind === 'decision') {
    return {
      routing: {
        provider: result.provider,
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.effort === undefined ? {} : { effort: result.effort })
      }
    }
  }
  const fallbackTo = result.fallbackTo
  if (fallbackTo?.provider !== undefined) {
    return {
      routing: {
        provider: fallbackTo.provider,
        ...(fallbackTo.model === undefined ? {} : { model: fallbackTo.model }),
        ...(fallbackTo.effort === undefined ? {} : { effort: fallbackTo.effort })
      }
    }
  }
  if (result.reason === 'low-confidence') {
    return {
      failure: delegationFailure(
        'jev-unsure',
        'Jev could not route this subtask confidently, and no default is configured.'
      )
    }
  }
  return {
    failure: delegationFailure('jev-unreachable', 'Jev could not route this subtask.')
  }
}
