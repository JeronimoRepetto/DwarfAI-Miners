// L3 (17 §1.3): runDelegationMcpContract over FakeDelegationServer, the double that calls the
// handler directly (16 §4.8, §5.7), with the two tools as the application answers them. The real
// McpDelegationServer runs the same contract in adapters/mcp/McpDelegationServer.test.ts.
import { answerDelegateSubtask, answerSubtaskResult } from '../application/delegationEndpoint'
import { DELEGATION_WAIT_MS, type DelegationEndpoint } from '../ports/delegationServer'
import { FakeDelegationServer } from '../ports/fakes/FakeDelegationServer'
import { runDelegationMcpContract } from './delegationMcp.contract'

runDelegationMcpContract('FakeDelegationServer', async (endpoint, token) => {
  const server = new FakeDelegationServer()
  await server.listen(endpoint)
  const handler = (): DelegationEndpoint => {
    if (server.handler === null) throw new Error('not listening')
    return server.handler
  }
  return {
    caller: {
      delegateSubtask: async (args) => ({
        view: await answerDelegateSubtask(handler(), token, args, DELEGATION_WAIT_MS),
        isError: false
      }),
      subtaskResult: async (args) => ({
        view: await answerSubtaskResult(handler(), token, args.ticket, DELEGATION_WAIT_MS),
        isError: false
      })
    },
    dispose: () => server.close()
  }
})
