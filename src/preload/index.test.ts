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
 * The features that ship hidden (#635). Read-only and payload-free, like the
 * build: main resolves the flags from its configuration layers once, and the
 * renderer only ever draws what main answered.
 */
describe('preload feature flags contract', () => {
  it('asks for the flags on the app:features channel with no payload', async () => {
    const flags = { guildAreasEnabled: true }
    invoke.mockResolvedValueOnce(flags)
    await expect(api.getFeatureFlags()).resolves.toEqual(flags)
    expect(invoke).toHaveBeenLastCalledWith('app:features')
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

  /*
   * ADDED for #635 (PO decision 2026-09-28, held free-text answers): a held walk's steps answered
   * in the person's own words ride beside the labels as `ownWords`, rebuilt from string pairs like
   * `answers`. The bridge once rebuilt `answers` alone, so the words never reached main and the
   * walk was refused as unanswered — found in the built app, where no test could see it.
   */
  it('carries the own-words record beside the labels, string pairs only', async () => {
    invoke.mockResolvedValueOnce({ answered: true })
    await (api.answerDwarfQuestion as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Run the tests after?': 'Yes' },
      ownWords: { 'Which database?': 'MariaDB please', 'Which port?': 5432 }
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', {
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Run the tests after?': 'Yes' },
      ownWords: { 'Which database?': 'MariaDB please' }
    })
  })

  it('sends no own-words record when the answer carries none', async () => {
    invoke.mockResolvedValueOnce({ answered: true })
    await api.answerDwarfQuestion(answer)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', answer)
  })

  it('hands back the refusal and its reason rather than a bare false', async () => {
    // The panel has to be able to say WHY an answer did not land — an ask that
    // has since been withdrawn reads nothing like a session nobody holds.
    const refused = { answered: false, error: 'That session is not one this panel is holding.' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.answerDwarfQuestion(answer)).resolves.toEqual(refused)
  })

  /*
   * The person's own words, for the picker's "Other" row (#481). The second
   * form this channel carries, and it crosses as ONE field: the bridge sends
   * the form it was given and never both, so a payload can only ever say one
   * thing about what was answered.
   */
  it('carries a typed answer as its own field, with no record beside it', async () => {
    invoke.mockResolvedValueOnce({ answered: true })
    await api.answerDwarfQuestion({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'neither — put it in Redis'
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', {
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'neither — put it in Redis'
    })
  })

  it('drops a typed answer that is not a string rather than coercing it', async () => {
    // A coerced one would hand the agent a sentence the person never wrote.
    // Dropped, the payload carries neither form and main refuses its shape.
    invoke.mockResolvedValueOnce({ answered: false, error: 'That answer could not be delivered.' })
    await (api.answerDwarfQuestion as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 42
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', {
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01'
    })
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

/*
 * AMENDED for #635, once here: `expanded` left the layout with the rail (PO ruling 2026-09-27)
 * and `dockOpen` took its place, so every payload below carries `mineOpen` and `dockOpen`.
 */
describe('preload panel-layout contract (#90, #138)', () => {
  it('asks for the current layout on the panel:layout:get channel with no payload', async () => {
    const layout = { edge: 'right', mineOpen: false, dockOpen: false }
    invoke.mockResolvedValueOnce(layout)
    await expect(api.getPanelLayout()).resolves.toEqual(layout)
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:get')
  })

  it('collapses mineOpen and dockOpen to real booleans before they cross', async () => {
    invoke.mockResolvedValueOnce({ edge: 'right', mineOpen: false, dockOpen: false })
    await (api.setPanelLayout as unknown as (value: unknown) => Promise<unknown>)({
      mineOpen: 1,
      dockOpen: 'yes'
    })
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:set', {
      mineOpen: false,
      dockOpen: false
    })
  })

  it('omits edge entirely when the caller (a mine or the dock opening) does not name one', async () => {
    // Only the Settings position control may ever move the docked side; every
    // other caller must be structurally unable to nudge it by accident.
    invoke.mockResolvedValueOnce({ edge: 'right', mineOpen: false, dockOpen: false })
    await api.setPanelLayout({ mineOpen: false, dockOpen: true })
    const [, payload] = invoke.mock.calls.at(-1) ?? []
    expect(payload).not.toHaveProperty('edge')
  })

  it('forwards a real edge from the position control untouched', async () => {
    invoke.mockResolvedValueOnce({ edge: 'left', mineOpen: false, dockOpen: false })
    await api.setPanelLayout({ mineOpen: false, dockOpen: true, edge: 'left' })
    expect(invoke).toHaveBeenLastCalledWith('panel:layout:set', {
      mineOpen: false,
      dockOpen: true,
      edge: 'left'
    })
  })

  it('drops an edge value no build recognizes rather than forwarding a guess', async () => {
    invoke.mockResolvedValueOnce({ edge: 'right', mineOpen: false, dockOpen: false })
    await (api.setPanelLayout as unknown as (value: unknown) => Promise<unknown>)({
      mineOpen: false,
      dockOpen: false,
      edge: 'top'
    })
    const [, payload] = invoke.mock.calls.at(-1) ?? []
    expect(payload).not.toHaveProperty('edge')
  })

  it('hands back the REAL layout main applied, never the wish', async () => {
    // A screen too narrow for the whole composition, or a docked edge the
    // window manager could not honor, must reach the renderer as a fact.
    const actual = { edge: 'right', mineOpen: true, dockOpen: false }
    invoke.mockResolvedValueOnce(actual)
    await expect(
      api.setPanelLayout({ mineOpen: false, dockOpen: false, edge: 'left' })
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

describe('preload model-catalogue contract (#239)', () => {
  it('asks on the agent:models channel with no payload at all', async () => {
    invoke.mockResolvedValueOnce({ catalogs: [] })
    await expect(api.listAgentModels()).resolves.toEqual({ catalogs: [] })
    expect(invoke).toHaveBeenLastCalledWith('agent:models')
  })

  it("hands back main's verdict untouched, every provider's source included", async () => {
    const answered = {
      catalogs: [
        {
          provider: 'claude',
          models: [{ value: 'claude-sonnet-5', label: 'Sonnet' }],
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          source: 'provider'
        },
        {
          provider: 'codex',
          models: [{ value: 'gpt-5.6-sol' }],
          efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          source: 'history'
        },
        { provider: 'antigravity', models: [], efforts: [], source: 'none' }
      ]
    }
    invoke.mockResolvedValueOnce(answered)
    await expect(api.listAgentModels()).resolves.toEqual(answered)
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

  /*
   * #239. Model and effort are the first fields on either launch channel that
   * are genuinely OPTIONAL rather than collapsing to a safe default: absent
   * has to stay absent, because a '' crossing the bridge would be a real
   * instruction main's own boundary would then have to refuse (see
   * parseLaunchTuning) rather than the "leave it to the CLI" this field means
   * when it is missing.
   */
  it('carries a model and an effort when the caller named them', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'claude' })
    await api.launchAgent({
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      model: 'sonnet',
      effort: 'xhigh'
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      model: 'sonnet',
      effort: 'xhigh'
    })
  })

  it('crosses no model or effort at all when the caller named neither, rather than empty strings', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'claude' })
    await api.launchAgent({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('model' in sent).toBe(false)
    expect('effort' in sent).toBe(false)
  })

  it('carries a model and an effort on the held channel too', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      model: 'sonnet',
      effort: 'max'
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launchHeld', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      model: 'sonnet',
      effort: 'max'
    })
  })

  it('crosses no model or effort on the held channel when the caller named neither', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('model' in sent).toBe(false)
    expect('effort' in sent).toBe(false)
  })

  /*
   * #239. Held-only, exactly as HeldSessionLaunchRequest.permissionMode is —
   * launchAgent carries no such field, and the bridge must not invent one for
   * it.
   *
   * AMENDED for #635 (PO decision 2026-09-28, Codex permission modes; was: the
   * sentence above, unqualified). launchAgent now carries a permission mode
   * of its own, Codex's vocabulary rather than the Agent SDK's — see the three
   * tests after the next one. The two tests here are unchanged.
   */
  it('carries a permission mode on the held channel when the caller named one', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      permissionMode: 'plan'
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launchHeld', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      permissionMode: 'plan'
    })
  })

  it('crosses no permission mode when the caller named none, rather than an empty string', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('permissionMode' in sent).toBe(false)
  })

  /*
   * #635 (PO decision 2026-09-28). A detached Codex launch now carries a
   * permission mode of its own. The bridge rebuilds this request field by
   * field, so a field it forgot would never reach main — the exact loss #671
   * found on another field.
   */
  it('carries a Codex permission mode on the launch channel when the caller named one', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'codex' })
    await api.launchAgent({
      mineId: 'mine-1',
      provider: 'codex',
      prompt: 'dig',
      permissionMode: 'read-only'
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', {
      mineId: 'mine-1',
      provider: 'codex',
      prompt: 'dig',
      permissionMode: 'read-only'
    })
  })

  it('crosses no permission mode on the launch channel when the caller named none', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'codex' })
    await api.launchAgent({ mineId: 'mine-1', provider: 'codex', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('permissionMode' in sent).toBe(false)
  })

  it('drops a non-string permission mode rather than forwarding it', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'codex' })
    await api.launchAgent({
      mineId: 'mine-1',
      provider: 'codex',
      prompt: 'dig',
      ...({ permissionMode: { sandbox: 'danger-full-access' } } as object)
    } as Parameters<typeof api.launchAgent>[0])

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('permissionMode' in sent).toBe(false)
  })

  /* --- MCP subtask delegation: the routedByJev marker (#511) — one block, appended --- */
  it('carries routedByJev on the launch channel when a Jev decision was applied', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'claude' })
    await api.launchAgent({
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      routedByJev: true
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      routedByJev: true
    })
  })

  it('crosses no routedByJev when the caller did not name it, rather than false', async () => {
    invoke.mockResolvedValueOnce({ launched: true, provider: 'claude' })
    await api.launchAgent({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('routedByJev' in sent).toBe(false)
  })

  it('carries routedByJev on the held channel too', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      routedByJev: true
    })

    expect(invoke).toHaveBeenLastCalledWith('agent:launchHeld', {
      mineId: 'mine-1',
      provider: 'claude',
      prompt: 'dig',
      routedByJev: true
    })
  })

  it('crosses no routedByJev on the held channel when the caller did not name it', async () => {
    invoke.mockResolvedValueOnce({ launched: true })
    await api.launchHeldSession({ mineId: 'mine-1', provider: 'claude', prompt: 'dig' })

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('routedByJev' in sent).toBe(false)
  })
  /* --- end of the #511 block ---------------------------------------------------- */
})

/**
 * The failure channel (#263): a launch `agent:launch` already answered
 * `launched: true` for died almost at once, so main pushes what it learned a
 * moment later rather than leaving the panel to find out never. One-way,
 * exactly like `onShowMine` and `onDwarfSendSettled`: there is no
 * request the panel makes for this, since main learns of it asynchronously.
 */
describe('preload launch-failure contract (#263)', () => {
  const FAILURE = {
    launchId: 'receipt:1',
    provider: 'codex',
    mineId: 'mine:c:\\x\\anvil',
    exitCode: 1,
    stderrTail: 'codex: another instance is already running'
  }

  it('exposes the subscription beside the other launch members', () => {
    expect(typeof api.onLaunchFailed).toBe('function')
  })

  it('subscribes to main’s push on agent:launchFailed, and unsubscribes', () => {
    const listener = vi.fn()
    const stop = api.onLaunchFailed(listener)
    expect(on).toHaveBeenLastCalledWith('agent:launchFailed', expect.any(Function))
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, push: unknown) => void
    wrapped(null, FAILURE)
    // The renderer never sees the IpcRendererEvent: it is the push itself
    // that is the message, exactly as every other subscription here reads.
    expect(listener).toHaveBeenCalledWith(FAILURE)
    stop()
    expect(removeListener).toHaveBeenLastCalledWith('agent:launchFailed', wrapped)
  })

  /*
   * #635 (MESSAGE-QUESTIONS 16/17). The launch-failure notice branches on
   * `cause`, and a field this bridge drops never reaches it — the exact way a
   * held answer's own words were lost in #671, where a request was rebuilt
   * field by field and the new field was not among them. These pin that the
   * cause crosses on the push and on all three launch verdicts, as main
   * answered them.
   */
  it('hands the cause on the push to the renderer (#635)', () => {
    const listener = vi.fn()
    api.onLaunchFailed(listener)
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, push: unknown) => void
    wrapped(null, { ...FAILURE, cause: 'exited-at-once' })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cause: 'exited-at-once' }))
  })

  it('hands the cause on each launch verdict back as main answered it (#635)', async () => {
    const detached = {
      launched: false,
      provider: 'codex',
      error: 'Codex CLI is not installed on this machine.',
      cause: 'not-installed'
    }
    invoke.mockResolvedValueOnce(detached)
    await expect(
      api.launchAgent({ mineId: 'mine:1', provider: 'codex', prompt: 'dig' })
    ).resolves.toEqual(detached)

    const held = {
      launched: false,
      error: 'The agent could not be started.',
      cause: 'could-not-start'
    }
    invoke.mockResolvedValueOnce(held)
    await expect(
      api.launchHeldSession({ mineId: 'mine:1', provider: 'claude', prompt: 'dig' })
    ).resolves.toEqual(held)

    const hosted = {
      launched: false,
      error: 'That command could not be started.',
      cause: 'could-not-start'
    }
    invoke.mockResolvedValueOnce(hosted)
    await expect(
      api.launchHostedProcess({ mineId: 'mine:1', command: 'my-agent', prompt: 'dig' })
    ).resolves.toEqual(hosted)
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

describe('preload open-path contract (#279)', () => {
  it('asks on the mine:openPath channel with the mine id and target rebuilt field by field', async () => {
    invoke.mockResolvedValueOnce({ opened: true })
    await api.openMinePath({ mineId: 'mine:c:\\x\\anvil', target: 'src\\main\\index.ts' })
    expect(invoke).toHaveBeenLastCalledWith('mine:openPath', {
      mineId: 'mine:c:\\x\\anvil',
      target: 'src\\main\\index.ts'
    })
  })

  it('collapses a non-string mineId or target to an empty string before it crosses the bridge', async () => {
    invoke.mockResolvedValueOnce({
      opened: false,
      reason: "That path is outside this mine's folder."
    })
    await api.openMinePath({
      mineId: 42 as unknown as string,
      target: undefined as unknown as string
    })
    expect(invoke).toHaveBeenLastCalledWith('mine:openPath', { mineId: '', target: '' })
  })

  it("hands back main's verdict untouched, a refusal's fixed reason included", async () => {
    const refusal = { opened: false, reason: 'That file no longer exists.' }
    invoke.mockResolvedValueOnce(refusal)
    await expect(
      api.openMinePath({ mineId: 'mine:c:\\x\\anvil', target: 'gone.ts' })
    ).resolves.toEqual(refusal)
  })
})

/**
 * Scrolling back past the newest page (#364). A channel of its own rather than
 * an argument on `dwarf:feed`, because the newest page rides the poll and this
 * one is asked for only when somebody actually scrolls.
 */
describe('preload dwarf feed-page contract (#364)', () => {
  const CURSOR = { timestamp: '2026-09-10T08:00:00.000Z', text: 'dig here' }
  const PAGE = { readable: true, messages: [], reachedStart: false }

  it('asks on the dwarf:feed:page channel with the request rebuilt field by field', async () => {
    invoke.mockResolvedValueOnce(PAGE)
    await api.getDwarfFeedPage({ dwarfId: 'claude:s1', before: CURSOR })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:feed:page', {
      dwarfId: 'claude:s1',
      before: CURSOR
    })
  })

  it('collapses anything that is not a string, so main only ever reasons about strings', async () => {
    invoke.mockResolvedValueOnce({ readable: false, messages: [], reachedStart: false })
    await (api.getDwarfFeedPage as unknown as (value: unknown) => Promise<unknown>)({
      dwarfId: 42,
      before: { timestamp: undefined, text: null }
    })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:feed:page', {
      dwarfId: '',
      before: { timestamp: '', text: '' }
    })
  })

  it('crosses an absent cursor as one main refuses rather than throwing on the way', async () => {
    invoke.mockResolvedValueOnce({ readable: false, messages: [], reachedStart: false })
    await (api.getDwarfFeedPage as unknown as (value: unknown) => Promise<unknown>)(undefined)
    expect(invoke).toHaveBeenLastCalledWith('dwarf:feed:page', {
      dwarfId: '',
      before: { timestamp: '', text: '' }
    })
  })

  it("hands back main's answer untouched, the end-of-pages flag included", async () => {
    // `reachedStart` is what stops the panel asking, so a bridge that dropped
    // or defaulted it would leave the reader pulling empty pages forever.
    const last = { readable: true, messages: [], reachedStart: true }
    invoke.mockResolvedValueOnce(last)
    await expect(api.getDwarfFeedPage({ dwarfId: 'claude:s1', before: CURSOR })).resolves.toEqual(
      last
    )
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
 * The panel CHANGING a held session's own model or effort (#96).
 *
 * Request/response, unlike its read-only sibling above: there is a verdict
 * the strip has to render — a refusal's reason — and nothing else pushes that
 * later. One channel carrying a discriminated `change`, rebuilt field by
 * field here so a caller cannot attach anything past the one act it names.
 */
describe('preload session-tuning contract (#96)', () => {
  it('sends a model change on the dwarf:setTuning channel and answers the verdict', async () => {
    invoke.mockResolvedValueOnce({ applied: true })
    await expect(
      api.setDwarfTuning({
        dwarfId: 'claude:s1',
        change: { kind: 'model', model: 'claude-sonnet-5' }
      })
    ).resolves.toEqual({ applied: true })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setTuning', {
      dwarfId: 'claude:s1',
      change: { kind: 'model', model: 'claude-sonnet-5' }
    })
  })

  it('sends an effort change on the same channel, as its own kind', async () => {
    invoke.mockResolvedValueOnce({ applied: true })
    await api.setDwarfTuning({ dwarfId: 'claude:s1', change: { kind: 'effort', effort: 'high' } })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setTuning', {
      dwarfId: 'claude:s1',
      change: { kind: 'effort', effort: 'high' }
    })
  })

  it('rebuilds the request rather than forwarding whatever the caller attached', async () => {
    // Same discipline as launchAgent's own field-by-field rebuild: nothing
    // beyond the one act may cross, whatever else is hung off the object.
    invoke.mockResolvedValueOnce({ applied: false, reason: 'no' })
    await api.setDwarfTuning({
      dwarfId: 'claude:s1',
      change: { kind: 'model', model: 'claude-sonnet-5' },
      cwd: '/home/j/secrets'
    } as unknown as Parameters<typeof api.setDwarfTuning>[0])
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setTuning', {
      dwarfId: 'claude:s1',
      change: { kind: 'model', model: 'claude-sonnet-5' }
    })
  })

  it('collapses a change it cannot read to a kind main refuses, rather than guessing one', () => {
    // A tuning change NAMES AN ACT, so there is no safe default — picking one
    // would change a running session in a way nobody asked for. An
    // unrecognised kind crosses as `''`, which main refuses outright, the
    // same treatment launchAgent gives an unrecognised provider.
    ;(api.setDwarfTuning as unknown as (value: unknown) => void)({
      dwarfId: 'claude:s1',
      change: { kind: 'temperature', model: 'hot' }
    })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setTuning', {
      dwarfId: 'claude:s1',
      change: { kind: '', value: '' }
    })
  })

  it('collapses a missing payload to one main refuses, without throwing', () => {
    ;(api.setDwarfTuning as unknown as (value: unknown) => void)(undefined)
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setTuning', {
      dwarfId: '',
      change: { kind: '', value: '' }
    })
  })
})
/*
 * REMOVED for #635, stated rather than passing unseen: 'preload message-panel contract (#162)', its
 * eleven cases (the surface's get, set, field-by-field rebuild, the collapses and the refused
 * surface, the real state handed back, the push and its unsubscribe, the height report and its
 * collapse, the delivery report and its relay). The members they pinned are gone with the message
 * panel's own window: the panel is in the shell's dock slot, and nothing about it crosses.
 */

/**
 * A link inside a bubble, handed to main (#347).
 *
 * The same shape #279's open-path contract above has, and for the same reason:
 * main resolves and refuses, this bridge only carries a string over and hands
 * the verdict back. The renderer never receives anything it could act on.
 */
describe('preload open-link contract (#347)', () => {
  it('asks on the shell:openExternalLink channel with the address as written', async () => {
    invoke.mockResolvedValueOnce({ opened: true })
    await api.openExternalLink('https://example.test/347')
    expect(invoke).toHaveBeenLastCalledWith('shell:openExternalLink', 'https://example.test/347')
  })

  it('collapses a non-string address to an empty string before it crosses', async () => {
    invoke.mockResolvedValueOnce({ opened: false, reason: 'That link could not be opened.' })
    await api.openExternalLink(42 as unknown as string)
    expect(invoke).toHaveBeenLastCalledWith('shell:openExternalLink', '')
  })

  it("hands back main's verdict untouched, the fixed refusal included", async () => {
    const refusal = { opened: false, reason: 'That link could not be opened.' }
    invoke.mockResolvedValueOnce(refusal)
    await expect(api.openExternalLink('javascript:alert(1)')).resolves.toEqual(refusal)
  })
})

/**
 * Copy on a failed message, handed to main (#635, decision log, Failed delivery) — APPENDED,
 * nothing above changed. The same shape as the open-link contract: the bridge carries one string
 * over and hands main's verdict back; main owns the clipboard and refuses a bad payload.
 */
describe('preload copy-text contract (#635)', () => {
  it('asks on the shell:copyText channel with the text as written', async () => {
    invoke.mockResolvedValueOnce({ copied: true })
    await api.copyText('Also check\nthat it sorts.')
    expect(invoke).toHaveBeenLastCalledWith('shell:copyText', 'Also check\nthat it sorts.')
  })

  it('collapses a non-string text to an empty string before it crosses', async () => {
    invoke.mockResolvedValueOnce({ copied: false })
    await api.copyText(42 as unknown as string)
    expect(invoke).toHaveBeenLastCalledWith('shell:copyText', '')
  })

  it("hands back main's verdict untouched", async () => {
    invoke.mockResolvedValueOnce({ copied: false })
    await expect(api.copyText('')).resolves.toEqual({ copied: false })
  })
})

/**
 * System notifications (#316) — APPENDED, nothing above changed.
 *
 * Four members, and each one holds the boundary rule its neighbours already do:
 * the switch collapses to a real boolean and answers with what main stored, the
 * open-mine report is string-or-null like setWatchedDwarf because null is a
 * real answer there, and the push drops a payload that names no mine rather
 * than forwarding an empty id the renderer would try to open.
 */
describe('preload notifications contract (#316)', () => {
  it('asks for the stored switch on notifications:enabled:get with no payload', async () => {
    invoke.mockResolvedValueOnce(true)
    await expect(api.getNotificationsEnabled()).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('notifications:enabled:get')
  })

  it('collapses a non-boolean switch before it crosses', async () => {
    invoke.mockResolvedValueOnce(false)
    await (api.setNotificationsEnabled as unknown as (value: unknown) => Promise<unknown>)('yes')
    expect(invoke).toHaveBeenLastCalledWith('notifications:enabled:set', false)
  })

  it('hands back what main STORED, never the request', async () => {
    // A write that failed, or a payload main refused, must be drawable as the
    // state in force rather than as the wish.
    invoke.mockResolvedValueOnce(true)
    await expect(api.setNotificationsEnabled(false)).resolves.toBe(true)
  })

  it('reports the open mine one-way on panel:openMine', () => {
    api.setOpenMine('mine-42')
    expect(send).toHaveBeenLastCalledWith('panel:openMine', 'mine-42')
  })

  it('reports "no mine open" as null rather than as an empty string', () => {
    // string-or-null, like setWatchedDwarf: null is a real answer here, and the
    // map with no interior open is exactly that state.
    api.setOpenMine(null)
    expect(send).toHaveBeenLastCalledWith('panel:openMine', null)
    api.setOpenMine(7 as unknown as string)
    expect(send).toHaveBeenLastCalledWith('panel:openMine', null)
  })

  it('subscribes to the open-this-mine push on panel:mine:show', () => {
    const listener = vi.fn()
    const stop = api.onShowMine(listener)
    expect(on).toHaveBeenLastCalledWith('panel:mine:show', expect.any(Function))
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, 'mine-42')
    expect(listener).toHaveBeenCalledWith('mine-42')
    stop()
    expect(removeListener).toHaveBeenLastCalledWith('panel:mine:show', wrapped)
  })

  it('drops a push that names no mine instead of forwarding an id nothing can open', () => {
    const listener = vi.fn()
    api.onShowMine(listener)
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, '')
    wrapped(null, undefined)
    wrapped(null, 42)
    expect(listener).not.toHaveBeenCalled()
  })
})

/**
 * Typography preferences (#370) — APPENDED, nothing above changed.
 *
 * Three members. The two request/response ones hold the boundary rule their
 * neighbours do — the document is rebuilt through the SHARED parser on the way
 * across, and what comes back is main's verdict untouched — and the third is a
 * subscription, because this is the one preference BOTH windows paint with.
 */
describe('preload typography contract (#370)', () => {
  /*
   * AMENDED for the type presets (#635): the document is a font style and four role faces now.
   * Every test keeps its #370 boundary rule, on the new shape.
   */
  const CUSTOM = {
    style: 'custom',
    faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'pixelify-sans' }
  } as const

  it('asks for the stored faces on typography:preferences:get with no payload', async () => {
    const stored = { ...CUSTOM }
    invoke.mockResolvedValueOnce(stored)
    await expect(api.getTypographyPreferences()).resolves.toEqual(stored)
    expect(invoke).toHaveBeenLastCalledWith('typography:preferences:get')
  })

  it('rebuilds the document through the shared parser before it crosses', async () => {
    invoke.mockResolvedValueOnce(CUSTOM)
    await (api.setTypographyPreferences as unknown as (value: unknown) => Promise<unknown>)({
      ...CUSTOM,
      theme: 'neon'
    })
    // The checked values and nothing the caller happened to attach.
    expect(invoke).toHaveBeenLastCalledWith('typography:preferences:set', CUSTOM)
  })

  // AMENDED (#635): was "refuses Tiny5 for messaging…", on the two-face document.
  it('refuses Tiny5 for messages at the bridge, before main ever sees it', async () => {
    invoke.mockResolvedValueOnce(CUSTOM)
    await (api.setTypographyPreferences as unknown as (value: unknown) => Promise<unknown>)({
      style: 'custom',
      faces: { ...CUSTOM.faces, talk: 'tiny5' }
    })
    expect(invoke).toHaveBeenLastCalledWith('typography:preferences:set', CUSTOM)
  })

  it('hands back what main STORED, never the request', async () => {
    const stored = {
      style: 'readable',
      faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
    } as const
    invoke.mockResolvedValueOnce(stored)
    await expect(api.setTypographyPreferences(CUSTOM)).resolves.toEqual(stored)
  })

  it('subscribes to the change push on typography:preferences:changed', () => {
    const listener = vi.fn()
    const stop = api.onTypographyPreferences(listener)
    expect(on).toHaveBeenLastCalledWith('typography:preferences:changed', expect.any(Function))
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, CUSTOM)
    expect(listener).toHaveBeenCalledWith(CUSTOM)
    stop()
    expect(removeListener).toHaveBeenLastCalledWith('typography:preferences:changed', wrapped)
  })

  it('reads a malformed push as the defaults rather than dropping it', () => {
    // Unlike onShowMine, there is no "no answer" state to fall back to: the
    // page is always painted in SOME face, so an unreadable push has to resolve
    // to the documented one rather than leave the window on a stale choice.
    const listener = vi.fn()
    api.onTypographyPreferences(listener)
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, 'roboto')
    expect(listener).toHaveBeenCalledWith({
      style: 'dwarfai',
      faces: {
        display: 'jacquard-12',
        label: 'tiny5',
        meta: 'pixelify-sans',
        talk: 'pixelify-sans'
      }
    })
  })
})

/**
 * Jev launch routing: the API key setting (#509) — APPENDED, nothing above
 * changed.
 *
 * Three members, and none of them ever answers with the key. `set` parses
 * the key through the SAME shared parser main's own store reads before it
 * ever crosses — the discipline `setAudioPreferences` holds for its document
 * — so a key the store would refuse anyway never reaches the bridge at all.
 */
describe('preload Jev API-key contract (#509)', () => {
  it('asks for the stored settings on jev:settings:get with no payload', async () => {
    invoke.mockResolvedValueOnce({ configured: true })
    await expect(api.getJevSettings()).resolves.toEqual({ configured: true })
    expect(invoke).toHaveBeenLastCalledWith('jev:settings:get')
  })

  it('parses the key through the shared parser before it crosses, trimming what it carries', async () => {
    invoke.mockResolvedValueOnce({ configured: true })
    await api.setJevApiKey('  sk-typesafe-abc123  ')
    expect(invoke).toHaveBeenLastCalledWith('jev:apiKey:set', 'sk-typesafe-abc123')
  })

  it('refuses locally, before the bridge, a key the shared parser would refuse anyway', async () => {
    // `invoke` accumulates calls across this whole suite (nothing resets it),
    // so the only reliable check here is that THIS action added none.
    const callsBefore = invoke.mock.calls.length
    await expect(api.setJevApiKey('   ')).rejects.toThrow()
    expect(invoke.mock.calls.length).toBe(callsBefore)
  })

  it('hands back what main STORED, including a refusal and its reason', async () => {
    const refused = { configured: false, unavailableReason: 'encryption-unavailable' }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.setJevApiKey('sk-typesafe-abc123')).resolves.toEqual(refused)
  })

  it('clears on jev:apiKey:clear with no payload at all', async () => {
    invoke.mockResolvedValueOnce({ configured: false })
    await expect(api.clearJevApiKey()).resolves.toEqual({ configured: false })
    expect(invoke).toHaveBeenLastCalledWith('jev:apiKey:clear')
  })
})

/**
 * Jev launch routing: routing a launch (#509) — APPENDED, nothing above
 * changed.
 *
 * The prompt is parsed through the SAME shared boundary parser main's own
 * service reads, the same discipline `setJevApiKey` holds for the key: a
 * request the service would refuse anyway never reaches the bridge at all.
 */
describe('preload Jev route contract (#509)', () => {
  it('parses the prompt through the shared parser before it crosses, trimming what it carries', async () => {
    const decision = {
      kind: 'decision',
      provider: 'claude',
      confidence: 0.9,
      truncated: false
    }
    invoke.mockResolvedValueOnce(decision)
    await expect(api.routeJevLaunch({ prompt: '  fix the bug  ' })).resolves.toEqual(decision)
    expect(invoke).toHaveBeenLastCalledWith('jev:route', { prompt: 'fix the bug' })
  })

  it('refuses locally, before the bridge, a request the shared parser would refuse anyway', async () => {
    const callsBefore = invoke.mock.calls.length
    await expect(api.routeJevLaunch({ prompt: '   ' })).rejects.toThrow()
    expect(invoke.mock.calls.length).toBe(callsBefore)
  })

  it('hands back a fallback verdict untouched, including its reason', async () => {
    const fallback = { kind: 'fallback', reason: 'no-key' }
    invoke.mockResolvedValueOnce(fallback)
    await expect(api.routeJevLaunch({ prompt: 'anything' })).resolves.toEqual(fallback)
  })
})

/**
 * Jev routing profiles: profile and defaults (#509 follow-up) — APPENDED,
 * nothing above changed.
 *
 * One member, and — the same discipline `setJevApiKey` holds for the key —
 * it parses the document through the SAME shared parser `jevPreferences.ts`
 * reads, before it ever crosses. Unlike that parser, this one DEGRADES a bad
 * shape rather than throwing (`parseJevPreferences`'s own asymmetry), so a
 * malformed document is fixed up rather than refused at the bridge.
 */
describe('preload Jev preferences contract (#509 follow-up)', () => {
  it('parses the document through the shared parser before it crosses, trimming what it carries', async () => {
    const stored = {
      configured: true,
      preferences: {
        profile: 'premium',
        default: { provider: 'claude', model: 'sonnet' },
        delegation: false
      }
    }
    invoke.mockResolvedValueOnce(stored)
    await api.setJevPreferences({
      profile: 'premium',
      default: { provider: 'claude', model: '  sonnet  ' },
      delegation: false
    })
    expect(invoke).toHaveBeenLastCalledWith('jev:preferences:set', {
      profile: 'premium',
      default: { provider: 'claude', model: 'sonnet' },
      delegation: false
    })
  })

  it('hands back what main STORED, the merged verdict, untouched', async () => {
    const stored = {
      configured: true,
      preferences: { profile: 'economy', default: { provider: 'claude' }, delegation: false }
    }
    invoke.mockResolvedValueOnce(stored)
    await expect(
      api.setJevPreferences({
        profile: 'economy',
        default: { provider: 'claude' },
        delegation: false
      })
    ).resolves.toEqual(stored)
  })
})

/**
 * OpenCode permission relay: consent and server password (#588 T6) —
 * APPENDED, nothing above changed.
 *
 * Four members; none ever answers with the password. `setOpenCodeServerPassword`
 * parses through the SAME shared parser main reads, so a password main would
 * refuse never reaches the bridge — and, unlike the Jev key, is never trimmed.
 */
describe('preload OpenCode settings contract (#588 T6)', () => {
  it('asks for the stored settings on opencode:settings:get with no payload', async () => {
    invoke.mockResolvedValueOnce({ pluginEnabled: true, passwordConfigured: false })
    await expect(api.getOpenCodeSettings()).resolves.toEqual({
      pluginEnabled: true,
      passwordConfigured: false
    })
    expect(invoke).toHaveBeenLastCalledWith('opencode:settings:get')
  })

  it('sends the relay switch as a strict boolean', async () => {
    invoke.mockResolvedValueOnce({ pluginEnabled: false, passwordConfigured: false })
    await api.setOpenCodePluginEnabled('yes' as unknown as boolean)
    expect(invoke).toHaveBeenLastCalledWith('opencode:plugin:set', false)
  })

  it('carries the password exactly as typed, untrimmed', async () => {
    invoke.mockResolvedValueOnce({ pluginEnabled: false, passwordConfigured: true })
    await api.setOpenCodeServerPassword(' pass word ')
    expect(invoke).toHaveBeenLastCalledWith('opencode:password:set', ' pass word ')
  })

  it('refuses locally, before the bridge, a password the shared parser would refuse anyway', async () => {
    const callsBefore = invoke.mock.calls.length
    await expect(api.setOpenCodeServerPassword('')).rejects.toThrow()
    expect(invoke.mock.calls.length).toBe(callsBefore)
  })

  it('clears on opencode:password:clear with no payload at all', async () => {
    invoke.mockResolvedValueOnce({ pluginEnabled: false, passwordConfigured: false })
    await api.clearOpenCodeServerPassword()
    expect(invoke).toHaveBeenLastCalledWith('opencode:password:clear')
  })
})

/* --- The launch view (#635, PANEL-QUESTIONS 25) — one block, appended ----- */
describe('preload launch view contract (#635)', () => {
  it('reads the stored view on launch-view:get with no payload', async () => {
    invoke.mockResolvedValueOnce({ area: 'mines', mineId: 'north-shaft' })
    await expect(api.getLaunchView()).resolves.toEqual({ area: 'mines', mineId: 'north-shaft' })
    expect(invoke).toHaveBeenLastCalledWith('launch-view:get')
  })

  it('reports the view one-way on launch-view:set, through the shared parser', () => {
    api.setLaunchView({ area: 'settings', mineId: null })
    expect(send).toHaveBeenLastCalledWith('launch-view:set', { area: 'settings', mineId: null })
    api.setLaunchView({ area: 'vault', mineId: '', extra: 1 } as unknown as Parameters<
      typeof api.setLaunchView
    >[0])
    expect(send).toHaveBeenLastCalledWith('launch-view:set', { area: 'map', mineId: null })
  })
})
/* --- end of the #635 launch view block --------------------------------------- */

/* --- Dwarf names (#635) — one block, appended ------------------------------- */
/*
 * Renaming a dwarf and resetting its name: request/response, because a refusal has a reason the
 * header shows. The request is rebuilt field by field. A dwarf id that is not a string crosses as
 * '', which main refuses; a name that is not a string does not cross at all, so main refuses the
 * shape rather than reading it as a reset. Only a real empty string removes a custom name.
 */
describe('preload dwarf-name contract (#635)', () => {
  it('sends a rename on the dwarf:setName channel and answers the verdict', async () => {
    invoke.mockResolvedValueOnce({ saved: true, customName: 'Stonebeard' })
    await expect(api.setDwarfName({ dwarfId: 'claude:s1', name: 'Stonebeard' })).resolves.toEqual({
      saved: true,
      customName: 'Stonebeard'
    })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setName', {
      dwarfId: 'claude:s1',
      name: 'Stonebeard'
    })
  })

  it('rebuilds the rename rather than forwarding whatever the caller attached', async () => {
    invoke.mockResolvedValueOnce({ saved: true })
    await api.setDwarfName({
      dwarfId: 'claude:s1',
      name: 'Stonebeard',
      provider: 'codex'
    } as unknown as Parameters<typeof api.setDwarfName>[0])
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setName', {
      dwarfId: 'claude:s1',
      name: 'Stonebeard'
    })

    // AMENDED for #635 (verifier finding; was: a non-string name crossed as '', which main read as
    // a reset and answered saved: true, erasing the kept name). It crosses with no name at all
    // now, a shape main refuses, so a malformed call can never remove a name.
    await api.setDwarfName({ dwarfId: 7, name: null } as unknown as Parameters<
      typeof api.setDwarfName
    >[0])
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setName', { dwarfId: '' })
  })

  it('still sends a real empty name, which removes the custom name', async () => {
    invoke.mockResolvedValueOnce({ saved: true })
    await api.setDwarfName({ dwarfId: 'claude:s1', name: '' })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:setName', { dwarfId: 'claude:s1', name: '' })
  })

  it('sends a reset on the dwarf:resetName channel, naming the dwarf alone', async () => {
    invoke.mockResolvedValueOnce({ saved: true })
    await expect(api.resetDwarfName('claude:s1')).resolves.toEqual({ saved: true })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:resetName', 'claude:s1')

    await api.resetDwarfName(undefined as unknown as string)
    expect(invoke).toHaveBeenLastCalledWith('dwarf:resetName', '')
  })
})
/* --- end of the #635 dwarf names block -------------------------------------- */
