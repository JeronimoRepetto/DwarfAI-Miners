// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TYPOGRAPHY_PREFERENCES, type TypographyPreferences } from '../../types'
import TypographySettings from './TypographySettings.vue'

/**
 * The Typography section of the Settings screen (#370, the maintainer's
 * amendment to `screens/settings.md` — it sits after Position and before Audio,
 * and reuses the segmented control Position already draws).
 *
 * Presentational like every other settings piece: the stored faces arrive as a
 * prop and the intent leaves as one `change` event, so App.vue keeps owning the
 * IPC and the "render only what main verified" rule stays in one place.
 *
 * The load-bearing assertion here is the ABSENCE of a segment: Tiny5 is offered
 * for the interface and must not be offered for messaging, because it has one
 * display weight and a message paragraph needs real bold (#347's ruling, which
 * #370 carries forward rather than reopening).
 */
function render(preferences: Partial<TypographyPreferences> = {}, applying = false) {
  return mount(TypographySettings, {
    props: {
      preferences: { ...DEFAULT_TYPOGRAPHY_PREFERENCES, ...preferences },
      applying
    }
  })
}

function labelsOf(wrapper: ReturnType<typeof render>, role: 'interface' | 'messaging'): string[] {
  return wrapper.findAll(`.${role}-font`).map((button) => button.text())
}

describe('TypographySettings — rendering', () => {
  it('names the section and both roles', () => {
    const text = render().text()
    expect(text).toContain('Typography')
    expect(text).toContain('Interface')
    expect(text).toContain('Messaging')
  })

  it('offers the four interface faces the design names, in its own order', () => {
    expect(labelsOf(render(), 'interface')).toEqual(['Tiny5', 'Pixelify Sans', 'Roboto', 'Arial'])
  })

  it('offers messaging the same faces without Tiny5, which cannot carry a paragraph', () => {
    expect(labelsOf(render(), 'messaging')).toEqual(['Pixelify Sans', 'Roboto', 'Arial'])
  })

  it('has no Tiny5 control for messaging at all, not one that is merely disabled', () => {
    // Hiding it is not the enforcement — main refuses it at the boundary — but
    // a disabled segment would still read as a choice somebody might make.
    expect(render().find('.messaging-font[data-font="tiny5"]').exists()).toBe(false)
  })

  it('draws the stored face as the pressed segment in each row', () => {
    const wrapper = render({ interfaceFont: 'roboto', messagingFont: 'arial' })
    expect(wrapper.find('.interface-font[data-font="roboto"]').attributes('aria-pressed')).toBe(
      'true'
    )
    expect(wrapper.find('.interface-font[data-font="tiny5"]').attributes('aria-pressed')).toBe(
      'false'
    )
    expect(wrapper.find('.messaging-font[data-font="arial"]').attributes('aria-pressed')).toBe(
      'true'
    )
  })

  it('draws the two rows independently, which is the whole point of the section', () => {
    const wrapper = render({ interfaceFont: 'tiny5', messagingFont: 'roboto' })
    expect(wrapper.find('.interface-font[data-font="tiny5"]').attributes('aria-pressed')).toBe(
      'true'
    )
    expect(wrapper.find('.messaging-font[data-font="roboto"]').attributes('aria-pressed')).toBe(
      'true'
    )
  })

  it('says what each row governs, so neither is a mystery', () => {
    const hint = render().find('.hint').text().toLowerCase()
    expect(hint).toContain('message')
  })

  it('locks every segment while a change is in flight', () => {
    const wrapper = render({}, true)
    const locked = wrapper
      .findAll('button')
      .every((button) => button.attributes('disabled') !== undefined)
    expect(locked).toBe(true)
  })
})

describe('TypographySettings — changing a face', () => {
  it('asks for an interface face without naming the messaging one', () => {
    // The owner merges the patch onto what is in force; a row that also sent
    // the other role could revert a change that landed between the two.
    const wrapper = render()
    void wrapper.find('.interface-font[data-font="roboto"]').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[{ interfaceFont: 'roboto' }]])
  })

  it('asks for a messaging face on its own', () => {
    const wrapper = render()
    void wrapper.find('.messaging-font[data-font="arial"]').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[{ messagingFont: 'arial' }]])
  })

  it('still emits for the segment already selected, rather than deciding it is a no-op', () => {
    // The same rule PositionSettings holds: this component does not know its
    // owner would ignore the request, and must not swallow it on its behalf.
    const wrapper = render({ interfaceFont: 'tiny5' })
    void wrapper.find('.interface-font[data-font="tiny5"]').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[{ interfaceFont: 'tiny5' }]])
  })

  it('renders only what it was given, never what it just asked for', async () => {
    const wrapper = render({ interfaceFont: 'tiny5' })
    await wrapper.find('.interface-font[data-font="arial"]').trigger('click')
    expect(wrapper.find('.interface-font[data-font="tiny5"]').attributes('aria-pressed')).toBe(
      'true'
    )
  })
})
