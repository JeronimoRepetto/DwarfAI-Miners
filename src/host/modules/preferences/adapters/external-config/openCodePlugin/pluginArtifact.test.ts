// L1: the zero-import plugin artifact DwarfAI writes into OpenCode's plugin folder (16 §7.1; ADR-016
// items 1, 6.2). The rendered source is also run in a bare `node:vm` context holding only what
// OpenCode's own runtime gives a plugin (`fetch`, `AbortSignal`, `Set`, `JSON`, `String`), so a
// plugin that needed anything else would fail here.
//
// TC-227-04 (the artifact imports nothing and carries the token only inside the file).
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { renderPluginArtifact } from './pluginArtifact'

const INPUT = {
  installId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  port: 45123,
  token: 'f00d'.repeat(16)
}

interface Posted {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

type Plugin = (ctx: unknown) => Promise<{ event: (input: { event: unknown }) => Promise<void> }>

/** The rendered plugin's entry point, loaded with only OpenCode's runtime globals. */
function load(source: string, fetchImpl: (url: string, init: Posted['init']) => Promise<unknown>) {
  const script = `${source.replace(/^export const /m, 'const ')}\nDwarfAiOpenCodePermissionPlugin`
  const plugin = runInNewContext(script, {
    fetch: fetchImpl,
    AbortSignal: { timeout: () => ({}) },
    Set,
    JSON,
    String
  }) as Plugin
  return plugin
}

describe('pluginArtifact', () => {
  it('[ADR-016] the rendered plugin has no import or require statement', () => {
    const source = renderPluginArtifact(INPUT)

    expect(source).not.toMatch(/\bimport\b/)
    expect(source).not.toMatch(/\brequire\b/)
    expect(source.split('\n')[0]).toBe(`// dwarfai-managed ${INPUT.installId}`)
    // The one export OpenCode loads, and nothing else.
    expect(source.match(/^export /gm)).toStrictEqual(['export '])
  })

  it('[ADR-016] the rendered plugin reports only permission events to the ingress, with its token in the x-dwarfai-token header', async () => {
    const posted: Posted[] = []
    const plugin = load(renderPluginArtifact(INPUT), async (url, init) => {
      posted.push({ url, init })
      return {}
    })
    const hooks = await plugin({ serverUrl: new URL('http://127.0.0.1:4096/') })

    await hooks.event({ event: { type: 'message.part.delta', properties: {} } })
    await hooks.event({ event: { type: 'permission.asked', properties: { id: 'per_1' } } })
    await hooks.event({ event: { type: 'permission.replied', properties: { id: 'per_1' } } })
    await hooks.event({ event: null })

    expect(posted.map(({ url }) => url)).toStrictEqual([
      'http://127.0.0.1:45123/opencode/event',
      'http://127.0.0.1:45123/opencode/event'
    ])
    expect(posted[0]?.init.method).toBe('POST')
    // Spread into this realm: the plugin ran in its own `vm` context.
    expect({ ...posted[0]?.init.headers }).toStrictEqual({
      'content-type': 'application/json',
      'x-dwarfai-token': INPUT.token
    })
    expect(JSON.parse(posted[0]?.init.body ?? 'null')).toStrictEqual({
      event: { type: 'permission.asked', properties: { id: 'per_1' } },
      serverUrl: 'http://127.0.0.1:4096/'
    })
  })

  it('[ADR-016] a report that cannot be sent never throws into OpenCode', async () => {
    const rejecting = load(renderPluginArtifact(INPUT), () => Promise.reject(new Error('refused')))
    const throwing = load(renderPluginArtifact(INPUT), () => {
      throw new Error('no fetch')
    })

    for (const plugin of [rejecting, throwing]) {
      const hooks = await plugin({ serverUrl: new URL('http://127.0.0.1:4096/') })
      await expect(
        hooks.event({ event: { type: 'permission.asked', properties: {} } })
      ).resolves.toBeUndefined()
    }
  })

  it('[ADR-016, C-21] a token, port or install id that could break out of the file is refused without echoing it', () => {
    for (const input of [
      { ...INPUT, token: "f00d'+globalThis+'" },
      { ...INPUT, token: 'F00D'.repeat(16) },
      { ...INPUT, token: 'f00d' },
      { ...INPUT, port: 0 },
      { ...INPUT, port: 65536 },
      { ...INPUT, port: 1.5 },
      { ...INPUT, installId: `${INPUT.installId}\nconst x = 1` },
      { ...INPUT, installId: 'not-an-id' }
    ]) {
      expect(() => renderPluginArtifact(input)).toThrow(HostInvariantError)
      try {
        renderPluginArtifact(input)
      } catch (error) {
        expect(String(error)).not.toContain(input.token)
      }
    }
  })
})
