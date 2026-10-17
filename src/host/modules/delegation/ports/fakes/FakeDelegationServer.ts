// The DelegationServer double (16 §4.8 `FakeDelegationServer`: "calls the handler directly"). No
// endpoint and no MCP: `listen` keeps the handler, and a test calls the two tools on it as a relay
// would (the application's `answerDelegateSubtask` / `answerSubtaskResult`), getting the same
// tool-result view the MCP server answers. Never imported by production code (R14).
import type { DelegationEndpoint, DelegationServer, LoopbackEndpoint } from '../delegationServer'

export class FakeDelegationServer implements DelegationServer {
  /** The handler `listen` was given, until `close`. */
  handler: DelegationEndpoint | null = null
  closed = false

  listen(handler: DelegationEndpoint): Promise<{ endpoint: LoopbackEndpoint }> {
    this.handler = handler
    this.closed = false
    return Promise.resolve({ endpoint: { path: 'fake-delegation-endpoint' } })
  }

  close(): Promise<void> {
    this.handler = null
    this.closed = true
    return Promise.resolve()
  }
}
