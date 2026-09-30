// The seam-B hello handshake shapes, owned by ADR-003 item 5 (frozen) and used unchanged by 14 §3.2.
import { z } from 'zod'

// verbatim: ADR-003 item 5 (each interface byte-for-byte; `prettier-ignore` keeps its alignment)
// prettier-ignore
interface Hello {
  type: 'hello'
  endpointGeneration: 1                // stable, additive-only (ADR-002 D8)
  protocolVersion: number              // private, per build
  role: 'ui' | 'notifier' | 'viewer'   // UI endpoint only (item 12); hook, plugin and MCP callers use other endpoints
  token: string                        // uiToken (ui, notifier) or a per-view token (viewer), hex
  viewId?: string                      // role 'viewer' only (item 12)
  client: { appVersion: string; buildId: string; pid: number }
  resume?: { epoch: string; lastSeq: number }   // hot reconnect (item 8)
}
// prettier-ignore
interface McpHello {                   // MCP endpoint only (item 12, ADR-013 item 3); never accepted on the UI endpoint
  type: 'hello'
  endpointGeneration: 1
  protocolVersion: number
  role: 'mcp'
  launchId: string                     // the launch whose delegation tools this connection may call
  credential: string                   // read by the relay from run/mcp/<launchId>.cred, hex; never argv or env
}
// prettier-ignore
interface HelloOk {
  type: 'hello.ok'
  hostVersion: string
  buildId: string
  protocolVersion: number
  endpointGeneration: 1
  epoch: string                        // Host boot id; changes on every Host start
  state: 'starting' | 'migrating' | 'ready' | 'upgrade-pending'
  jobStatus: 'none' | 'breakaway-ok' | 'in-job' | 'n/a'
  capabilities: string[]               // feature names this Host serves
  clientId: string                     // assigned connection id
}
// end verbatim: ADR-003 item 5

export type { Hello, McpHello, HelloOk }

// The strict() schemas both sides validate with (ADR-003 item 6, 14 §1.4); their inferred types equal the
// interfaces above (type test in envelope.contract.test.ts).
export const helloSchema = z
  .object({
    type: z.literal('hello'),
    endpointGeneration: z.literal(1),
    protocolVersion: z.number(),
    role: z.enum(['ui', 'notifier', 'viewer']),
    token: z.string(),
    viewId: z.string().optional(),
    client: z.object({ appVersion: z.string(), buildId: z.string(), pid: z.number() }).strict(),
    resume: z.object({ epoch: z.string(), lastSeq: z.number() }).strict().optional()
  })
  .strict()

export const mcpHelloSchema = z
  .object({
    type: z.literal('hello'),
    endpointGeneration: z.literal(1),
    protocolVersion: z.number(),
    role: z.literal('mcp'),
    launchId: z.string(),
    credential: z.string()
  })
  .strict()

export const helloOkSchema = z
  .object({
    type: z.literal('hello.ok'),
    hostVersion: z.string(),
    buildId: z.string(),
    protocolVersion: z.number(),
    endpointGeneration: z.literal(1),
    epoch: z.string(),
    state: z.enum(['starting', 'migrating', 'ready', 'upgrade-pending']),
    jobStatus: z.enum(['none', 'breakaway-ok', 'in-job', 'n/a']),
    capabilities: z.array(z.string()),
    clientId: z.string()
  })
  .strict()
