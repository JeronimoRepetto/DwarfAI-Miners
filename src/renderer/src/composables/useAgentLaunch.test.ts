// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OTHER_CHOICE } from '../lib/launch/launchState'
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
    // #239. Same reason listAgentProviders is named here rather than per
    // test: an awaited member resolving undefined becomes an unhandled
    // rejection only the full suite catches.
    listAgentModels: vi.fn().mockResolvedValue({ catalogs: [] }),
    launchHeldSession: vi.fn().mockResolvedValue({ launched: true }),
    // The detached channel answers with the receipt main opened for this
    // launch (#191) — never a dwarf id, which is not known at that moment.
    launchAgent: vi.fn().mockResolvedValue({
      launched: true,
      provider: 'codex',
      launchId: 'receipt:1'
    }),
    // The third launch channel (#194). Named here rather than per test for the
    // reason this whole stub exists: an awaited member resolving undefined
    // becomes an unhandled rejection only the full suite catches.
    launchHostedProcess: vi.fn().mockResolvedValue({ launched: true }),
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

/**
 * A dwarf main has PROVED to be one of this panel's own detached launches
 * (#191) — no conversation, because a detached session hands the panel none,
 * and the receipt instead.
 */
function launchedDwarf(id: string, launchId: string): Dwarf {
  return defaultDwarf({ id, name: id, sessionId: id, launchId })
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

  /*
   * #239. Asked alongside listAgentProviders, on the same per-open cadence —
   * see the composable's own note on why that beats asking per keystroke.
   */
  it('asks main for each provider’s own model catalogue too', async () => {
    const catalogs = [
      {
        provider: 'claude' as const,
        models: [{ value: 'claude-sonnet-5', label: 'Sonnet' }],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: 'provider' as const
      }
    ]
    const api = stubApi({ listAgentModels: vi.fn().mockResolvedValue({ catalogs }) })
    const { open, choose, modelPicker } = useAgentLaunch()

    await open(MINE)
    choose('claude')

    expect(api.listAgentModels).toHaveBeenCalledOnce()
    expect(modelPicker.value).toEqual({
      visible: true,
      models: catalogs[0]!.models,
      disabled: false,
      note: null
    })
  })

  it('opens with no catalogues when the bridge cannot answer, rather than failing to open', async () => {
    stubApi({ listAgentModels: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { open, choose, modelPicker } = useAgentLaunch()

    await open(MINE)
    choose('claude')

    expect(modelPicker.value.visible).toBe(true)
    expect(modelPicker.value.disabled).toBe(true)
  })

  it('forgets the model catalogues when it closes', async () => {
    stubApi({
      listAgentModels: vi.fn().mockResolvedValue({
        catalogs: [
          { provider: 'claude' as const, models: [], efforts: [], source: 'provider' as const }
        ]
      })
    })
    const { open, close, choose, modelPicker } = useAgentLaunch()
    await open(MINE)
    choose('claude')

    close()
    choose('claude')

    // catalogs is empty again, which reads as "this provider named none" —
    // the same shape as a provider main could not ask at all.
    expect(modelPicker.value.models).toEqual([])
    expect(modelPicker.value.disabled).toBe(true)
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

  /*
   * #239. The model/effort row under the composer, forwarded on submit —
   * absent when untouched (already pinned above, since the object there
   * carries no `model`/`effort` key at all), present when chosen.
   */
  it('carries a chosen model, effort and permission mode to a held launch', async () => {
    const { api, launch } = await ready()
    launch.setModel('claude-sonnet-5')
    launch.setEffort('xhigh')
    launch.setPermissionMode('plan')

    await launch.submit()

    expect(api.launchHeldSession).toHaveBeenCalledWith({
      mineId: MINE,
      provider: 'claude',
      prompt: 'dig the east gallery',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
      permissionMode: 'plan'
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
   * ## This test was REPLACED for #194
   *
   * It used to be "refuses a custom command with the stated reason and starts
   * nothing", and it pinned `OTHER_NOT_LAUNCHABLE`: the #168 ruling that no
   * engine takes a command, so Enter says why and starts nothing. The
   * maintainer reversed that ruling on 2026-09-04 — the panel is the process's
   * stdio, so the panel is what observes it — and the constant is gone from
   * providerChips.ts with its whole argument.
   *
   * The case it covered is still covered, on the other side: Enter on Other
   * reaches the bridge now, and what it must NOT do is reach either of the
   * other two channels. Starting a Claude session for a command somebody typed
   * instead of Claude was the worse outcome the refusal existed to prevent, and
   * it still is.
   */
  it('starts a custom command down the hosted channel and no other', async () => {
    const api = stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('  lalolanda --once  ')
    launch.commit()
    launch.setPrompt('  dig the east gallery  ')

    await launch.submit()

    expect(api.launchHostedProcess).toHaveBeenCalledWith({
      mineId: MINE,
      // The committed command, trimmed exactly as commitCommand left it — the
      // panel sends the string and main decides what program that is.
      command: 'lalolanda --once',
      prompt: 'dig the east gallery'
    })
    expect(api.launchHeldSession).not.toHaveBeenCalled()
    expect(api.launchAgent).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBeNull()
  })

  /*
   * The one thing the panel must not do with a command it cannot run: swallow
   * the answer. #194 was reported as "it froze", which was a refusal nobody
   * could see, so main's own reason has to reach the panel intact.
   */
  it('shows main’s own reason when the command could not be started', async () => {
    const api = stubApi({
      launchHostedProcess: vi
        .fn()
        .mockResolvedValue({ launched: false, error: 'That command has no shell to run in.' })
    })
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda | tee log')
    launch.commit()
    launch.setPrompt('dig')

    await launch.submit()

    expect(api.launchHostedProcess).toHaveBeenCalledOnce()
    expect(launch.state.value.error).toBe('That command has no shell to run in.')
    // Back in the Add state with the typing intact, so a retry costs nothing.
    expect(launch.state.value.prompt).toBe('dig')
  })

  /*
   * No new phase for a hosted launch, which is the test of the wire shape
   * (#194): main seeds a hosted process's conversation with the prompt exactly
   * as the held registry seeds a session's, so the SAME receipt adopts it and
   * the panel reaches the MessagePanel through the path it already had.
   */
  it('waits for its dwarf and adopts it by the receipt a held launch uses', async () => {
    stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda')
    launch.commit()
    launch.setPrompt('dig the east gallery')

    await launch.submit()
    expect(launch.phase.value).toBe('submitted-spawning')

    launch.observe([mineWith([heldDwarf('hosted:1', 'dig the east gallery')])])

    expect(launch.state.value.launchedDwarfId).toBe('hosted:1')
    expect(launch.phase.value).toBe('message-panel')
    // Never the detached terminal state: that one says the panel is not
    // watching, and here it is.
    expect(launch.state.value.detached).toBe(false)
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
   * #239. Model and effort travel to the detached channel too — Codex's own
   * launch args carry them (buildCodexLaunchArgs, main-side). Permission mode
   * does not: the row hides it for Codex in the first place (permissionsVisible
   * is held-Claude-only), so there is nothing here to forward.
   */
  it('carries a chosen model and effort to a detached launch', async () => {
    const { api, launch } = await ready('codex')
    launch.setModel('gpt-5.6-sol')
    launch.setEffort('high')

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith({
      mineId: MINE,
      provider: 'codex',
      prompt: 'dig the east gallery',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })
  })

  /*
   * AMENDED for #191 (was: "stops on started-detached instead of waiting for a
   * dwarf it cannot recognise"). The state it lands in is unchanged and so is
   * every assertion; what the old name claimed — that this is where a detached
   * launch ends — is what #191 reversed. It now WAITS here, for main's receipt
   * rather than for words it could never read.
   */
  it('lands on started-detached with main’s receipt and no dwarf claimed', async () => {
    const { launch } = await ready('codex')

    await launch.submit()

    expect(launch.phase.value).toBe('started-detached')
    expect(launch.state.value.launchedDwarfId).toBeNull()
    expect(launch.state.value.error).toBeNull()
    expect(launch.state.value.launchId).toBe('receipt:1')
  })

  /*
   * The distinction the receipt exists to keep. A detached session's own words
   * are not on the wire at all, so a dwarf whose conversation happens to match
   * proves nothing — only main, which read that session's transcript against
   * the prompt it sent, can say which dwarf this launch became.
   */
  it('never adopts a dwarf for a detached launch, however well its words match', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([heldDwarf('codex:sess-9', 'dig the east gallery')])])

    expect(launch.phase.value).toBe('started-detached')
    expect(launch.state.value.launchedDwarfId).toBeNull()
  })

  /*
   * #191's whole point. Add > Codex started the session, the dwarf appeared,
   * replied and left, and the Add Panel still read "the session started" with
   * the prompt sitting in it. It hands over now.
   */
  it('hands over to the MessagePanel on the dwarf carrying its receipt', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([launchedDwarf('codex:sess-9', 'receipt:1')])])

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe('codex:sess-9')
  })

  /*
   * The session that finished before the poll first drew it — the case the
   * issue reports, where the reply had already landed. The panel opens on the
   * ended dwarf all the same, and the MessagePanel draws the ended state with
   * the transcript it reads on its own channel.
   */
  it('hands over to a dwarf whose session had already ended', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([
      mineWith([{ ...launchedDwarf('codex:sess-9', 'receipt:1'), status: 'leaving' }])
    ])

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe('codex:sess-9')
  })

  it('ignores a dwarf carrying somebody else’s receipt', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([launchedDwarf('codex:sess-8', 'receipt:2')])])

    expect(launch.phase.value).toBe('started-detached')
  })

  /*
   * A launch main opened no receipt for is where #168's original reading still
   * holds: the session started and nothing can prove which dwarf it became, so
   * the panel says that and adopts nobody.
   */
  it('waits without adopting when main opened no receipt', async () => {
    const { launch } = await ready('codex', {
      launchAgent: vi.fn().mockResolvedValue({ launched: true, provider: 'codex' })
    })
    await launch.submit()

    launch.observe([mineWith([launchedDwarf('codex:sess-9', 'receipt:1')])])

    expect(launch.state.value.launchId).toBeNull()
    expect(launch.phase.value).toBe('started-detached')
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
