// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { NO_SESSION_SURFACE_REASON } from '../../lib/scene/sessionStrip'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
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

  it('disables the strip with its reason for a session this panel only observes', () => {
    const wrapper = mount(SessionStrip, {
      props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }) }
    })
    const strip = wrapper.get('.session-strip')
    expect(strip.classes()).toContain('is-unavailable')
    expect(strip.attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('.session-reason').text()).toBe(NO_SESSION_SURFACE_REASON)
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
})
