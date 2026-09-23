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
}

/** Build the in-process link a held session's SDK tools call (#511 M1a). */
export function createDirectDelegationLink(options: DirectDelegationLinkOptions): DelegationLink {
  const { delegate, result, now, sleep } = options

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
