import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DwarfAiMinersApi } from './index'

/**
 * The preload runs `contextBridge.exposeInMainWorld` at import time, so the
 * whole electron surface is faked before the module loads and the exposed api
 * object is captured for inspection. What is under test is the CONTRACT: the
 * exact channel each member speaks on, the payload it forwards, and that the
 * value handed back to the renderer is the main process's verdict untouched.
 */
const exposed = new Map<string, unknown>()
const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
const send = vi.fn()
/*
 * AMENDED for #162 (was: two bare inline spies in the mock factory below). Two of the new message-panel members are
 * SUBSCRIPTIONS, and what has to be asserted about one is the channel it
 * listens on plus the wrapper it hands to ipcRenderer — so the two spies have
 * to be reachable from the tests. No existing assertion changed.
 */
const on = vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>()
const removeListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => send(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      removeListener(channel, listener)
  }
}))

let api: DwarfAiMinersApi

beforeAll(async () => {
  await import('./index')
  api = exposed.get('api') as DwarfAiMinersApi
})

describe('preload always-on-top contract', () => {
  it('exposes the pin surface next to the existing members instead of replacing them', () => {
    expect(typeof api.getAlwaysOnTop).toBe('function')
    expect(typeof api.setAlwaysOnTop).toBe('function')
    // Guard against an accidental surface rewrite: the pre-existing members
    // must still be there.
    expect(typeof api.hidePanel).toBe('function')
    expect(typeof api.getMines).toBe('function')
    expect(typeof api.onMinesUpdated).toBe('function')
    expect(typeof api.activateDwarf).toBe('function')
    expect(typeof api.sendDwarfText).toBe('function')
    expect(typeof api.kickDwarf).toBe('function')
    expect(typeof api.retireDwarf).toBe('function')
    expect(typeof api.getToggleShortcut).toBe('function')
    expect(typeof api.setToggleShortcut).toBe('function')
    expect(typeof api.getAppBuild).toBe('function')
    expect(typeof api.declareMine).toBe('function')
    expect(typeof api.undeclareMine).toBe('function')
    expect(typeof api.queryProjects).toBe('function')
    expect(typeof api.answerDwarfQuestion).toBe('function')
  })

  it('asks for the current state on the panel:getAlwaysOnTop channel with no payload', async () => {
    invoke.mockResolvedValueOnce(true)
    await expect(api.getAlwaysOnTop()).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('panel:getAlwaysOnTop')
  })

  it('requests a toggle on panel:setAlwaysOnTop with exactly the desired boolean', async () => {
    invoke.mockResolvedValueOnce(false)
    await api.setAlwaysOnTop(false)
    expect(invoke).toHaveBeenLastCalledWith('panel:setAlwaysOnTop', false)
  })

  it('hands back the main-process verdict, not the wish', async () => {
    // Main may refuse (platform ignored the hint): the renderer must receive
    // that real state so it never renders an always-on-top it does not have.
    invoke.mockResolvedValueOnce(true)
    await expect(api.setAlwaysOnTop(false)).resolves.toBe(true)
  })
})

describe('preload panel-toggle shortcut contract', () => {
  it('asks for the current shortcut on the shortcut:get channel with no payload', async () => {
    const state = { accelerator: 'Control+Alt+Shift+P', registered: true, platform: 'win32' }
    invoke.mockResolvedValueOnce(state)
    await expect(api.getToggleShortcut()).resolves.toEqual(state)
    expect(invoke).toHaveBeenLastCalledWith('shortcut:get')
  })

  it('requests a change on shortcut:set with exactly the recorded accelerator', async () => {
    invoke.mockResolvedValueOnce({
      accelerator: 'Control+Alt+M',
      registered: true,
      platform: 'win32'
    })
    await api.setToggleShortcut('Control+Alt+M')
    expect(invoke).toHaveBeenLastCalledWith('shortcut:set', 'Control+Alt+M')
  })

  it('hands back the main-process verdict, not the requested combination', async () => {
    // The combination was taken, so main kept the old one: the renderer must
    // receive THAT, or the settings panel would show a dead shortcut as live.
    const reverted = {
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      error: 'Ctrl + Alt + M is already in use by another application.',
      platform: 'win32'
    }
    invoke.mockResolvedValueOnce(reverted)
    await expect(api.setToggleShortcut('Control+Alt+M')).resolves.toEqual(reverted)
  })

  it('collapses a non-string payload to a string before it crosses the bridge', async () => {
    // Same discipline as setAlwaysOnTop: main's boundary check should only ever
    // have to reason about a clean string.
    invoke.mockResolvedValueOnce({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32'
    })
    await (api.setToggleShortcut as unknown as (value: unknown) => Promise<unknown>)(42)
    expect(invoke).toHaveBeenLastCalledWith('shortcut:set', '')
  })
})

/**
 * Retirement (#46) is one-way on purpose: the renderer reports an observation
 * and main decides. The departure comes back through the ordinary poll, so
 * there is no verdict here to wait for.
 */
describe('preload dwarf retirement contract', () => {
  it('reports a retirement on the dwarf:retire channel without asking for an answer', () => {
    expect(api.retireDwarf('claude:s1')).toBeUndefined()
    expect(send).toHaveBeenLastCalledWith('dwarf:retire', 'claude:s1')
  })

  it('collapses a non-string id to an empty string before it crosses the bridge', () => {
    // Same discipline as setToggleShortcut: main's boundary check should only
    // ever have to reason about a clean string.
    ;(api.retireDwarf as unknown as (value: unknown) => void)(42)
    expect(send).toHaveBeenLastCalledWith('dwarf:retire', '')
  })
})

/**
 * Which build is running (#79). Read-only and payload-free: main is the only
 * process that can answer, because only it can ask Electron, and the renderer
 * has no second route to the answer with context isolation on.
 */
describe('preload app build contract', () => {
  it('asks for the running build on the app:build channel with no payload', async () => {
    const build = { version: '0.3.0', packaged: true }
    invoke.mockResolvedValueOnce(build)
    await expect(api.getAppBuild()).resolves.toEqual(build)
    expect(invoke).toHaveBeenLastCalledWith('app:build')
  })

  it('hands back main’s answer untouched, including that it is unpackaged', async () => {
    // The dev flag is the half of the answer the incident turned on; a bridge
    // that dropped or defaulted it would leave the panel unable to tell the
    // two builds apart, which is the whole defect.
    const build = { version: '0.3.0', packaged: false }
    invoke.mockResolvedValueOnce(build)
    await expect(api.getAppBuild()).resolves.toEqual(build)
  })
})

/**
 * Adding and removing a user-declared mine (#85). The folder picker is opened
 * in MAIN, so this side carries no path in either direction — it asks, and it
 * names a mine by the id both processes already agree on.
 */
describe('preload declared-mine contract', () => {
  it('asks for a mine on the mine:declare channel with no payload at all', async () => {
    const result = { outcome: 'added', mineId: 'mine:c:\\x\\adopted' }
    invoke.mockResolvedValueOnce(result)
    await expect(api.declareMine()).resolves.toEqual(result)
    expect(invoke).toHaveBeenLastCalledWith('mine:declare')
  })

  it('hands back a refusal and its reason rather than flattening it to nothing', async () => {
    // A control that silently does nothing reads as broken; the panel needs the
    // reason main gave it.
    const refused = { outcome: 'failed', reason: 'That folder could not be saved as a mine.' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.declareMine()).resolves.toEqual(refused)
  })

  it('removes a mine on mine:undeclare by id, exactly as recorded', async () => {
    invoke.mockResolvedValueOnce({ outcome: 'removed' })
    await api.undeclareMine('mine:c:\\x\\adopted')
    expect(invoke).toHaveBeenLastCalledWith('mine:undeclare', 'mine:c:\\x\\adopted')
  })

  it('collapses a non-string id to an empty string before it crosses the bridge', async () => {
    // Same discipline as retireDwarf: main's boundary check should only ever
    // have to reason about a clean string.
    invoke.mockResolvedValueOnce({
      outcome: 'unchanged',
      reason: 'That mine is not one you added.'
    })
    await (api.undeclareMine as unknown as (value: unknown) => Promise<unknown>)(42)
    expect(invoke).toHaveBeenLastCalledWith('mine:undeclare', '')
  })

  it('hands back the outcome main decided, including a mine that only reverted', async () => {
    const reverted = { outcome: 'reverted' }
    invoke.mockResolvedValueOnce(reverted)
    await expect(api.undeclareMine('mine:c:\\x\\adopted')).resolves.toEqual(reverted)
  })
})

/**
 * Browsing every remembered project (#92). An object payload, so it crosses
 * uncoerced exactly as sendDwarfText's does — main owns the validation, and it
 * is main that has to reject a sort key it cannot run.
 */
describe('preload project-query contract', () => {
  const newest = { sortBy: 'addedAt', direction: 'desc' } as const

  it('asks on the projects:query channel with the query exactly as given', async () => {
    invoke.mockResolvedValueOnce({ answered: true, projects: [] })
    await api.queryProjects(newest)
    expect(invoke).toHaveBeenLastCalledWith('projects:query', newest)
  })

  it('carries the filters and the page across untouched', async () => {
    // Nothing is folded, trimmed or clamped here on purpose: the term is folded
    // with the normalizer that wrote the stored column, and the page is clamped
    // by the query builder, both in main. A bridge that pre-processed either
    // would be a second copy of a rule that has to match the database.
    const query = {
      ...newest,
      tier: 'gold',
      nameContains: '  Cafetería  ',
      limit: 25,
      offset: 50
    } as const
    invoke.mockResolvedValueOnce({ answered: true, projects: [] })
    await api.queryProjects(query)
    expect(invoke).toHaveBeenLastCalledWith('projects:query', query)
  })

  it('hands back the projects main found, live flag included', async () => {
    const answer = {
      answered: true,
      projects: [
        {
          id: 'mine:c:\\x\\smelter',
          path: 'C:\\x\\smelter',
          name: 'smelter',
          declared: false,
          addedAt: 1_000,
          live: true
        }
      ]
    }
    invoke.mockResolvedValueOnce(answer)
    await expect(api.queryProjects(newest)).resolves.toEqual(answer)
  })

  it('hands back a refusal and its reason rather than an empty list on its own', async () => {
    // The distinction that must survive the bridge: a browse showing nothing
    // because the database would not open is not a browse of no projects.
    const refused = { answered: false, projects: [], reason: 'The projects could not be read.' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.queryProjects(newest)).resolves.toEqual(refused)
  })
})

/**
 * Answering what a held session asked (#94, #125). The payload is rebuilt here
 * field by field, and the record entry by entry, because an answer releases a
 * tool call a live agent is blocked inside: what crosses must be string pairs
 * or nothing, so main's own check against the ask can refuse a shape without
 * ever having to reason about a coerced one.
 */
describe('preload question-answer contract', () => {
  const answer = {
    dwarfId: 'claude:s1',
    toolUseId: 'toolu_01',
    answers: { 'Which database?': 'Postgres' }
  }

  it('answers on the agent:answerQuestion channel, naming the dwarf and the ask', async () => {
    invoke.mockResolvedValueOnce({ answered: true })
    await api.answerDwarfQuestion(answer)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', answer)
  })

  it('collapses a non-string dwarf or tool-use id before it crosses the bridge', async () => {
    // Same discipline as retireDwarf: main's boundary check should only ever
    // have to reason about a clean string.
    invoke.mockResolvedValueOnce({ answered: false, error: 'That question is no longer open.' })
    await (api.answerDwarfQuestion as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 42,
      toolUseId: null,
      answers: {}
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', {
      dwarfId: '',
      toolUseId: '',
      answers: {}
    })
  })

  it('drops an answer value that is not a string rather than coercing it', async () => {
    // A coerced value would name an option nobody chose. Dropped, main sees an
    // answer that names no option for that question and refuses it — the right
    // end for a payload the user never gave.
    invoke.mockResolvedValueOnce({ answered: false, error: 'That question is no longer open.' })
    await (api.answerDwarfQuestion as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database?': 7, 'Which port?': '5432' }
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', {
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which port?': '5432' }
    })
  })

  it('hands back the refusal and its reason rather than a bare false', async () => {
    // The panel has to be able to say WHY an answer did not land — an ask that
    // has since been withdrawn reads nothing like a session nobody holds.
    const refused = { answered: false, error: 'That session is not one this panel is holding.' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.answerDwarfQuestion(answer)).resolves.toEqual(refused)
  })
})

/**
 * Deciding a permission prompt a held session raised (#203). Rebuilt field by
 * field, exactly as answerDwarfQuestion's payload is: `decision` is a closed
 * word main re-checks against DwarfPermissionDecision, so nothing this bridge
 * could not validate itself is allowed to ride across uncoerced.
 */
describe('preload permission-decision contract (#203)', () => {
  const request = { dwarfId: 'claude:s1', toolUseId: 'toolu_p1', decision: 'allow' as const }

  it('exposes the function beside answerDwarfQuestion', () => {
    expect(typeof api.answerDwarfPermission).toBe('function')
  })

  it('decides on the agent:answerPermission channel, naming the dwarf, the tool call and the decision', async () => {
    invoke.mockResolvedValueOnce({ answered: true })
    await api.answerDwarfPermission(request)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerPermission', request)
  })

  it('collapses a non-string dwarf id, tool-use id or decision before it crosses the bridge', async () => {
    // Same discipline as answerDwarfQuestion: main's boundary check should
    // only ever have to reason about clean strings, and an empty decision is
    // refused there rather than defaulted to one the user never chose.
    invoke.mockResolvedValueOnce({
      answered: false,
      error: 'That permission request is no longer open.'
    })
    await (api.answerDwarfPermission as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 42,
      toolUseId: null,
      decision: undefined
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerPermission', {
      dwarfId: '',
      toolUseId: '',
      decision: ''
    })
  })

  it('hands back the refusal and its reason rather than a bare false', async () => {
    const refused = { answered: false, error: 'That session is not one this panel is holding.' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.answerDwarfPermission(request)).resolves.toEqual(refused)
  })
})

describe('preload panel-layout contract (#90, #138)', () => {
  it('asks for the current layout on the panel:layout:get channel with no payload', async () => {
    const layout = { edge: 'right', expanded: false, mineOpen: false }
    invoke.mockResolvedValueOnce(layout)
    await expect(api.getPanelLayout()).resolves.toEqual(layout)
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:get')
  })

  it('collapses expanded and mineOpen to real booleans before they cross', async () => {
    invoke.mockResolvedValueOnce({ edge: 'right', expanded: true, mineOpen: false })
    await (api.setPanelLayout as unknown as (value: unknown) => Promise<unknown>)({
      expanded: 'yes',
      mineOpen: 1
    })
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:set', {
      expanded: false,
      mineOpen: false
    })
  })

  it('omits edge entirely when the caller (the rail toggle, a mine opening) does not name one', async () => {
    // Only the Settings position control may ever move the docked side; every
    // other caller must be structurally unable to nudge it by accident.
    invoke.mockResolvedValueOnce({ edge: 'right', expanded: true, mineOpen: false })
    await api.setPanelLayout({ expanded: true, mineOpen: false })
    const [, payload] = invoke.mock.calls.at(-1) ?? []
    expect(payload).not.toHaveProperty('edge')
  })

  it('forwards a real edge from the position control untouched', async () => {
    invoke.mockResolvedValueOnce({ edge: 'left', expanded: true, mineOpen: false })
    await api.setPanelLayout({ expanded: true, mineOpen: false, edge: 'left' })
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:set', {
      expanded: true,
      mineOpen: false,
      edge: 'left'
    })
  })

  it('drops an edge value no build recognizes rather than forwarding a guess', async () => {
    invoke.mockResolvedValueOnce({ edge: 'right', expanded: true, mineOpen: false })
    await (api.setPanelLayout as unknown as (value: unknown) => Promise<unknown>)({
      expanded: true,
      mineOpen: false,
      edge: 'top'
    })
    const [, payload] = invoke.mock.calls.at(-1) ?? []
    expect(payload).not.toHaveProperty('edge')
  })

  it('hands back the REAL layout main applied, never the wish', async () => {
    // A screen too narrow for the whole composition, or a docked edge the
    // window manager could not honor, must reach the renderer as a fact.
    const actual = { edge: 'right', expanded: true, mineOpen: true }
    invoke.mockResolvedValueOnce(actual)
    await expect(
      api.setPanelLayout({ expanded: true, mineOpen: false, edge: 'left' })
    ).resolves.toEqual(actual)
  })
})

describe('preload metrics-reset contract (#138)', () => {
  it('asks on the metrics:reset channel with no payload at all', async () => {
    // The typed confirmation lives entirely on the renderer side; nothing
    // about it crosses the bridge.
    invoke.mockResolvedValueOnce({ outcome: 'reset' })
    await expect(api.resetMetrics()).resolves.toEqual({ outcome: 'reset' })
    expect(invoke).toHaveBeenLastCalledWith('metrics:reset')
  })

  it('hands back a refusal and its reason rather than flattening it to nothing', async () => {
    const refused = {
      outcome: 'failed',
      reason: 'The metrics could not be reset. Nothing was deleted.'
    }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.resetMetrics()).resolves.toEqual(refused)
  })
})

describe('preload provider-availability contract (#86)', () => {
  it('asks on the agent:providers channel with no payload at all', async () => {
    // Nothing to send: the question is about this machine, and main is the
    // only side that can answer it.
    invoke.mockResolvedValueOnce({ providers: [] })
    await expect(api.listAgentProviders()).resolves.toEqual({ providers: [] })
    expect(invoke).toHaveBeenLastCalledWith('agent:providers')
  })

  it("hands back main's verdict untouched, refusals and reasons included", async () => {
    const answered = {
      providers: [
        { provider: 'claude', installed: true, launchable: true },
        {
          provider: 'codex',
          installed: true,
          launchable: false,
          reason: 'Only Claude can be started from the panel today.'
        }
      ]
    }
    invoke.mockResolvedValueOnce(answered)
    await expect(api.listAgentProviders()).resolves.toEqual(answered)
  })
})

describe('preload launch contract (#168)', () => {
  it('carries the chosen provider alongside the mine and the prompt', async () => {
    // Before #168 this channel took a mine and a prompt only, so the engine had
    // nothing to read and started `claude` whatever chip the user pressed.
    invoke.mockResolvedValueOnce({ launched: true, provider: 'codex' })
    await api.launchAgent({ mineId: 'mine-1', provider: 'codex', prompt: 'dig' })

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', {
      mineId: 'mine-1',
      provider: 'codex',
      prompt: 'dig'
    })
  })

  /*
   * The one coercion that must NOT be a fallback. Every other field here
   * collapses to a safe empty string, but a provider collapsed to a default
   * would start SOME agent for a name this build does not have — the exact
   * laundering #168 exists to stop. An unrecognised name crosses as '' and main
   * refuses the whole request, which is the only honest end for it.
   */
  it('collapses a provider this build does not know to nothing, never to a default', async () => {
    invoke.mockResolvedValueOnce({ launched: false, provider: 'none' })
    await api.launchAgent({
      mineId: 'mine-1',
      prompt: 'dig',
      ...({ provider: 'gemini' } as object)
    } as Parameters<typeof api.launchAgent>[0])

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', {
      mineId: 'mine-1',
      provider: '',
      prompt: 'dig'
    })
  })

  it('carries the chosen provider on the held channel too', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    expect(invoke).toHaveBeenLastCalledWith('agent:launchHeld', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig'
    })
  })

  it("hands back main's verdict untouched, provider and reason included", async () => {
    const refused = {
      launched: false,
      provider: 'codex',
      error: 'Codex CLI is not installed on this machine.'
    }
    invoke.mockResolvedValueOnce(refused)
    await expect(
      api.launchAgent({ mineId: 'mine-1', provider: 'codex', prompt: 'dig' })
    ).resolves.toEqual(refused)
  })
})

describe('preload mine-history contract (#192)', () => {
  it('asks on the mine:history channel by mine id, exactly as given', async () => {
    invoke.mockResolvedValueOnce({ readable: true, speakers: [] })
    await api.getMineHistory('mine:c:\\x\\anvil')
    expect(invoke).toHaveBeenLastCalledWith('mine:history', 'mine:c:\\x\\anvil')
  })

  it('collapses a non-string id to an empty string before it crosses the bridge', async () => {
    invoke.mockResolvedValueOnce({ readable: false, speakers: [] })
    await api.getMineHistory(42 as unknown as string)
    expect(invoke).toHaveBeenLastCalledWith('mine:history', '')
  })

  it("hands back main's answer untouched, unreadable included", async () => {
    // `readable: false` is a different fact from "nobody has spoken here", and
    // the bridge must not flatten one into the other.
    invoke.mockResolvedValueOnce({ readable: false, speakers: [] })
    await expect(api.getMineHistory('mine:nowhere')).resolves.toEqual({
      readable: false,
      speakers: []
    })
  })
})

/**
 * The panel telling main which observed dwarf it has open (#196), so the poll
 * can carry that dwarf's feed with its snapshot. One-way, like retireDwarf:
 * there is no verdict to wait for.
 */
describe('preload watched-dwarf-feed contract (#196)', () => {
  it('reports the watched dwarf on the panel:watchDwarfFeed channel', () => {
    expect(api.setWatchedDwarf('claude:s1')).toBeUndefined()
    expect(send).toHaveBeenLastCalledWith('panel:watchDwarfFeed', 'claude:s1')
  })

  it('reports null to clear the watch, as a real answer rather than a malformed one', () => {
    api.setWatchedDwarf(null)
    expect(send).toHaveBeenLastCalledWith('panel:watchDwarfFeed', null)
  })

  it('collapses anything that is not a string to null before it crosses the bridge', () => {
    ;(api.setWatchedDwarf as unknown as (value: unknown) => void)(42)
    expect(send).toHaveBeenLastCalledWith('panel:watchDwarfFeed', null)
  })
})

/**
 * The panel asking a held session what its own context looks like (#96).
 *
 * One-way, exactly like setWatchedDwarf and for the same reason: the reading
 * is a control request main makes on a stream it owns, and the answer arrives
 * on the next `minesUpdated` snapshot like every other change — so there is
 * no verdict here to wait for. Named by DWARF, never by session, because that
 * is what the panel has and main resolves the rest.
 */
describe('preload session-telemetry refresh contract (#96)', () => {
  it('asks for the dwarf on the dwarf:refreshTelemetry channel', () => {
    expect(api.refreshDwarfTelemetry('claude:s1')).toBeUndefined()
    expect(send).toHaveBeenLastCalledWith('dwarf:refreshTelemetry', 'claude:s1')
  })

  it("collapses anything that is not a string to '' before it crosses the bridge", () => {
    // The same discipline every other id here holds: main's boundary check
    // only ever reasons about a string, and refuses an empty one.
    ;(api.refreshDwarfTelemetry as unknown as (value: unknown) => void)(42)
    expect(send).toHaveBeenLastCalledWith('dwarf:refreshTelemetry', '')
  })
})
/**
 * The message panel's own window (#162).
 *
 * Two renderers read this one bridge now, and the members below are the whole
 * of what they say to each other: what the panel shows, how tall it is, and
 * the delivery verdicts only the panel window writes. Main is between them
 * both ways — neither window ever talks to the other.
 */
describe('preload message-panel contract (#162)', () => {
  const OPEN = { surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' } as const

  it('exposes the whole surface beside the members that were already there', () => {
    expect(typeof api.getMessagePanel).toBe('function')
    expect(typeof api.setMessagePanel).toBe('function')
    expect(typeof api.onMessagePanel).toBe('function')
    expect(typeof api.setMessagePanelHeight).toBe('function')
    expect(typeof api.reportDwarfDelivery).toBe('function')
    expect(typeof api.onDwarfDeliveryReport).toBe('function')
  })

  it('asks for the current state on the panel:message:get channel with no payload', async () => {
    invoke.mockResolvedValueOnce(OPEN)
    await expect(api.getMessagePanel()).resolves.toEqual(OPEN)
    expect(invoke).toHaveBeenLastCalledWith('panel:message:get')
  })

  it('rebuilds the state field by field on panel:message:set', async () => {
    invoke.mockResolvedValueOnce(OPEN)
    await api.setMessagePanel(OPEN)
    expect(invoke).toHaveBeenLastCalledWith('panel:message:set', {
      surface: 'message',
      mineId: 'mine:a',
      dwarfId: 'claude:s1'
    })
  })

  it('collapses a non-string id to an empty string before it crosses the bridge', async () => {
    invoke.mockResolvedValueOnce(OPEN)
    await api.setMessagePanel({
      surface: 'message',
      mineId: 7,
      dwarfId: null
    } as unknown as Parameters<typeof api.setMessagePanel>[0])
    expect(invoke).toHaveBeenLastCalledWith('panel:message:set', {
      surface: 'message',
      mineId: '',
      dwarfId: ''
    })
  })

  it('crosses an unrecognised surface as nothing, so main refuses rather than guessing', async () => {
    // The same ruling launchAgent's provider carries (#168): a surface
    // collapsed to a default would be the bridge deciding what the panel
    // shows — 'none' above all, which would CLOSE a window nobody asked to
    // close.
    invoke.mockResolvedValueOnce(OPEN)
    await api.setMessagePanel({
      surface: 'history',
      mineId: 'mine:a',
      dwarfId: ''
    } as unknown as Parameters<typeof api.setMessagePanel>[0])
    expect(invoke).toHaveBeenLastCalledWith('panel:message:set', {
      surface: '',
      mineId: 'mine:a',
      dwarfId: ''
    })
  })

  it('hands back the REAL state main applied, never the wish', async () => {
    // Main creates, moves, shows and hides an actual window off the back of
    // this, and it may answer with something else entirely — the panel closed
    // by the other window between the click and the call.
    const closed = { surface: 'none', mineId: '', dwarfId: '' }
    invoke.mockResolvedValueOnce(closed)
    await expect(api.setMessagePanel(OPEN)).resolves.toEqual(closed)
  })

  it('subscribes to main’s push on panel:message:changed, and unsubscribes', () => {
    const listener = vi.fn()
    const stop = api.onMessagePanel(listener)
    expect(on).toHaveBeenLastCalledWith('panel:message:changed', expect.any(Function))
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, state: unknown) => void
    wrapped(null, OPEN)
    // The renderer never sees the IpcRendererEvent: it is the state that is
    // the message.
    expect(listener).toHaveBeenCalledWith(OPEN)
    stop()
    expect(removeListener).toHaveBeenLastCalledWith('panel:message:changed', wrapped)
  })

  it('reports the measured height on panel:message:height as a number', () => {
    api.setMessagePanelHeight(235)
    expect(send).toHaveBeenLastCalledWith('panel:message:height', 235)
  })

  it('crosses anything that is not a number as one main refuses', () => {
    // Never 0 and never a default: both are heights a window could be given,
    // and a bridge that invented one would resize the panel off a payload
    // nobody could read.
    api.setMessagePanelHeight('235' as unknown as number)
    expect(send).toHaveBeenLastCalledWith('panel:message:height', Number.NaN)
  })

  it('reports the delivery verdicts on panel:message:delivery, uncoerced', () => {
    // Forwarded whole for the reason queryProjects is: a nested record cannot
    // be collapsed to a safe default the way a stray string can, so main
    // validates it and refuses what it cannot read (see
    // parseDwarfDeliveryReport).
    const report = { send: { 'claude:s1': { phase: 'delivered' } }, kick: {} }
    api.reportDwarfDelivery(report as unknown as Parameters<typeof api.reportDwarfDelivery>[0])
    expect(send).toHaveBeenLastCalledWith('panel:message:delivery', report)
  })

  it('subscribes to the relayed verdicts on panel:message:delivery:changed', () => {
    const listener = vi.fn()
    const report = { send: {}, kick: { 'claude:s1': { phase: 'reacted' } } }
    const stop = api.onDwarfDeliveryReport(listener)
    expect(on).toHaveBeenLastCalledWith('panel:message:delivery:changed', expect.any(Function))
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, report)
    expect(listener).toHaveBeenCalledWith(report)
    stop()
    expect(removeListener).toHaveBeenLastCalledWith('panel:message:delivery:changed', wrapped)
  })
})
