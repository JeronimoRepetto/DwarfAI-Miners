import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createDelegationLink } from './delegationLink'
import { DEFAULT_DELEGATION_WAIT_MS, readLinkEnv } from './delegationProtocol'
import { createJevMcpServer } from './jevMcpServerCore'

/**
 * The stdio MCP server entry a launched session's CLI spawns directly as a
 * plain Node process (#511, T4's injection adapters) — OUTSIDE Electron's
 * module loader entirely. Whether an `ELECTRON_RUN_AS_NODE` process can even
 * resolve an asar-packed `node_modules` is unmeasured, and this design does
 * not depend on it: `electron.vite.jevMcpServer.config.ts` (its own, wholly
 * separate build — #511 M1a/L2) bundles `@modelcontextprotocol/sdk` and
 * `zod` straight into this file's own build output, so it needs nothing at
 * runtime beyond Node builtins — see that config's own comment.
 *
 * Composition only. Every real decision — what the two tools do, how a
 * failure is built, how the loopback link talks to main — lives in
 * `jevMcpServerCore.ts` / `delegationLink.ts` / `delegationProtocol.ts`,
 * which is what makes this file untestable in the ordinary sense and
 * everything it calls fully testable in isolation.
 */
async function main(): Promise<void> {
  const linkEnv = readLinkEnv(process.env)
  const link =
    linkEnv === undefined
      ? undefined
      : createDelegationLink({
          endpoint: linkEnv.endpoint,
          token: linkEnv.token,
          fetch: globalThis.fetch,
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        })

  const server = createJevMcpServer({
    link,
    waitMs: linkEnv?.waitMs ?? DEFAULT_DELEGATION_WAIT_MS
  })
  await server.connect(new StdioServerTransport())
}

// Never exits non-zero over a missing or malformed env (#511): the server
// still starts either way (createJevMcpServer answers every tool call with
// `link-unconfigured` when `link` is undefined) — a dead MCP server would
// degrade the very session it was injected into more than an
// always-answering tool does. Only a genuine startup failure (stdio itself
// refusing) reaches here, and it is logged rather than thrown further.
main().catch((error: unknown) => {
  console.error('[mcp] The Jev delegation server failed to start:', error)
})
