// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { SESSION_ENDED_REASON } from '../../lib/delivery/actionBar'
import { NO_EFFORT_CONTROL_REASON, NO_MODEL_CONTROL_REASON } from '../../lib/scene/sessionStrip'
import { defaultDwarf } from '../../testing/factories'
import type { AgentModelCatalog, Dwarf } from '../../types'
import SessionStrip from './SessionStrip.vue'

/**
 * Issue #96's read-only command surface, as the mine draws it. Everything
 * about WHICH sessions can answer lives in lib/scene/sessionStrip.ts and is
 * tested there; these cases are about what actually reaches the screen.
 */

function heldDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return defaultDwarf({
    id: 'claude:sess-1',
    role: 'foreman',
    textDelivery: 'held-session',
    model: 'claude-haiku-4-5',
    ...overrides
  })
}

describe('SessionStrip', () => {
  it('renders nothing at all when no dwarf is selected', () => {
    const wrapper = mount(SessionStrip, { props: {} })
    expect(wrapper.find('.session-strip').exists()).toBe(false)
  })

  it('shows the model a held session named', () => {
    const wrapper = mount(SessionStrip, { props: { dwarf: heldDwarf() } })
    expect(wrapper.get('.session-model').text()).toBe('claude-haiku-4-5')
  })

  it('shows the context window as used over max, with a bar sized to match', () => {
    const wrapper = mount(SessionStrip, {
      props: { dwarf: heldDwarf({ contextUsage: { usedTokens: 41_237, maxTokens: 200_000 } }) }
    })
    expect(wrapper.get('.session-context-label').text()).toBe('41.2K / 200K')
    const fill = wrapper.get('.session-context-fill').element as HTMLElement
    expect(fill.style.width).toBe('21%')
    // The exact counts are the hover line, so the compact label stays compact.
    expect(wrapper.get('.session-context').attributes('title')).toBe('41237 of 200000 tokens (21%)')
  })

  it('draws no context row at all until a reading has arrived', () => {
    const wrapper = mount(SessionStrip, { props: { dwarf: heldDwarf() } })
    expect(wrapper.find('.session-context').exists()).toBe(false)
  })

  it('gives every MCP server a dot carrying its own status, and its name beside it', () => {
    const wrapper = mount(SessionStrip, {
      props: {
        dwarf: heldDwarf({
          mcpServers: [
            { name: 'codegraph', status: 'connected' },
            { name: 'claude-ai-gmail', status: 'needs-auth' }
          ]
        })
      }
    })
    const servers = wrapper.findAll('.session-mcp-server')
    expect(servers.map((server) => server.get('.session-mcp-name').text())).toEqual([
      'codegraph',
      'claude-ai-gmail'
    ])
    expect(servers.map((server) => server.attributes('data-status'))).toEqual([
      'connected',
      'needs-auth'
    ])
    // The status word is the hover line rather than a second column: the strip
    // is 245px wide and five spellings of "needs authentication" do not fit.
    expect(servers[1]!.attributes('title')).toBe('claude-ai-gmail: Needs authentication')
  })

  it('draws no MCP row for a session with none configured', () => {
    const wrapper = mount(SessionStrip, { props: { dwarf: heldDwarf() } })
    expect(wrapper.find('.session-mcp').exists()).toBe(false)
  })

  it('renders no strip at all for a session this panel only observes (#295)', () => {
    // AMENDED for #295 (was: "disables the strip with its reason for a
    // session this panel only observes", asserting `is-unavailable` and a
    // `.session-reason` sentence). The maintainer reversed the disabled
    // reading: the sentence repeated on every observed dwarf and told the
    // reader nothing actionable, so this session now draws no row at all.
    const wrapper = mount(SessionStrip, {
      props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }) }
    })
    expect(wrapper.find('.session-strip').exists()).toBe(false)
  })

  it('renders no strip at all for a session with no delivery channel (#295)', () => {
    const wrapper = mount(SessionStrip, { props: { dwarf: defaultDwarf() } })
    expect(wrapper.find('.session-strip').exists()).toBe(false)
  })

  it('still disables the strip with its reason for a held session that has ended (#295)', () => {
    // The one refusal #295 leaves in place: unlike "not held at all", a held
    // session whose stream has ended names a fact about a session this app
    // DID hold.
    const wrapper = mount(SessionStrip, {
      props: { dwarf: heldDwarf({ status: 'leaving' }) }
    })
    const strip = wrapper.get('.session-strip')
    expect(strip.classes()).toContain('is-unavailable')
    expect(strip.attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('.session-reason').text()).toBe(SESSION_ENDED_REASON)
    // Nothing invented for a session that cannot report: no model, no bar, no
    // roster — the refusal is the whole content.
    expect(wrapper.find('.session-model').exists()).toBe(false)
    expect(wrapper.find('.session-context').exists()).toBe(false)
    expect(wrapper.find('.session-mcp').exists()).toBe(false)
  })

  it('shows no refusal on a live strip', () => {
    const wrapper = mount(SessionStrip, { props: { dwarf: heldDwarf() } })
    expect(wrapper.get('.session-strip').classes()).not.toContain('is-unavailable')
    expect(wrapper.find('.session-reason').exists()).toBe(false)
  })

  it('shows the model as plain text while there is no live catalogue to choose from', () => {
    // AMENDED for #96's mutating slice (was: this case was covered by "shows
    // the model a held session named" above, which had no catalogue to pass).
    // Restated here because the plain name is now the FALLBACK rather than the
    // only rendering, and which one appears is the thing worth pinning. The
    // original case is untouched above.
    const wrapper = mount(SessionStrip, { props: { dwarf: tunableDwarf(), catalogs: [] } })
    expect(wrapper.get('.session-model').text()).toBe('claude-haiku-4-5')
    expect(wrapper.find('.session-model-select').exists()).toBe(false)
  })
})

/*
 * Issue #96's mutating slice, as the strip draws it. Which controls EXIST for
 * which state is `lib/scene/sessionStrip.ts`'s decision and is tested there;
 * these cases are about what reaches the screen and what leaves the component
 * when somebody uses it.
 */
const CLAUDE_LIVE: AgentModelCatalog = {
  provider: 'claude',
  models: [
    { value: 'claude-haiku-4-5', label: 'Haiku' },
    { value: 'claude-sonnet-5', label: 'Sonnet', effortLevels: ['low', 'medium', 'high'] }
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  source: 'provider'
}

function tunableDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return heldDwarf({ sessionTuning: { canSetModel: true, canSetEffort: true }, ...overrides })
}

function mountStrip(dwarf: Dwarf) {
  return mount(SessionStrip, { props: { dwarf, catalogs: [CLAUDE_LIVE] } })
}

describe('SessionStrip controls (#96)', () => {
  it('offers the catalogue as a select, showing the model the session runs', () => {
    const wrapper = mountStrip(tunableDwarf())
    const select = wrapper.get('.session-model-select')
    expect((select.element as HTMLSelectElement).value).toBe('claude-haiku-4-5')
    expect(select.findAll('option').map((option) => option.text())).toEqual(['Haiku', 'Sonnet'])
    // The plain name is replaced by the control, not drawn beside it.
    expect(wrapper.find('.session-model').exists()).toBe(false)
  })

  it('asks for the chosen model, by dwarf and as its own act', async () => {
    const wrapper = mountStrip(tunableDwarf())
    await wrapper.get('.session-model-select').setValue('claude-sonnet-5')
    expect(wrapper.emitted('tune')).toEqual([
      [{ dwarfId: 'claude:sess-1', change: { kind: 'model', model: 'claude-sonnet-5' } }]
    ])
  })

  it('asks for nothing when the select settles back on what the session already runs', async () => {
    // A change to the value already in force is not a change, and spending a
    // control request on one would be noise on a live stream.
    const wrapper = mountStrip(tunableDwarf())
    await wrapper.get('.session-model-select').setValue('claude-haiku-4-5')
    expect(wrapper.emitted('tune')).toBeUndefined()
  })

  it('draws no effort select for a model that takes none', () => {
    const wrapper = mountStrip(tunableDwarf({ model: 'claude-haiku-4-5' }))
    expect(wrapper.find('.session-effort-select').exists()).toBe(false)
  })

  it("offers the active model's own effort levels, and asks for the chosen one", async () => {
    const wrapper = mountStrip(tunableDwarf({ model: 'claude-sonnet-5', effort: 'low' }))
    const select = wrapper.get('.session-effort-select')
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'low',
      'medium',
      'high'
    ])
    await select.setValue('high')
    expect(wrapper.emitted('tune')).toEqual([
      [{ dwarfId: 'claude:sess-1', change: { kind: 'effort', effort: 'high' } }]
    ])
  })

  it('draws a control the engine cannot serve as disabled, with its reason on hover', () => {
    const wrapper = mountStrip(
      tunableDwarf({
        model: 'claude-sonnet-5',
        sessionTuning: { canSetModel: false, canSetEffort: false }
      })
    )
    const model = wrapper.get('.session-model-select')
    expect((model.element as HTMLSelectElement).disabled).toBe(true)
    expect(model.attributes('title')).toBe(NO_MODEL_CONTROL_REASON)
    const effort = wrapper.get('.session-effort-select')
    expect((effort.element as HTMLSelectElement).disabled).toBe(true)
    expect(effort.attributes('title')).toBe(NO_EFFORT_CONTROL_REASON)
  })

  it('words a model change nothing has confirmed as pending, beside the model still in force', () => {
    const wrapper = mountStrip(
      tunableDwarf({
        sessionTuning: { canSetModel: true, canSetEffort: true, pendingModel: 'claude-sonnet-5' }
      })
    )
    expect(wrapper.get('.session-model-pending').text()).toBe('claude-sonnet-5 pending')
    // Still showing what the session actually runs: the reading has not
    // confirmed anything yet, and the select must not claim it has.
    expect((wrapper.get('.session-model-select').element as HTMLSelectElement).value).toBe(
      'claude-haiku-4-5'
    )
  })

  it('words an effort change as requested rather than pending', () => {
    const wrapper = mountStrip(
      tunableDwarf({
        model: 'claude-sonnet-5',
        sessionTuning: { canSetModel: true, canSetEffort: true, pendingEffort: 'high' }
      })
    )
    expect(wrapper.get('.session-effort-pending').text()).toBe('high requested')
  })

  it("shows a refusal's own reason on the strip, and keeps the session's real model", async () => {
    const wrapper = mountStrip(tunableDwarf())
    await wrapper.get('.session-model-select').setValue('claude-sonnet-5')

    await wrapper.setProps({ refusal: 'The session would not take that change.' })

    expect(wrapper.get('.session-refusal').text()).toBe('The session would not take that change.')
    // The refused value is not left showing: the select reads what the
    // session actually runs, which the props never stopped saying.
    expect((wrapper.get('.session-model-select').element as HTMLSelectElement).value).toBe(
      'claude-haiku-4-5'
    )
  })

  it('shows no refusal until there is one', () => {
    const wrapper = mountStrip(tunableDwarf())
    expect(wrapper.find('.session-refusal').exists()).toBe(false)
  })

  it('draws no select at all on a strip that is already refusing', () => {
    // AMENDED for #295: an observed session now draws no strip at all rather
    // than a refusing one (see the "renders no strip" cases above), so the
    // remaining refusal this asserts against is a held session that ended.
    const wrapper = mount(SessionStrip, {
      props: { dwarf: heldDwarf({ status: 'leaving' }), catalogs: [CLAUDE_LIVE] }
    })
    expect(wrapper.find('.session-model-select').exists()).toBe(false)
    expect(wrapper.find('.session-effort-select').exists()).toBe(false)
  })
})
