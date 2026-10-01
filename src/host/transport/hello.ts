// The first-frame rule of the UI endpoint (ADR-003 items 5, 12, frozen; 14 B-M01, B-F01, B-F02):
// a decoded first frame is answered with `hello.ok` or refused with one protocol error code.
//
// In order:
// 1. not a `hello` (a `req`, another type, not an object) → PROTOCOL_ERROR;
// 2. an `McpHello` (role `mcp`): another endpoint's first frame → PROTOCOL_ERROR (item 12);
// 3. an `endpointGeneration` other than 1 → INCOMPATIBLE_GENERATION (ADR-002 D8), checked before
//    the strict shape because another generation's hello may have another shape;
// 4. not exactly the `Hello` shape (zod strict) → PROTOCOL_ERROR;
// 5. role `viewer` → AUTH_FAILED until the per-view token issuer exists (later: ISSUE-170): a
//    viewer authenticates only with a per-view token, never with the uiToken;
// 6. a token that is not this boot's uiToken (constant-time compare on the hashes) → AUTH_FAILED;
// 7. otherwise `hello.ok` with a new `clientId`.
//
// Nothing here logs or returns any field of the frame: the refusal is its code alone.
import { helloSchema, type HelloOk, type ProtocolErrorCode } from '@dwarfai/contracts'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { HostStateReport } from '../wiring/boot'
import type { ChannelRole } from './roles'

/** What this Host build says about itself in `hello.ok`. */
export interface HostIdentity {
  hostVersion: string
  /** The git commit (short) the build was made from (20 §3.1). */
  buildId: string
  protocolVersion: number
}

export interface HelloDeps {
  token: { verify(candidate: string): boolean }
  ids: IdGenerator
  identity: HostIdentity
  /** This boot's epoch (ADR-003 HelloOk.epoch). */
  epoch: string
  state: () => HostStateReport
  capabilities: () => readonly string[]
}

export type HelloAnswer =
  | { kind: 'accepted'; role: ChannelRole; helloOk: HelloOk }
  | { kind: 'refused'; code: ProtocolErrorCode }

const refused = (code: ProtocolErrorCode): HelloAnswer => ({ kind: 'refused', code })

export function answerHello(message: unknown, deps: HelloDeps): HelloAnswer {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return refused('PROTOCOL_ERROR')
  }
  const frame = message as { type?: unknown; role?: unknown; endpointGeneration?: unknown }
  if (frame.type !== 'hello' || frame.role === 'mcp') return refused('PROTOCOL_ERROR')
  if (typeof frame.endpointGeneration === 'number' && frame.endpointGeneration !== 1) {
    return refused('INCOMPATIBLE_GENERATION')
  }
  const hello = helloSchema.safeParse(message)
  if (!hello.success) return refused('PROTOCOL_ERROR')
  if (hello.data.role === 'viewer') return refused('AUTH_FAILED')
  if (!deps.token.verify(hello.data.token)) return refused('AUTH_FAILED')

  const { state, jobStatus } = deps.state()
  return {
    kind: 'accepted',
    role: hello.data.role,
    helloOk: {
      type: 'hello.ok',
      hostVersion: deps.identity.hostVersion,
      buildId: deps.identity.buildId,
      protocolVersion: deps.identity.protocolVersion,
      endpointGeneration: 1,
      epoch: deps.epoch,
      state,
      jobStatus,
      capabilities: [...deps.capabilities()],
      clientId: deps.ids.uuidv7()
    }
  }
}
