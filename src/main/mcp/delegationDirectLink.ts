import type {
  DelegationFailure,
  DelegationRouting,
  DelegationToolResult,
  ResultBody
} from './delegationProtocol'
import type { DelegationLink } from './delegationLink'

/**
 * The in-process twin of `delegationLink.ts`'s own loopback client (#511
 * M1a) — same `DelegationLink` surface (`delegate`/`result`, same poll
 * shape), but calling `DelegationService.delegateDirect`/`resultDirect`
 * directly rather than `fetch`ing a loopback endpoint with a token. Built
 * FOR a held Claude session specifically: `AgentRuntime.resolveHeldDelegationInjection`
 * closes this over the token it minted (kept only as an internal
 * correlation key, never handed to any child process) and hands the result
 * to `delegationHeldServer.ts`'s SDK in-process tools.
 *
 * A deliberate small duplication of `createDelegationLink`'s own poll loop,
 * not a shared import of it: `delegationLink.ts` is a runtime dependency of
 * `jevMcpServer.js`'s own build graph (it is what the STANDALONE stdio
 * server, used by a detached `claude -p`/OpenCode launch, talks through),
 * and `delegationProtocol.ts` — which `delegationLink.ts` imports at
 * runtime — must never become a dependency of BOTH `index.js` and
 * `jevMcpServer.js` (the exact regression `delegationServerProtocol.ts`'s
 * own top comment documents fixing twice already). Only the TYPE
 * `DelegationLink` crosses here (`import type`, fully erased), so this
 * module stays main-graph-only.
 */

export const DIRECT_DELEGATION_POLL_INTERVAL_MS = 1_000

export interface DirectDelegationLinkOptions {
  /** `DelegationService.delegateDirect` bound to this launch's own token. */
  delegate: (
    task: string,
    context: string | undefined
  ) => Promise<{ ticket: string; routing: DelegationRouting } | { failure: DelegationFailure }>
  /** `DelegationService.resultDirect` bound to this launch's own token. */
  result: (ticket: string) => ResultBody
  /** Wall-clock reading, injected so the poll deadline is provable with no real timers. */
  now: () => number
  /** Injected so a test drives every poll tick deterministically. */
  sleep: (ms: number) => Promise<void>
  /**
   * Told once this wait's own deadline elapses with nothing settled (#601) —
   * the other half of the settle race `DelegationService.maybePush` closes
   * (see that method's own comment): a ticket can settle between this wait's
   * last poll and the moment it gives up, and without this signal a settle
   * landing in that gap would never learn the wait is no longer there to
   * hand the answer back on its own. Never called when a poll DOES find a
   * settled state — that answer already reached the parent through the
   * ordinary `delegate_subtask` return value, so no second delivery path is
   * needed for it. Absent for the standalone `result()` call `subtask_result`
   * makes, which is not a wait at all.
   */
  onWaitEnded?: (ticket: string) => void
}

/** Build the in-process link a held session's SDK tools call (#511 M1a). */
export function createDirectDelegationLink(options: DirectDelegationLinkOptions): DelegationLink {
  const { delegate, result, now, sleep, onWaitEnded } = options

  async function pollUntil(
    ticket: string,
    routing: DelegationRouting,
    waitMs: number
  ): Promise<DelegationToolResult> {
    const deadline = now() + waitMs
    while (now() < deadline) {
      await sleep(DIRECT_DELEGATION_POLL_INTERVAL_MS)
      const polled = result(ticket)
      if (polled.status !== 'pending') return polled
    }
    onWaitEnded?.(ticket)
    return { status: 'pending', ticket, routing }
  }

  return {
    async delegate(
      task: string,
      context: string | undefined,
      delegateOptions: { waitMs: number }
    ): Promise<DelegationToolResult> {
      const outcome = await delegate(task, context)
      if ('failure' in outcome) return { status: 'failed', failure: outcome.failure }
      return pollUntil(outcome.ticket, outcome.routing, delegateOptions.waitMs)
    },
    async result(ticket: string): Promise<DelegationToolResult> {
      const polled = result(ticket)
      return polled.status === 'pending'
        ? { status: 'pending', ticket, routing: polled.routing }
        : polled
    }
  }
}
