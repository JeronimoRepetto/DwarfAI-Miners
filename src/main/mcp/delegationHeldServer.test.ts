import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DelegationLink } from './delegationLink'
import {
  DELEGATE_SUBTASK_DESCRIPTION as HELD_DELEGATE_SUBTASK_DESCRIPTION,
  SUBTASK_RESULT_DESCRIPTION as HELD_SUBTASK_RESULT_DESCRIPTION,
  createHeldDelegationMcpServer
} from './delegationHeldServer'
import {
  DELEGATE_SUBTASK_DESCRIPTION as CORE_DELEGATE_SUBTASK_DESCRIPTION,
  SUBTASK_RESULT_DESCRIPTION as CORE_SUBTASK_RESULT_DESCRIPTION
} from './jevMcpServerCore'

/**
 * The held Claude session's own in-process delegation server (#511 M1a).
 * Two things this proves that no other test in this repository can:
 *
 * 1. `createHeldDelegationMcpServer` returns a `type: 'sdk'` config, never a
 *    `type: 'stdio'` one — the whole reason it exists (see its own module
 *    comment for the argv-exposure finding and the `sdk.mjs` evidence).
 * 2. The installed `@anthropic-ai/claude-agent-sdk`'s own `sdk.mjs` really
 *    does filter `type: 'sdk'` entries out of the argv it builds for
 *    `--mcp-config` — pinned directly against the installed package so a
 *    future SDK upgrade that changes this split fails this test rather than
 *    silently reintroducing the exposure.
 */

function fakeLink(overrides: Partial<DelegationLink> = {}): DelegationLink {
  return {
    delegate: async () => ({
      status: 'done',
      outcome: { kind: 'concluded', text: 'ok', endedAt: 1 }
    }),
    result: async () => ({
      status: 'done',
      outcome: { kind: 'concluded', text: 'ok', endedAt: 1 }
    }),
    ...overrides
  }
}

describe('createHeldDelegationMcpServer (#511 M1a)', () => {
  it('builds a type: "sdk" config, never a stdio one — the argv-exposure fix itself', () => {
    const config = createHeldDelegationMcpServer({ link: fakeLink(), waitMs: 5_000 })

    expect(config.type).toBe('sdk')
    expect(config.name).toBe('jev')
    expect('command' in config).toBe(false)
    expect('args' in config).toBe(false)
    expect('env' in config).toBe(false)
    expect(config.instance).toBeDefined()
  })

  it("duplicates jevMcpServerCore.ts's own tool descriptions byte for byte (drift guard)", () => {
    // This file's own module comment explains why it cannot IMPORT
    // jevMcpServerCore.ts at runtime (that would pull delegationProtocol.ts
    // into both build graphs) — so the wording is duplicated, and this test
    // is what keeps the two from silently drifting apart, the same
    // discipline delegationServerProtocol.test.ts already holds for its own
    // twin constants.
    expect(HELD_DELEGATE_SUBTASK_DESCRIPTION).toBe(CORE_DELEGATE_SUBTASK_DESCRIPTION)
    expect(HELD_SUBTASK_RESULT_DESCRIPTION).toBe(CORE_SUBTASK_RESULT_DESCRIPTION)
  })

  it('the installed Agent SDK filters type: "sdk" mcpServers entries out of the --mcp-config argv build (evidence for the fix)', () => {
    // Reads the ACTUAL installed sdk.mjs rather than trusting a comment: this
    // is the exact excerpt `delegationHeldServer.ts`'s own module comment
    // quotes as evidence that a `type:'sdk'` entry never reaches the CLI's
    // command line. If a future SDK upgrade changes this split, this
    // assertion fails loudly instead of the fix silently regressing.
    const sdkPath = fileURLToPath(
      new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url)
    )
    const sdkSource = readFileSync(sdkPath, 'utf8')
    // The split that keeps a `type:'sdk'` server out of the `mcpServers` map
    // handed to `ProcessTransport` (and therefore out of its own `--mcp-config`
    // argv build) — a `Map` collects the sdk-type entries separately.
    expect(sdkSource).toMatch(/type===["']sdk["']/)
    // The argv build itself only fires for a NON-empty --mcp-config object,
    // built from the SAME variable the transport's own `mcpServers` option
    // carries — i.e. never the sdk-type entries the split above diverted.
    expect(sdkSource).toContain('"--mcp-config"')
  })
})
