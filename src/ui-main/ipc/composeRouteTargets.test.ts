// layer: L2
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChannelKey } from '@dwarfai/contracts'
import { composeRouteTargets } from './composeRouteTargets'
import type { RouteTarget } from './router'
import type { IpcSenderEvent } from './senderCheck'

/**
 * The `ui-local` route targets of Electron main are built by several issues (preference rows, A-N30, links and
 * pickers, Panel rows…) and the router takes one `uiLocal` target (ADR-001 item 3). The composer joins them into
 * one target that dispatches by channel, with exactly one owner per channel (21 §1 item 1).
 */
function recording(answer: unknown) {
  const served: [string, unknown, IpcSenderEvent | undefined][] = []
  const target: RouteTarget = {
    async serve(channel, payload, sender) {
      served.push([channel, payload, sender])
      return answer
    }
  }
  return { target, served }
}

const PANEL: IpcSenderEvent = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }

describe('composeRouteTargets (21 §1 item 1)', () => {
  it('[ADR-001] a call reaches the one part that declares its channel, with its payload and sender', async () => {
    const preferences = recording({ stored: true })
    const diagnostics = recording(undefined)
    const uiLocal = composeRouteTargets([
      { channels: ['audio:preferences:get', 'audio:preferences:set'], target: preferences.target },
      { channels: ['diag:renderer:report'], target: diagnostics.target }
    ])

    expect(await uiLocal.serve('audio:preferences:set', { musicVolume: 1 }, PANEL)).toEqual({
      stored: true
    })
    expect(await uiLocal.serve('diag:renderer:report', { event: 'renderer.error' }, PANEL)).toBe(
      undefined
    )
    expect(await uiLocal.serve('audio:preferences:get', undefined)).toEqual({ stored: true })

    expect(preferences.served).toEqual([
      ['audio:preferences:set', { musicVolume: 1 }, PANEL],
      ['audio:preferences:get', undefined, undefined]
    ])
    expect(diagnostics.served).toEqual([
      ['diag:renderer:report', { event: 'renderer.error' }, PANEL]
    ])
  })

  it('[ADR-001] a channel no part declares is refused with METHOD_NOT_FOUND and reaches no part', async () => {
    const preferences = recording({ stored: true })
    const uiLocal = composeRouteTargets([
      { channels: ['audio:preferences:get'], target: preferences.target }
    ])
    expect(await uiLocal.serve('panel:hide', undefined, PANEL)).toEqual({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'no route for panel:hide', retryable: false }
    })
    expect(await composeRouteTargets([]).serve('audio:preferences:get', undefined)).toEqual({
      ok: false,
      error: {
        code: 'METHOD_NOT_FOUND',
        message: 'no route for audio:preferences:get',
        retryable: false
      }
    })
    expect(preferences.served).toEqual([])
  })

  it('[ADR-001] a channel declared by two parts stops the composition: one owner per channel', () => {
    const shared: ChannelKey = 'launch-view:set'
    expect(() =>
      composeRouteTargets([
        { channels: ['launch-view:get', shared], target: recording(undefined).target },
        { channels: [shared], target: recording(undefined).target }
      ])
    ).toThrow('two ui-local owners for launch-view:set')
    // The same channel listed twice by one part is still one owner.
    expect(() =>
      composeRouteTargets([{ channels: [shared, shared], target: recording(undefined).target }])
    ).not.toThrow()
  })

  it('[ADR-001] the composer is pure: it imports no Electron and nothing but types and the contracts', () => {
    const source = readFileSync(join(import.meta.dirname, 'composeRouteTargets.ts'), 'utf8')
    const specifiers = [...source.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1]
    )
    expect(specifiers.filter((s) => s === 'electron' || s?.startsWith('node:'))).toEqual([])
    expect(source).not.toMatch(/\brequire\s*\(/)
  })
})
