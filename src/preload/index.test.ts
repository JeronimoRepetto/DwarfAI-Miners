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

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => send(channel, ...args),
    on: vi.fn(),
    removeListener: vi.fn()
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
    const result = { declared: true, mineId: 'mine:c:\\x\\adopted' }
    invoke.mockResolvedValueOnce(result)
    await expect(api.declareMine()).resolves.toEqual(result)
    expect(invoke).toHaveBeenLastCalledWith('mine:declare')
  })

  it('hands back a refusal and its reason rather than flattening it to nothing', async () => {
    // A control that silently does nothing reads as broken; the panel needs the
    // reason main gave it.
    const refused = { declared: false, reason: 'No folder was chosen.' }
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
