// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OTHER_CHOICE } from '../lib/launch/launchState'
import { OTHER_NOT_BUILT } from '../lib/launch/providerChips'
import { defaultDwarf, defaultMine } from '../testing/factories'
import type { Dwarf, Mine } from '../types'
import { useAgentLaunch } from './useAgentLaunch'

const MINE = 'mine-1'
const CLAUDE = { provider: 'claude' as const, installed: true, launchable: true }
const CODEX = {
  provider: 'codex' as const,
  installed: true,
  launchable: false,
  reason: 'Only Claude can be started from the panel today.'
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
    expect(launch.state.value.error).toBe(OTHER_NOT_BUILT)
  })

  it('refuses a detected provider it cannot start, repeating main’s reason', async () => {
    const api = stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('codex')
    launch.setPrompt('dig')

    await launch.submit()

    expect(api.launchHeldSession).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBe(CODEX.reason)
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
