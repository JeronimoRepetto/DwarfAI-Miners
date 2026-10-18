// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult, JevSuggestResult } from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { jevCardEyebrow } from '../lib/launch/jevCardCopy'
import { useAgentLaunch } from './useAgentLaunch'

/*
 * ISSUE-195 (wired by the step-3a switch, ISSUE-001): the Add panel's Jev card is A-50 in its 14 shape,
 * `routeJevLaunch(JevSuggestParams)` → `IpcResult<JevSuggestResult>`, asked while the prompt is written with Let Jev
 * choose on (UC-009 a). The card is a request result held in the composable's memory, never a frame and never persisted
 * (INV-87; 11 §6 O-11-11); a late answer after Dismiss, an emptied prompt or a newer ask is dropped. Tested against the
 * generated fake `window.api` (ADR-033 item 7).
 */

const MINE = '01920000-0000-7000-8000-0000000004a1'

type Answer = IpcResult<JevSuggestResult>

function suggestion(providerId: string, model = 'gpt-5.6-sol', effort = 'high'): Answer {
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        providerId: providerId as never,
        model,
        effort,
        tier: 'balanced',
        confidence: { providerId: 0.9 },
        truncated: false,
        parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
      }
    }
  }
}

/** A-50 answers each ask when the test releases it, so a late answer can be staged. */
function stubApi() {
  const asks: Array<{ params: unknown; answer: (value: Answer) => void }> = []
  const routeJevLaunch = vi.fn(
    (params: unknown) =>
      new Promise<Answer>((resolve) => {
        asks.push({ params, answer: resolve })
      })
  )
  const api = {
    listAgentProviders: vi.fn().mockResolvedValue({
      ok: true,
      value: ['claude', 'codex'].map((providerId) => ({
        providerId,
        label: providerId,
        models: [],
        permissionModes: [],
        offeredModes: [],
        installed: true,
        publicLaunch: 'enabled',
        answerChannel: 'available'
      }))
    }),
    getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
    launchAgent: vi.fn().mockResolvedValue({ ok: true, value: { launchId: MINE } }),
    routeJevLaunch
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi(api)
  })
  return { api, asks }
}

/** The person's own pickers stand (Claude, a model, an effort) with Let Jev choose on and a prompt written. */
async function writing(prompt: string) {
  const world = stubApi()
  const launch = useAgentLaunch()
  await launch.open(MINE)
  launch.choose('claude')
  launch.setModel('opus')
  launch.setEffort('low')
  launch.toggleJevEnabled()
  launch.setPrompt(prompt)
  return { ...world, launch }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  useAgentLaunch().close()
})

describe('useAgentLaunch: the Jev card from A-50 (ISSUE-195)', () => {
  it('[US-LAUNCH-003.AC02] an answered routeJevLaunch fills the card and the pickers with the pick', async () => {
    const { asks, launch } = await writing('add a field to this form')
    expect(asks.map((ask) => ask.params)).toEqual([
      { prompt: 'add a field to this form', mineId: MINE }
    ])

    asks[0]!.answer(suggestion('codex'))
    await settle()

    expect(launch.jev.value.routing).toMatchObject({
      phase: 'suggested',
      suggestion: { providerId: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
    })
    expect([
      launch.state.value.choice,
      launch.state.value.model,
      launch.state.value.effort
    ]).toEqual(['codex', 'gpt-5.6-sol', 'high'])
  })

  it('[US-LAUNCH-003.AC07, INV-87] a changed prompt hides the card, restores the pickers and asks again with the new prompt; the older result is dropped when it arrives', async () => {
    const { asks, launch } = await writing('add a field')
    asks[0]!.answer(suggestion('codex'))
    await settle()
    expect(launch.state.value.choice).toBe('codex')

    launch.setPrompt('rename the module')
    expect(launch.jev.value.routing.phase).toBe('asking')
    expect([
      launch.state.value.choice,
      launch.state.value.model,
      launch.state.value.effort
    ]).toEqual(['claude', 'opus', 'low'])
    expect(asks.at(-1)?.params).toEqual({ prompt: 'rename the module', mineId: MINE })

    // A third ask leaves before the second answers; the second answer is about a prompt nobody is writing.
    launch.setPrompt('rename the module and its tests')
    asks[1]!.answer(suggestion('codex', 'gpt-5.6-mini', 'medium'))
    await settle()
    expect(launch.jev.value.routing.phase).toBe('asking')
    expect(launch.state.value.choice).toBe('claude')

    asks[2]!.answer(suggestion('codex'))
    await settle()
    expect(launch.state.value.model).toBe('gpt-5.6-sol')
  })

  it('[US-LAUNCH-003.AC08] a jev-unreachable result shows no card and restores the pickers that stood before', async () => {
    const { asks, launch } = await writing('add a field')

    asks[0]!.answer({ ok: true, value: { ok: false, error: 'jev-unreachable' } })
    await settle()

    expect(launch.jev.value.routing).toEqual({ phase: 'idle' })
    expect([
      launch.state.value.choice,
      launch.state.value.model,
      launch.state.value.effort
    ]).toEqual(['claude', 'opus', 'low'])
  })

  it('[US-LAUNCH-004.AC01, INV-87] after Dismiss a late result is dropped and no card returns', async () => {
    const { asks, launch } = await writing('add a field')

    launch.dismissJevDecision()
    asks[0]!.answer(suggestion('codex'))
    await settle()

    expect(launch.jev.value.routing).toEqual({ phase: 'idle' })
    expect(launch.state.value.choice).toBe('claude')
  })

  it('[US-LAUNCH-003.AC04] with auto-accept on the same suggestion is applied and the card reads as accepted automatically', async () => {
    const { asks, launch } = await writing('add a field')
    launch.toggleJevAutoAccept()
    launch.setPrompt('add a field to the form')

    asks.at(-1)!.answer(suggestion('codex'))
    await settle()

    expect(launch.jev.value.autoAccept).toBe(true)
    expect(launch.state.value.choice).toBe('codex')
    // The eyebrow itself is EPIC-16's: the composable exposes the acceptance mode it reads.
    expect(jevCardEyebrow(launch.jev.value.autoAccept)).toBe('JEV · ACCEPTED AUTOMATICALLY')
  })
})
