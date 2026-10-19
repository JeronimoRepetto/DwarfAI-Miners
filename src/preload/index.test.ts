import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AskId, DwarfId, MessageId, MineId } from '@dwarfai/contracts'
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
    // AMENDED for ISSUE-242 (was: `getMines` and `onMinesUpdated` present): A-12 and A-P2 left the facade at cut 5.
    expect('getMines' in api).toBe(false)
    expect('onMinesUpdated' in api).toBe(false)
    expect(typeof api.activateDwarf).toBe('function')
    expect(typeof api.sendDwarfText).toBe('function')
    // AMENDED for ISSUE-183 (was: `kickDwarf` present): A-26 left the facade in 3a; "Stop dwarf…" is A-N29.
    expect('kickDwarf' in api).toBe(false)
    // AMENDED for ISSUE-239 (was: `retireDwarf` present): A-27 left the facade with the 4b deletion.
    expect('retireDwarf' in api).toBe(false)
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
 * Answering what a session asked (#94, #125).
 *
 * AMENDED for ISSUE-141 (was: today's payload rebuilt field by field, the record entry by entry, string pairs or
 * nothing): from the cut-2 switch A-40 has its 14 shape (`AnswerQuestionParams`, 14 §3.4), and the generated preload
 * hands a target-shape request across unchanged, as it does every target row: main's seam A gate parses it with the
 * row's strict schema before anything is served (ADR-019 items 7, 8; validate.ts), so the bridge's own coercion of
 * today's shape left with today's shape (docs/test-removals.md).
 */
describe('preload question-answer contract', () => {
  const answer = {
    askId: '01920000-0000-7000-9000-0000000000a5' as AskId,
    answers: [{ step: 0, option: 'Postgres' }],
    requestId: '01920000-0000-7000-a000-000000000141'
  }

  it('answers on the agent:answerQuestion channel, naming the ask', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { kind: 'accepted' } })
    await api.answerDwarfQuestion(answer)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', answer)
  })

  it('hands back the refusal and its reason rather than a bare false', async () => {
    // The panel still learns WHY an answer did not land: the outcome's reason, unchanged (ADR-010 item 5).
    const refused = { ok: true, value: { kind: 'refused', reason: 'channel-rejected' } }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.answerDwarfQuestion(answer)).resolves.toEqual(refused)
  })

  /*
   * The person's own words, for the picker's "Other" row (#481): in the 14 shape the step's `freeText`, beside no
   * option of that step.
   */
  it('carries a typed answer as its own field, with no record beside it', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { kind: 'accepted' } })
    const typed = { ...answer, answers: [{ step: 0, freeText: 'neither — put it in Redis' }] }
    await api.answerDwarfQuestion(typed)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerQuestion', typed)
  })
})

/**
 * Deciding a permission prompt (#203).
 *
 * AMENDED for ISSUE-141 (was: today's payload rebuilt field by field): A-41 has its 14 shape
 * (`AnswerPermissionParams`) from the cut-2 switch; main's seam A gate checks the closed `decision` word (Allow or Deny
 * only, INV-73) before anything is served.
 */
describe('preload permission-decision contract (#203)', () => {
  const request = {
    askId: 'legacy:toolu_p1' as AskId,
    decision: 'allow' as const,
    requestId: '01920000-0000-7000-a000-000000000141'
  }

  it('exposes the function beside answerDwarfQuestion', () => {
    expect(typeof api.answerDwarfPermission).toBe('function')
  })

  it('decides on the agent:answerPermission channel, naming the dwarf, the tool call and the decision', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { kind: 'accepted' } })
    await api.answerDwarfPermission(request)
    expect(invoke).toHaveBeenLastCalledWith('agent:answerPermission', request)
  })

  it('hands back the refusal and its reason rather than a bare false', async () => {
    const refused = { ok: true, value: { kind: 'refused', reason: 'channel-rejected' } }
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
  // AMENDED for ISSUE-123 (was: no payload, today's `{outcome}` answer): the cut-1 switch routes A-33 with its target
  // shape through `ResetFanout` (21 §3.1), so the confirmation and its request id cross (14 §2.1 A-33, §1.6).
  const RESET = { confirmed: 'yes', requestId: '01890a5d-ac96-774b-bcce-b302099a8002' } as const

  it('asks on the metrics:reset channel with the typed confirmation and its request id', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { outcome: 'reset', epoch: 2 } })
    await expect(api.resetMetrics(RESET)).resolves.toEqual({
      ok: true,
      value: { outcome: 'reset', epoch: 2 }
    })
    expect(invoke).toHaveBeenLastCalledWith('metrics:reset', RESET)
  })

  it('hands back a refusal and its reason rather than flattening it to nothing', async () => {
    const refused = {
      ok: true,
      value: {
        outcome: 'failed',
        reason: 'The metrics could not be reset. Nothing was deleted.',
        resumesOnNextStart: false
      }
    }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.resetMetrics(RESET)).resolves.toEqual(refused)
  })
})

// AMENDED for ISSUE-001 (was: no payload, today's `{ providers }` answer): from 3a A-36 has its 14 shape for every
// provider (21 §2 cut 3 common rules), `{ refresh? }` → `IpcResult<SupplierEntryView[]>`, the providers not yet moved
// merged in by `CatalogMergeAdapter` (21 §3.1).
describe('preload provider-availability contract (#86)', () => {
  it('asks on the agent:providers channel with the refresh flag as given', async () => {
    // Nothing else to send: the question is about this machine, and main is the
    // only side that can answer it.
    invoke.mockResolvedValueOnce({ ok: true, value: [] })
    await expect(api.listAgentProviders({ refresh: true })).resolves.toEqual({
      ok: true,
      value: []
    })
    expect(invoke).toHaveBeenLastCalledWith('agent:providers', { refresh: true })
  })

  it("hands back main's verdict untouched, refusals and reasons included", async () => {
    const answered = {
      ok: true,
      value: [
        {
          providerId: 'claude',
          label: 'Claude Code',
          models: [{ value: 'opus', efforts: ['high'] }],
          permissionModes: ['default'],
          offeredModes: ['default'],
          installed: true,
          publicLaunch: 'enabled',
          answerChannel: 'available'
        }
      ]
    }
    invoke.mockResolvedValueOnce(answered)
    await expect(api.listAgentProviders({})).resolves.toEqual(answered)
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

/*
 * AMENDED for ISSUE-001 (was: today's `AgentLaunchRequest` rebuilt field by field, `{ mineId, provider, prompt, model?,
 * effort?, permissionMode?, routedByJev? }`, answered `{ launched, provider, error?, cause?, launchId? }`): from 3a A-35
 * has its 14 shape for every provider (21 §2 cut 3 common rules), `LaunchParams` → `IpcResult<LaunchAccepted>`, so
 * the generated member hands the request across unchanged and main's seam A gate parses it strictly (14 §1.4).
 */
describe('preload launch contract (#168)', () => {
  const MINE = '01890a5d-ac96-774b-bcce-b302099a8101' as MineId
  const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8102'
  const launch = (
    providerId: string,
    extra: Partial<Parameters<typeof api.launchAgent>[0]> = {}
  ): Parameters<typeof api.launchAgent>[0] => ({
    mineId: MINE,
    way: { kind: 'supplier', providerId },
    prompt: 'dig',
    jevOn: false,
    jevAutoAccept: false,
    requestId: REQUEST,
    ...extra
  })

  it('carries the chosen provider alongside the mine and the prompt', async () => {
    // Before #168 this channel took a mine and a prompt only, so the engine had
    // nothing to read and started `claude` whatever chip the user pressed.
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('codex'))

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', launch('codex'))
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "collapses a provider this build
  // does not know to nothing, never to a default" (A-35). The generated member no longer rebuilds today's request: the
  // 14 `LaunchParams` cross unchanged, and an unknown supplier reaches nothing (main's seam A gate, then
  // `PerProviderShapeAdapter`'s check against today's strict schema answers INVALID_PARAMS).

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
    // AMENDED for ISSUE-001 (was: today's `{ launched: false, provider, error }`): a refusal at acceptance is the
    // call error branch; the five causes arrive as `launch.failed` frames (ADR-020).
    const refused = {
      ok: false,
      error: { code: 'INTERNAL', message: 'the legacy launch was refused', retryable: false }
    }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.launchAgent(launch('codex'))).resolves.toEqual(refused)
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
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('claude', { model: 'sonnet', effort: 'xhigh' }))

    expect(invoke).toHaveBeenLastCalledWith(
      'agent:launch',
      launch('claude', { model: 'sonnet', effort: 'xhigh' })
    )
  })

  it('crosses no model or effort at all when the caller named neither, rather than empty strings', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('claude'))

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
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('codex', { permissionMode: 'read-only' }))

    expect(invoke).toHaveBeenLastCalledWith(
      'agent:launch',
      launch('codex', { permissionMode: 'read-only' })
    )
  })

  it('crosses no permission mode on the launch channel when the caller named none', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('codex'))

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('permissionMode' in sent).toBe(false)
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "drops a non-string permission
  // mode rather than forwarding it" (A-35). The 14 `LaunchParams` cross unchanged; main's seam A gate refuses a
  // non-string `permissionMode` (a `wireTokenSchema`) before anything is served.

  /* --- MCP subtask delegation: the routedByJev marker (#511) — one block, appended --- */
  // AMENDED for ISSUE-001 (was: today's `routedByJev` marker on the launch request): the 14 launch states a Jev
  // launch by its way and carries the person's Jev switches as `jevOn` / `jevAutoAccept` (14 §3.4 `LaunchParams`).
  it('carries routedByJev on the launch channel when a Jev decision was applied', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    const jev = { ...launch('claude'), way: { kind: 'jev' as const }, jevOn: true }
    await api.launchAgent(jev)

    expect(invoke).toHaveBeenLastCalledWith('agent:launch', jev)
  })

  it('crosses no routedByJev when the caller did not name it, rather than false', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { launchId: REQUEST } })
    await api.launchAgent(launch('claude'))

    const sent = invoke.mock.calls.at(-1)![1] as object
    expect('routedByJev' in sent).toBe(false)
    expect('retryOf' in sent).toBe(false)
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
 *
 * AMENDED for ISSUE-239, the 4b deletion (was: also the A-P3 `onLaunchFailed`
 * subscription and its cause): A-P3 left the facade, and a launch failure
 * reaches the Panel as the Host's `launch.failed` frame. The cause still
 * crosses on each launch verdict.
 */
describe('preload launch-failure contract (#263)', () => {
  it('hands the cause on each launch verdict back as main answered it (#635)', async () => {
    const detached = {
      launched: false,
      provider: 'codex',
      error: 'Codex CLI is not installed on this machine.',
      cause: 'not-installed'
    }
    invoke.mockResolvedValueOnce(detached)
    // AMENDED for ISSUE-001 (was: today's request): A-35's 14 request; its answer still crosses as main gave it.
    await expect(
      api.launchAgent({
        mineId: '01890a5d-ac96-774b-bcce-b302099a8101' as MineId,
        way: { kind: 'supplier', providerId: 'codex' },
        prompt: 'dig',
        jevOn: false,
        jevAutoAccept: false,
        requestId: '01890a5d-ac96-774b-bcce-b302099a8102'
      })
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
    // AMENDED for ISSUE-186 (was: today's request): A-39's 14 request from 3d; its answer still crosses as main gave it.
    await expect(
      api.launchHostedProcess({
        mineId: '01890a5d-ac96-774b-bcce-b302099a8101' as MineId,
        command: 'my-agent',
        prompt: 'dig',
        requestId: '01890a5d-ac96-774b-bcce-b302099a8103'
      })
    ).resolves.toEqual(hosted)
  })
})

describe('preload mine-history contract (#192)', () => {
  it('asks on the mine:history channel by mine id, exactly as given', async () => {
    invoke.mockResolvedValueOnce({ readable: true, speakers: [] })
    // AMENDED for ISSUE-123 (was: an untyped string): A-19's target request is a `MineId`.
    await api.getMineHistory('mine:c:\\x\\anvil' as MineId)
    expect(invoke).toHaveBeenLastCalledWith('mine:history', 'mine:c:\\x\\anvil')
  })

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "collapses a non-string id to an empty string before it crosses the bridge" (A-19). The cut-1 switch routes
  // this row `host` with its target shape (`MineId` → `IpcResult<MineHistoryView>`), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws") and `src/ui-main/ipc/handlers/getMineHistory.host.contract.test.ts` ("[ADR-019] A-19 relays conversation.mineHistory and answers IpcResult<MineHistoryView>; a non-string mineId is refused in main").

  it("hands back main's answer untouched, unreadable included", async () => {
    // `readable: false` is a different fact from "nobody has spoken here", and
    // the bridge must not flatten one into the other.
    invoke.mockResolvedValueOnce({ readable: false, speakers: [] })
    await expect(api.getMineHistory('mine:nowhere' as MineId)).resolves.toEqual({
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
  // AMENDED for ISSUE-123 (was: today's `{dwarfId, before: {timestamp, text}}` request and `DwarfFeedPage` answer): the
  // cut-1 switch routes A-15 `host` with its target shape, `FeedParams` → `IpcResult<FeedPage>` (14 §2.1, §3.6).
  const DWARF = '01890a5d-ac96-774b-bcce-b302099ad001' as DwarfId
  const CURSOR = '01890a5d-ac96-774b-a000-000000000001' as MessageId

  it('asks on the dwarf:feed:page channel with the request rebuilt field by field', async () => {
    invoke.mockResolvedValueOnce({
      ok: true,
      value: { dwarfId: DWARF, messages: [], reachedStart: false }
    })
    await api.getDwarfFeedPage({ dwarfId: DWARF, page: { before: CURSOR } })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:feed:page', {
      dwarfId: DWARF,
      page: { before: CURSOR }
    })
  })

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "collapses anything that is not a string, so main only ever reasons about strings" and "crosses an absent cursor as one main refuses rather than throwing on the way" (A-15). The cut-1 switch routes
  // this row `host` with its target shape (`FeedParams`), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws") and `src/ui-main/ipc/handlers/getDwarfFeedPage.host.contract.test.ts` ("[ADR-019] A-15 validates FeedParams in main and relays conversation.feed; an invalid payload never reaches the Host").

  it("hands back main's answer untouched, the end-of-pages flag included", async () => {
    // `reachedStart` is what stops the panel asking, so a bridge that dropped
    // or defaulted it would leave the reader pulling empty pages forever.
    const last = { ok: true, value: { dwarfId: DWARF, messages: [], reachedStart: true } }
    invoke.mockResolvedValueOnce(last)
    await expect(
      api.getDwarfFeedPage({ dwarfId: DWARF, page: { before: CURSOR } })
    ).resolves.toEqual(last)
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

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "collapses anything that is not a string to null before it crosses the bridge" (A-16). The cut-1 switch routes
  // this row nowhere (retired with no route, `RETIRED`), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws").
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

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "collapses anything that is not a string to '' before it crosses the bridge" (A-17). The cut-1 switch routes
  // this row nowhere (retired with no route, `RETIRED`), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws").
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

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "rebuilds the request rather than forwarding whatever the caller attached", "collapses a change it cannot read to a kind main refuses, rather than guessing one" and "collapses a missing payload to one main refuses, without throwing" (A-18, RETIRE with no story). The cut-1 switch routes
  // this row nowhere (retired with no route, `RETIRED`), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws").
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

  // AMENDED for ISSUE-123 (was: "reports the open mine one-way on panel:openMine", `setOpenMine('mine-42')`): the cut-1
  // switch routes A-44 `ui-local` with its target shape, renamed `reportVisibleMines` (14 §2.1 A-44, §1.1).
  it('reports the mines on screen one-way on presence:visibleMines', () => {
    const mineIds = ['01890a5d-ac96-774b-bcce-b302099a0001' as MineId]
    api.reportVisibleMines({ mineIds })
    expect(send).toHaveBeenLastCalledWith('presence:visibleMines', { mineIds })
  })

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "reports \"no mine open\" as null rather than as an empty string" (A-44: its target request is `{ mineIds }`, so no mine on screen is an empty list). The cut-1 switch routes
  // this row `ui-local` with its target shape, so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws") and `src/ui-main/ipc/ipc-routing.contract.test.ts` ("[ADR-001] in cut 1 A-44, A-N17 to A-N21 and A-N12 route ui-local with shape target, and A-44 feeds presence").

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

  // REMOVED for ISSUE-123, stated rather than passing unseen (docs/test-removals.md): "drops a push that names no mine instead of forwarding an id nothing can open" (A-P5, successor A-N16). The cut-1 switch routes
  // this row nowhere (retired with no route, `RETIRED`; nothing sends it), so the generated preload passes the request on unchanged and main's seam A gate refuses a malformed
  // one (14 §1.4; ADR-019 items 7, 8). Coverage now lives in `src/preload/preload.contract.test.ts` ("[ADR-019] a
  // preload member given a value it cannot coerce passes it on and never throws").
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

  /*
   * AMENDED for ISSUE-045 (was: "rebuilds the document through the shared parser before it crosses"). The generated
   * preload passes a value on and main parses it (14 §1.4, frozen: "a value it cannot coerce is passed on and
   * refused by main"; today's parsers are main's refinements). The parser lives in the legacy tree the preload may
   * not import (05 R16), and main already runs it on every payload (src/main/index.ts setTypographyPreferences),
   * answering with what it stored; its rules stay tested in src/shared/contracts.test.ts.
   */
  it('passes the document on for main to parse, rather than parsing it in the preload', async () => {
    invoke.mockResolvedValueOnce(CUSTOM)
    await (api.setTypographyPreferences as unknown as (value: unknown) => Promise<unknown>)({
      ...CUSTOM,
      theme: 'neon'
    })
    expect(invoke).toHaveBeenLastCalledWith('typography:preferences:set', {
      ...CUSTOM,
      theme: 'neon'
    })
  })

  // AMENDED (#635): was "refuses Tiny5 for messaging…", on the two-face document.
  // AMENDED for ISSUE-045 (was: "refuses Tiny5 for messages at the bridge, before main ever sees it"): main refuses
  // it (14 §1.4; see the test above), and the renderer draws what main answers it stored.
  it('leaves Tiny5 for messages to main to refuse, and hands back what main stored', async () => {
    invoke.mockResolvedValueOnce(CUSTOM)
    const asked = { style: 'custom', faces: { ...CUSTOM.faces, talk: 'tiny5' } }
    await expect(
      (api.setTypographyPreferences as unknown as (value: unknown) => Promise<unknown>)(asked)
    ).resolves.toEqual(CUSTOM)
    expect(invoke).toHaveBeenLastCalledWith('typography:preferences:set', asked)
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

  /*
   * AMENDED for ISSUE-045 (was: "reads a malformed push as the defaults rather than dropping it"). The preload no
   * longer imports the legacy parser (05 R16): it hands the push on as main sent it, and main only ever pushes the
   * document its parser stored (src/main/index.ts setTypographyPreferences). The renderer still reads every push
   * through the same parser, defaults included (useTypography), so the page is never left on a stale face.
   */
  it('hands a push to the listener as main sent it, never dropping it', () => {
    const listener = vi.fn()
    api.onTypographyPreferences(listener)
    const wrapped = on.mock.lastCall?.[1] as (event: unknown, payload: unknown) => void
    wrapped(null, 'roboto')
    expect(listener).toHaveBeenCalledWith('roboto')
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

  /*
   * AMENDED for ISSUE-045 (was: "parses the key through the shared parser before it crosses, trimming what it
   * carries" and "refuses locally, before the bridge, a key the shared parser would refuse anyway"). The preload
   * never throws and main is the validator (14 §1.4, frozen; 14 §2.1 A-48: a malformed value is refused by main with
   * the legacy failure shape, and the preload never throws). Main parses and trims every key it is given and answers
   * a refused one with the unchanged settings (src/main/index.ts setJevApiKey).
   */
  it('carries the key as typed, for main to parse and trim', async () => {
    invoke.mockResolvedValueOnce({ configured: true })
    await api.setJevApiKey('  sk-typesafe-abc123  ')
    expect(invoke).toHaveBeenLastCalledWith('jev:apiKey:set', '  sk-typesafe-abc123  ')
  })

  it('passes a key the shared parser would refuse on to main, and never rejects', async () => {
    const unchanged = { configured: false }
    invoke.mockResolvedValueOnce(unchanged)
    await expect(api.setJevApiKey('   ')).resolves.toEqual(unchanged)
    expect(invoke).toHaveBeenLastCalledWith('jev:apiKey:set', '   ')
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
  /*
   * AMENDED for ISSUE-045 (was: "parses the prompt through the shared parser before it crosses, trimming what it
   * carries" and "refuses locally, before the bridge, a request the shared parser would refuse anyway"). The preload
   * never throws and main is the validator (14 §1.4, frozen). Main parses every request and answers a refused one
   * with a typed fallback (src/main/index.ts routeJevLaunch, `invalid-response`).
   */
  // AMENDED for ISSUE-001 (was: today's `{ prompt }` → `JevRouteLaunchResult`): from 3a A-50 has its 14 shape
  // (`JevSuggestParams` → `IpcResult<JevSuggestResult>`, 21 §3.1 last row: it switches with its route).
  const MINE = '01890a5d-ac96-774b-bcce-b302099a8101' as MineId

  it('carries the prompt as typed, for main to parse and trim', async () => {
    const suggestion = {
      ok: true,
      value: {
        ok: true,
        value: {
          providerId: 'claude',
          tier: 'balanced',
          confidence: { providerId: 0.9 },
          truncated: false,
          parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
        }
      }
    }
    invoke.mockResolvedValueOnce(suggestion)
    await expect(api.routeJevLaunch({ prompt: '  fix the bug  ', mineId: MINE })).resolves.toEqual(
      suggestion
    )
    expect(invoke).toHaveBeenLastCalledWith('jev:route', {
      prompt: '  fix the bug  ',
      mineId: MINE
    })
  })

  it('passes a request the shared parser would refuse on to main, and never rejects', async () => {
    const refused = {
      ok: false,
      error: { code: 'INVALID_PARAMS', message: 'the params do not match', retryable: false }
    }
    invoke.mockResolvedValueOnce(refused)
    await expect(api.routeJevLaunch({ prompt: '   ', mineId: MINE })).resolves.toEqual(refused)
    expect(invoke).toHaveBeenLastCalledWith('jev:route', { prompt: '   ', mineId: MINE })
  })

  it('hands back a fallback verdict untouched, including its reason', async () => {
    const fallback = { ok: true, value: { ok: false, error: 'not-configured' } }
    invoke.mockResolvedValueOnce(fallback)
    await expect(api.routeJevLaunch({ prompt: 'anything', mineId: MINE })).resolves.toEqual(
      fallback
    )
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
  /*
   * AMENDED for ISSUE-045 (was: "parses the document through the shared parser before it crosses, trimming what it
   * carries"). Main parses every document it is given (src/main/index.ts setJevPreferences) and answers with what it
   * stored (14 §1.4, frozen); the parser is in the legacy tree the preload may not import (05 R16).
   */
  it('carries the document as given, for main to parse and trim', async () => {
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
      default: { provider: 'claude', model: '  sonnet  ' },
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

  // AMENDED for ISSUE-235 (was: today's strict boolean, `request === true`): the step-4a switch routes A-53 `host`
  // with its 14 target shape, `SetOpenCodePermissionsParams`, which the preload passes on unchanged (main validates it).
  it('sends the permission request as the target shape, unchanged', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { state: 'on-verified' } })
    const request = {
      on: true,
      origin: 'settings',
      requestId: '01920000-0000-7000-a000-000000000235'
    } as const
    await api.setOpenCodePluginEnabled(request)
    expect(invoke).toHaveBeenLastCalledWith('opencode:plugin:set', request)
  })

  it('carries the password exactly as typed, untrimmed', async () => {
    invoke.mockResolvedValueOnce({ pluginEnabled: false, passwordConfigured: true })
    await api.setOpenCodeServerPassword(' pass word ')
    expect(invoke).toHaveBeenLastCalledWith('opencode:password:set', ' pass word ')
  })

  // AMENDED for ISSUE-045 (was: "refuses locally, before the bridge, a password the shared parser would refuse
  // anyway"): the preload never throws and main is the validator (14 §1.4, frozen); main parses every password and
  // answers a refused one with the settings in force (src/main/index.ts setOpenCodeServerPassword).
  it('passes a password the shared parser would refuse on to main, and never rejects', async () => {
    const inForce = { pluginEnabled: false, passwordConfigured: false }
    invoke.mockResolvedValueOnce(inForce)
    await expect(api.setOpenCodeServerPassword('')).resolves.toEqual(inForce)
    expect(invoke).toHaveBeenLastCalledWith('opencode:password:set', '')
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

  // AMENDED for ISSUE-045 (was: "reports the view one-way on launch-view:set, through the shared parser"): main
  // parses whatever the preload sends before it stores it (src/main/index.ts setLaunchView), and the preload passes a
  // value on rather than parsing it (14 §1.4, frozen; the parser is legacy code, 05 R16).
  it('reports the view one-way on launch-view:set, leaving the parse to main', () => {
    api.setLaunchView({ area: 'settings', mineId: null })
    expect(send).toHaveBeenLastCalledWith('launch-view:set', { area: 'settings', mineId: null })
    api.setLaunchView({ area: 'vault', mineId: '', extra: 1 } as unknown as Parameters<
      typeof api.setLaunchView
    >[0])
    expect(send).toHaveBeenLastCalledWith('launch-view:set', {
      area: 'vault',
      mineId: '',
      extra: 1
    })
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
  // AMENDED for ISSUE-243 (was: four cases of 14 §8 I-21's legacy rows, `setDwarfName` on `dwarf:setName` and
  // `resetDwarfNameToday` on `dwarf:resetName`): both rows left with today's runtime (`MEMBER_REMOVED`, 21 §2 cut 5), so
  // the facade has neither member; A-N08 and A-N09 below are the only rename and reset.
  it('[ADR-001] the facade has no member for the legacy rename and reset rows', () => {
    expect('setDwarfName' in api).toBe(false)
    expect('resetDwarfNameToday' in api).toBe(false)
  })

  it('[ADR-019, US-MSG-005.AC02, US-MSG-006.AC03] A-N08 and A-N09 send their payloads unchanged on dwarf:rename and dwarf:name:reset', async () => {
    const dwarfId = '01920000-0000-7000-a000-000000000172' as unknown as Parameters<
      typeof api.resetDwarfName
    >[0]['dwarfId']
    const requestId = '01920000-0000-7000-a000-000000000173'
    invoke.mockResolvedValueOnce({ ok: true, value: { ok: true, value: { customName: 'Ori' } } })
    await expect(api.renameDwarf({ dwarfId, name: ' Ori ', requestId })).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { customName: 'Ori' } }
    })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:rename', { dwarfId, name: ' Ori ', requestId })

    invoke.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(api.resetDwarfName({ dwarfId, requestId })).resolves.toEqual({
      ok: true,
      value: undefined
    })
    expect(invoke).toHaveBeenLastCalledWith('dwarf:name:reset', { dwarfId, requestId })
  })
})
/* --- end of the #635 dwarf names block -------------------------------------- */
