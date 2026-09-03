// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OTHER_CHOICE } from '../lib/launch/launchState'
import { OTHER_NOT_LAUNCHABLE } from '../lib/launch/providerChips'
import { defaultDwarf, defaultMine } from '../testing/factories'
import type { Dwarf, Mine } from '../types'
import { useAgentLaunch } from './useAgentLaunch'

const MINE = 'mine-1'
const CLAUDE = { provider: 'claude' as const, installed: true, launchable: true }
/*
 * Codex became launchable in #168 — as a DETACHED session, not a held one, and
 * that difference is the whole of what the routing below has to get right.
 */
const CODEX = { provider: 'codex' as const, installed: true, launchable: true }
/** A provider a future build detects but has no launch path for. */
const UNBUILT = {
  provider: 'codex' as const,
  installed: true,
  launchable: false,
  reason: 'That agent cannot be started from the panel yet.'
}

/**
 * Every member the composable AWAITS resolves a real result shape. A bare
 * `vi.fn()` resolves undefined, and a fire-and-forget call that then throws
 * outside the narrow try becomes an unhandled rejection only the full suite
 * catches — the trap this branch's base already fell into once.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listAgentProviders: vi.fn().mockResolvedValue({ providers: [CLAUDE, CODEX] }),
    launchHeldSession: vi.fn().mockResolvedValue({ launched: true }),
    launchAgent: vi.fn().mockResolvedValue({ launched: true, provider: 'codex' }),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

function mineWith(dwarfs: Dwarf[]): Mine {
  return defaultMine({ id: MINE, name: 'mine', path: '/work/mine', dwarfs })
}

function heldDwarf(id: string, first: string): Dwarf {
  return defaultDwarf({
    id,
    name: id,
    sessionId: id,
    conversation: [{ role: 'user', text: first, timestamp: '2026-01-01T00:00:00Z' }]
  })
}

/** The store is a module-scope singleton, so each test starts from closed. */
beforeEach(() => {
  useAgentLaunch().close()
})

describe('opening the Add Panel', () => {
  it('asks main which providers this machine has', async () => {
    const api = stubApi()
    const { open, providers } = useAgentLaunch()

    await open(MINE)

    expect(api.listAgentProviders).toHaveBeenCalledOnce()
    expect(providers.value).toEqual([CLAUDE, CODEX])
  })

  it('opens on provider selection, in the mine it was opened from', async () => {
    stubApi()
    const { open, phase, mineId } = useAgentLaunch()

    await open(MINE)

    expect(phase.value).toBe('provider-selection')
    expect(mineId.value).toBe(MINE)
  })

  /*
   * A bridge that cannot answer leaves the row with Other alone, which is
   * exactly what "nothing was detected" looks like — and Other is what the
   * design guarantees is always there.
   */
  it('opens with Other alone when the bridge cannot answer', async () => {
    stubApi({ listAgentProviders: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { open, chips } = useAgentLaunch()

    await open(MINE)

    expect(chips.value.map((chip) => chip.choice)).toEqual([OTHER_CHOICE])
  })

  it('forgets the mine and everything typed when it closes', async () => {
    stubApi()
    const { open, close, setPrompt, choose, phase, mineId } = useAgentLaunch()
    await open(MINE)
    choose('claude')
    setPrompt('dig')

    close()

    expect(phase.value).toBe('closed')
    expect(mineId.value).toBeNull()
  })
})

describe('submitting a launch', () => {
  async function ready(overrides: Record<string, unknown> = {}) {
    const api = stubApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('claude')
    launch.setPrompt('  dig the east gallery  ')
    return { api, launch }
  }

  it('starts a HELD session, naming the mine, the provider and the trimmed prompt', async () => {
    const { api, launch } = await ready()

    await launch.submit()

    // The provider is what #168 added: before it, the chip the user pressed
    // reached no process, and every launch was a Claude one whatever the panel
    // had drawn as selected.
    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE,
      provider: 'claude',
      prompt: 'dig the east gallery'
    })
  })

  it('waits for the dwarf rather than claiming one from the verdict', async () => {
    const { launch } = await ready()

    await launch.submit()

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  it('carries main’s own reason back into the Add state when the launch fails', async () => {
    const { launch } = await ready({
      launchHeldSession: vi
        .fn()
        .mockResolvedValue({ launched: false, error: 'Claude Code is not installed.' })
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBe('Claude Code is not installed.')
  })

  it('says the bridge is down rather than failing silently', async () => {
    const { launch } = await ready({
      launchHeldSession: vi.fn().mockRejectedValue(new Error('bridge down'))
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBeTruthy()
  })

  it('ignores a second Enter while one launch is already in flight', async () => {
    const { api, launch } = await ready()

    await Promise.all([launch.submit(), launch.submit()])

    expect(api.launchHeldSession).toHaveBeenCalledOnce()
  })

  /*
   * The chip is drawn where the design draws it and its gate works, but no
   * engine takes a command — so Enter says so and nothing is started. A submit
   * that reached the bridge would start a CLAUDE session for a command the user
   * chose instead of it, which is the one outcome worse than refusing.
   */
  it('refuses a custom command with the stated reason and starts nothing', async () => {
    const api = stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda')
    launch.commit()
    launch.setPrompt('dig')

    await launch.submit()

    expect(api.launchHeldSession).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBe(OTHER_NOT_LAUNCHABLE)
  })

  it('refuses a detected provider it cannot start, repeating main’s reason', async () => {
    const api = stubApi({ listAgentProviders: vi.fn().mockResolvedValue({ providers: [UNBUILT] }) })
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('codex')
    launch.setPrompt('dig')

    await launch.submit()

    expect(api.launchHeldSession).not.toHaveBeenCalled()
    expect(api.launchAgent).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBe(UNBUILT.reason)
  })
})

/*
 * Which channel a chip goes down (#168).
 *
 * Two launch modes exist and they are not interchangeable. The HELD one keeps
 * an Agent SDK stream, which is the only thing that gives the panel words, so
 * it is the one the design's MessagePanel hand-over needs. The DETACHED one
 * starts a process and lets go. Claude can be either; Codex has no
 * held-session engine in this app, so it can only ever be detached.
 *
 * Routing by what the provider can honestly do is the point. Sending Codex
 * down the held channel would earn a refusal from main — correct, but it would
 * mean the panel offering a chip whose only outcome is an error.
 */
describe('routing a launch to the channel its provider can actually use', () => {
  async function ready(provider: 'claude' | 'codex', overrides: Record<string, unknown> = {}) {
    const api = stubApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(provider)
    launch.setPrompt('  dig the east gallery  ')
    return { api, launch }
  }

  it('holds a Claude session, because only a held one can be watched', async () => {
    const { api } = await ready('claude')
    await useAgentLaunch().submit()

    expect(api.launchHeldSession).toHaveBeenCalledOnce()
    expect(api.launchAgent).not.toHaveBeenCalled()
  })

  it('starts Codex detached, naming the provider on the wire', async () => {
    const { api, launch } = await ready('codex')

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith({
      mineId: MINE,
      provider: 'codex',
      prompt: 'dig the east gallery'
    })
    expect(api.launchHeldSession).not.toHaveBeenCalled()
  })

  /*
   * The honest end for a launch nothing can watch. `launchedDwarfIn` matches an
   * arriving dwarf by the first message of its conversation, and a conversation
   * is held-sessions-only — so no Codex dwarf can ever carry the receipt, and
   * waiting for one would be the panel pretending to look.
   */
  it('stops on started-detached instead of waiting for a dwarf it cannot recognise', async () => {
    const { launch } = await ready('codex')

    await launch.submit()

    expect(launch.phase.value).toBe('started-detached')
    expect(launch.state.value.launchedDwarfId).toBeNull()
    expect(launch.state.value.error).toBeNull()
  })

  it('never adopts a dwarf for a detached launch, however well its words match', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([heldDwarf('codex:sess-9', 'dig the east gallery')])])

    expect(launch.phase.value).toBe('started-detached')
    expect(launch.state.value.launchedDwarfId).toBeNull()
  })

  it('carries a refused detached launch back with main’s own reason', async () => {
    const { launch } = await ready('codex', {
      launchAgent: vi.fn().mockResolvedValue({
        launched: false,
        provider: 'codex',
        error: 'Codex CLI is not installed on this machine.'
      })
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBe('Codex CLI is not installed on this machine.')
  })

  it('says the bridge is down for a detached launch too', async () => {
    const { launch } = await ready('codex', {
      launchAgent: vi.fn().mockRejectedValue(new Error('bridge down'))
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBeTruthy()
  })
})

describe('watching for the dwarf the launch started', () => {
  async function launched() {
    stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('claude')
    launch.setPrompt('dig the east gallery')
    await launch.submit()
    return launch
  }

  it('hands over to the MessagePanel on the dwarf carrying its own prompt', async () => {
    const launch = await launched()

    launch.observe([mineWith([heldDwarf('claude:sess-9', 'dig the east gallery')])])

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe('claude:sess-9')
  })

  it('keeps waiting while only unrelated sessions turn up', async () => {
    const launch = await launched()

    launch.observe([mineWith([heldDwarf('claude:sess-8', 'shore the north wall')])])

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  it('looks only in the mine the launch was made from', async () => {
    const launch = await launched()
    const elsewhere: Mine = {
      ...mineWith([heldDwarf('claude:sess-9', 'dig the east gallery')]),
      id: 'mine-2'
    }

    launch.observe([elsewhere])

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  it('adopts nobody when no launch is in flight', async () => {
    stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)

    launch.observe([mineWith([heldDwarf('claude:sess-9', 'dig the east gallery')])])

    expect(launch.state.value.launchedDwarfId).toBeNull()
  })
})
