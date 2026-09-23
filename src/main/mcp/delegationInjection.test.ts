import { describe, expect, it } from 'vitest'
import {
  DELEGATION_ALLOWED_TOOLS,
  DELEGATION_SERVER_NAME,
  claudeDetachedExtraArgs,
  claudeHeldMcpServers,
  claudeMcpConfigJson,
  codexDelegationConfigArgs,
  mergeOpenCodeConfigContent,
  type DelegationInjectionContext
} from './delegationInjection'

/**
 * Pure per-provider injection builders (#511 T4) — argv/env/config shapes
 * only, never a spawn, a file write or a gate check. Table-tested against
 * the exact wire env names `delegationProtocol.ts` (T2) already fixed and
 * the exact tool names `jevMcpServerCore.ts` registers, so a drift in either
 * fails here rather than silently producing a config the child CLI cannot
 * use.
 */

const CTX: DelegationInjectionContext = {
  serverCommand: 'C:\\Program Files\\DwarfAI-Miners\\DwarfAI-Miners.exe',
  serverArgs: [
    'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar.unpacked\\out\\main\\jevMcpServer.js'
  ],
  endpoint: 'http://127.0.0.1:54321',
  token: 'tok-abc123'
}

describe('DELEGATION_ALLOWED_TOOLS', () => {
  it('names both tools with the mcp__<server>__<tool> spelling the CLI documents', () => {
    expect(DELEGATION_SERVER_NAME).toBe('jev')
    expect(DELEGATION_ALLOWED_TOOLS).toEqual([
      'mcp__jev__delegate_subtask',
      'mcp__jev__subtask_result'
    ])
  })
})

describe('claudeHeldMcpServers', () => {
  it('builds one stdio server entry carrying the loopback env, plus ELECTRON_RUN_AS_NODE for the spawned server itself', () => {
    expect(claudeHeldMcpServers(CTX)).toEqual({
      jev: {
        type: 'stdio',
        command: CTX.serverCommand,
        args: CTX.serverArgs,
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DWARFAI_DELEGATION_ENDPOINT: CTX.endpoint,
          DWARFAI_DELEGATION_TOKEN: CTX.token
        }
      }
    })
  })

  it('carries an explicit waitMs override as DWARFAI_DELEGATION_WAIT_MS, never when absent', () => {
    const withWait = claudeHeldMcpServers({ ...CTX, waitMs: 12_000 })
    expect(withWait.jev?.env.DWARFAI_DELEGATION_WAIT_MS).toBe('12000')
    expect(claudeHeldMcpServers(CTX).jev?.env.DWARFAI_DELEGATION_WAIT_MS).toBeUndefined()
  })
})

describe('claudeMcpConfigJson / claudeDetachedExtraArgs', () => {
  it('serializes the exact same server map --mcp-config would read from a file', () => {
    const parsed: unknown = JSON.parse(claudeMcpConfigJson(CTX))
    expect(parsed).toEqual({ mcpServers: claudeHeldMcpServers(CTX) })
  })

  it('appends --mcp-config <path> and --allowedTools <tool> <tool> as separate argv elements', () => {
    expect(claudeDetachedExtraArgs('C:\\Users\\j\\AppData\\Local\\Temp\\mcp-config.json')).toEqual([
      '--mcp-config',
      'C:\\Users\\j\\AppData\\Local\\Temp\\mcp-config.json',
      '--allowedTools',
      'mcp__jev__delegate_subtask',
      'mcp__jev__subtask_result'
    ])
  })
})

describe('mergeOpenCodeConfigContent', () => {
  it('builds a fresh OPENCODE_CONFIG_CONTENT when the launch env carries none', () => {
    const merged: unknown = JSON.parse(mergeOpenCodeConfigContent(undefined, CTX)!)
    expect(merged).toEqual({
      mcp: {
        jev: {
          type: 'local',
          command: [CTX.serverCommand, ...CTX.serverArgs],
          environment: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_DELEGATION_ENDPOINT: CTX.endpoint,
            DWARFAI_DELEGATION_TOKEN: CTX.token
          },
          enabled: true
        }
      }
    })
  })

  it("merges into the launch's own existing OPENCODE_CONFIG_CONTENT rather than clobbering it", () => {
    const existing = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { other: { type: 'local', command: ['other-server'], enabled: true } }
    })
    const merged: unknown = JSON.parse(mergeOpenCodeConfigContent(existing, CTX)!)
    expect(merged).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        other: { type: 'local', command: ['other-server'], enabled: true },
        jev: {
          type: 'local',
          command: [CTX.serverCommand, ...CTX.serverArgs],
          environment: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_DELEGATION_ENDPOINT: CTX.endpoint,
            DWARFAI_DELEGATION_TOKEN: CTX.token
          },
          enabled: true
        }
      }
    })
  })

  // AMENDED for #511 L4 (was: "treats malformed existing content as absent
  // rather than throwing", asserting the merge silently REPLACED the
  // launch's own malformed OPENCODE_CONFIG_CONTENT with just
  // {mcp:{jev:...}}). That was the bug: existing content this app cannot
  // see the reason for was being discarded rather than preserved. The
  // correct answer is `undefined` — never a throw, still — which tells the
  // caller (launchRunner.ts's delegationInjectionFor) to skip injection for
  // that one launch instead of clobbering content it cannot parse.
  it('answers undefined for existing content this app cannot parse as a JSON object, rather than replacing it (#511 L4)', () => {
    expect(() => mergeOpenCodeConfigContent('{not json', CTX)).not.toThrow()
    expect(mergeOpenCodeConfigContent('{not json', CTX)).toBeUndefined()
    expect(mergeOpenCodeConfigContent('[]', CTX)).toBeUndefined()
    expect(mergeOpenCodeConfigContent('"a string"', CTX)).toBeUndefined()
    expect(mergeOpenCodeConfigContent('42', CTX)).toBeUndefined()
  })

  it('still builds fresh content for genuinely absent or empty existing content', () => {
    expect(mergeOpenCodeConfigContent(undefined, CTX)).toBeDefined()
    expect(mergeOpenCodeConfigContent('', CTX)).toBeDefined()
  })

  it('replaces a same-named jev entry rather than merging under it, so a stale registration never survives', () => {
    const existing = JSON.stringify({
      mcp: { jev: { type: 'local', command: ['stale'], enabled: false } }
    })
    const merged: unknown = JSON.parse(mergeOpenCodeConfigContent(existing, CTX)!)
    expect(merged).toMatchObject({
      mcp: { jev: { command: [CTX.serverCommand, ...CTX.serverArgs] } }
    })
  })
})

describe('codexDelegationConfigArgs (built and tested; Codex stays excluded from DELEGATION_CAPABLE_PROVIDERS)', () => {
  it('emits one -c pair per key, each value valid TOML', () => {
    const args = codexDelegationConfigArgs(CTX)
    expect(args[0]).toBe('-c')
    expect(args[1]).toBe(`mcp_servers.jev.command="${CTX.serverCommand.replaceAll('\\', '\\\\')}"`)
    expect(args[2]).toBe('-c')
    expect(args[3]).toBe(`mcp_servers.jev.args=["${CTX.serverArgs[0]!.replaceAll('\\', '\\\\')}"]`)
    expect(args[4]).toBe('-c')
    expect(args[5]).toBe(
      'mcp_servers.jev.env={ ELECTRON_RUN_AS_NODE = "1", ' +
        `DWARFAI_DELEGATION_ENDPOINT = "${CTX.endpoint}", ` +
        `DWARFAI_DELEGATION_TOKEN = "${CTX.token}" }`
    )
    expect(args).toHaveLength(6)
  })

  it('escapes a literal double quote and backslash in a value, so a Windows path never breaks the TOML string', () => {
    const withQuote = codexDelegationConfigArgs({
      ...CTX,
      serverCommand: 'C:\\Program Files\\"weird"\\node.exe'
    })
    expect(withQuote[1]).toBe(
      'mcp_servers.jev.command="C:\\\\Program Files\\\\\\"weird\\"\\\\node.exe"'
    )
  })
})
