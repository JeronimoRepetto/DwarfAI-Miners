import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * What a per-launch delegation token identifies about its own parent (#511):
 * just enough for the delegation service to launch a child into the SAME
 * mine — `mineId` rather than a raw path, so it can be handed straight to
 * `AgentRuntime.launchAgent` (`AgentLaunchRequest.mineId`) exactly as any
 * other launch already is, with no second folder-resolution step of this
 * service's own. Nothing else: this is a port T4 calls, and every field it
 * grows is a field T4 must supply.
 */
export interface DelegationParentContext {
  /** The mine the parent launch itself started in. */
  mineId: string
  /**
   * True only for a token minted for a HELD launch's own in-process
   * delegation tools (#601, `resolveHeldDelegationInjection` in runtime.ts)
   * — absent (never `false`) for a detached `-p`/OpenCode/Codex launch, the
   * same "absent means not" terms this app's other launch-time facts use
   * (`HeldRecord.routedByJev`, above, is the same shape for a different
   * fact). `mineId` alone cannot tell the two apart: both launch kinds mint
   * a token through the SAME `issueLaunchToken`, naming the SAME identifier.
   * Read only by `DelegationService`'s own held-parent push decision
   * (#601's own `maybePush`) — a detached parent's own delivery stays
   * exactly what it was (#602's own scope line), and this is the one field
   * that keeps a settled ticket's push from ever being attempted for one.
   */
  held?: true
}

export interface DelegationTokenRegistryOptions {
  /**
   * Injected in tests; defaults to 16 cryptographically random bytes as hex
   * — the same shape `hookToken.ts`'s own `generateToken` uses, declared
   * independently here rather than imported: `mcp/` and `hooks/` are
   * separate subjects, each reaching main over its own listener (see
   * `delegationProtocol.ts`'s own comment on `DELEGATION_TOKEN_HEADER` for
   * the same reasoning applied to a wire constant).
   */
  generateToken?: () => string
}

function defaultGenerateToken(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Constant-time comparison against ONE candidate token — mirrors
 * `hookToken.ts`'s own `tokensMatch` exactly (length checked first, since
 * `timingSafeEqual` throws on a length mismatch rather than answering
 * false), declared independently rather than imported: `mcp/` and `hooks/`
 * are separate subjects, each reaching main over its own listener (see
 * `generateToken`'s own comment above for the identical reasoning already
 * established in this file).
 */
function tokensMatch(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const presentedBytes = Buffer.from(presented, 'utf8')
  if (expectedBytes.length !== presentedBytes.length) return false
  return timingSafeEqual(expectedBytes, presentedBytes)
}

/**
 * One token per parent launch (#511), minted by T4's injection adapters
 * through `DelegationService.issueLaunchToken` and presented on every
 * `x-dwarfai-token` request that launch's own MCP server makes. Pure
 * bookkeeping — no HTTP, no process, so it is provable with plain strings.
 *
 * Depth 1 is enforced structurally, not by anything in here: a child THIS
 * service launches is never issued a token of its own — only T4's injection
 * adapters call `issue`, and only for a launch the gate in
 * `delegationGate.ts` actually allows. A delegated child's own launch
 * request never sets `routedByJev`, so it can never pass that gate even once
 * T4 wires it in. This registry has no notion of depth; it only ever answers
 * "whose launch is this token."
 */
export class DelegationTokenRegistry {
  private readonly generateToken: () => string
  private readonly contexts = new Map<string, DelegationParentContext>()

  constructor(options: DelegationTokenRegistryOptions = {}) {
    this.generateToken = options.generateToken ?? defaultGenerateToken
  }

  /** Mints a fresh token for one parent launch and remembers its context. */
  issue(context: DelegationParentContext): string {
    const token = this.generateToken()
    this.contexts.set(token, context)
    return token
  }

  /**
   * Forgets a token — called once its parent launch has ended (T4's
   * concern), so this map does not grow for the life of the app. A no-op
   * for a token that was never issued or is already gone.
   */
  revoke(token: string): void {
    this.contexts.delete(token)
  }

  /**
   * The context a token was issued for, or undefined for one this registry
   * never issued (or has since revoked). Scans every LIVE token and compares
   * it with `tokensMatch` rather than `Map.get` (#511 MEDIUM-1): `Map.get`
   * compares its key byte by byte and can return as soon as two differ,
   * exactly the signal a constant-time compare exists to deny a caller on
   * the same machine timing its way toward a valid token. Bounded by however
   * many launches are concurrently live, never by anything a caller
   * controls.
   */
  contextFor(token: string): DelegationParentContext | undefined {
    for (const [candidate, context] of this.contexts) {
      if (tokensMatch(candidate, token)) return context
    }
    return undefined
  }
}
