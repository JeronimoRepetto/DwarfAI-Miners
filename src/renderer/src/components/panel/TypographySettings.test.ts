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
      // AMENDED (#635): a fresh copy of the faces too, so no test can edit the default.
      preferences: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES,
        faces: { ...DEFAULT_TYPOGRAPHY_PREFERENCES.faces },
        ...preferences
      },
      applying
    }
  })
}

/*
 * AMENDED for the type presets (#635): the section is Settings › Appearance now — the Font style
 * list (DwarfAI, Pixel clean, Readable, Custom) and, under Custom, one select per role — where it
 * was two rows of segments, Interface and Messaging. Every test keeps its #370 guarantee in the new
 * shape and says what it was; the load-bearing absence is unchanged: no role offers a face it
 * cannot carry, Tiny5 in Messages above all.
 */
const CUSTOM: TypographyPreferences = {
  style: 'custom',
  faces: { display: 'jacquard-12', label: 'tiny5', meta: 'pixelify-sans', talk: 'pixelify-sans' }
}

function optionsOf(wrapper: ReturnType<typeof render>, role: string): string[] {
  return wrapper.findAll(`.role-font-${role} option`).map((option) => option.text())
}

const radio = (wrapper: ReturnType<typeof render>, id: string) =>
  wrapper.get(`.dm-fontstyle__opt[data-id="${id}"]`)

describe('TypographySettings — rendering', () => {
  // AMENDED (#635): was "names the section and both roles" (Typography, Interface, Messaging).
  it('names the Font style row and, under Custom, each role', () => {
    expect(render().get('.dm-srow__label').text()).toBe('Font style')
    expect(
      render(CUSTOM)
        .findAll('.dm-srow__label')
        .map((label) => label.text())
    ).toEqual(['Font style', 'Titles', 'Labels', 'Small text', 'Messages'])
  })

  // AMENDED (#635): was "offers the four interface faces the design names, in its own order".
  it('offers titles and labels the faces the design names, in its own order', () => {
    const wrapper = render(CUSTOM)
    expect(optionsOf(wrapper, 'display')).toEqual([
      'Jacquard 12',
      'Tiny5',
      'Pixelify Sans',
      'Roboto',
      'Arial'
    ])
    expect(optionsOf(wrapper, 'label')).toEqual(['Tiny5', 'Pixelify Sans', 'Roboto', 'Arial'])
  })

  // AMENDED (#635): was "offers messaging the same faces without Tiny5…".
  it('offers messages and small text the same faces without Tiny5, which cannot carry a paragraph', () => {
    const wrapper = render(CUSTOM)
    expect(optionsOf(wrapper, 'talk')).toEqual(['Pixelify Sans', 'Roboto', 'Arial'])
    expect(optionsOf(wrapper, 'meta')).toEqual(['Pixelify Sans', 'Roboto', 'Arial'])
  })

  // AMENDED (#635): was "has no Tiny5 control for messaging at all…", on the segments.
  it('has no Tiny5 option for messages at all, not one that is merely disabled', () => {
    // Hiding it is not the enforcement — main refuses it at the boundary — but a disabled option
    // would still read as a choice somebody might make.
    expect(render(CUSTOM).find('.role-font-talk option[value="tiny5"]').exists()).toBe(false)
  })

  // AMENDED (#635): was "draws the stored face as the pressed segment in each row".
  it('draws the stored style as the checked row, and the stored faces in the selects', () => {
    const readable = render({ style: 'readable', faces: { ...CUSTOM.faces } })
    expect(radio(readable, 'readable').attributes('aria-checked')).toBe('true')
    expect(radio(readable, 'dwarfai').attributes('aria-checked')).toBe('false')
    expect(radio(readable, 'readable').attributes('tabindex')).toBe('0')
    expect(readable.find('.role-font').exists()).toBe(false)
    const custom = render({
      style: 'custom',
      faces: { display: 'arial', label: 'roboto', meta: 'arial', talk: 'roboto' }
    })
    expect(radio(custom, 'custom').attributes('aria-checked')).toBe('true')
    expect((custom.get('.role-font-display select').element as HTMLSelectElement).value).toBe(
      'arial'
    )
  })

  // AMENDED (#635): was "draws the two rows independently, which is the whole point of the
  // section".
  it('draws each role independently under Custom, which is the whole point of Custom', () => {
    const wrapper = render({
      style: 'custom',
      faces: { display: 'tiny5', label: 'arial', meta: 'roboto', talk: 'pixelify-sans' }
    })
    const shown = ['display', 'label', 'meta', 'talk'].map(
      (role) => (wrapper.get(`.role-font-${role} select`).element as HTMLSelectElement).value
    )
    expect(shown).toEqual(['tiny5', 'arial', 'roboto', 'pixelify-sans'])
  })

  // AMENDED (#635): was "says what each row governs…", on the one hint under the two rows.
  it('says what each role governs, so none is a mystery', () => {
    const helps = render(CUSTOM)
      .findAll('.dm-srow__help')
      .map((help) => help.text().toLowerCase())
    expect(helps).toHaveLength(4)
    expect(helps[3]).toContain('bold')
  })

  // AMENDED (#635): was "locks every segment while a change is in flight".
  it('locks every row while a change is in flight', () => {
    const wrapper = render(CUSTOM, true)
    const controls = [...wrapper.findAll('button'), ...wrapper.findAll('select')]
    expect(controls.length).toBe(8)
    expect(controls.every((control) => control.attributes('disabled') !== undefined)).toBe(true)
  })

  it('previews each preset in its own title, label and message faces, and Custom in the faces in force', () => {
    const wrapper = render({ style: 'custom', faces: { ...CUSTOM.faces, display: 'arial' } })
    const sample = (id: string) =>
      radio(wrapper, id)
        .findAll('.dm-fontstyle__sample span')
        .map((span) => (span.element as HTMLElement).style.fontFamily)
    expect(sample('readable')).toEqual([
      'var(--font-family-roboto)',
      'var(--font-family-roboto)',
      'var(--font-family-roboto)'
    ])
    expect(sample('custom')[0]).toBe('var(--font-family-arial)')
  })
})

describe('TypographySettings — changing a face', () => {
  // AMENDED (#635): was "asks for an interface face without naming the messaging one", when a row
  // sent a one-role patch. Now the whole choice travels, with only that role changed.
  it('asks for a role face with the other roles kept as they are', () => {
    const wrapper = render(CUSTOM)
    void wrapper.get('.role-font-label select').setValue('roboto')
    expect(wrapper.emitted('change')).toEqual([
      [{ style: 'custom', faces: { ...CUSTOM.faces, label: 'roboto' } }]
    ])
  })

  // AMENDED (#635): was "asks for a messaging face on its own".
  it('asks for a message face on its own', () => {
    const wrapper = render(CUSTOM)
    void wrapper.get('.role-font-talk select').setValue('arial')
    expect(wrapper.emitted('change')).toEqual([
      [{ style: 'custom', faces: { ...CUSTOM.faces, talk: 'arial' } }]
    ])
  })

  // AMENDED (#635): was the same rule on the segment already selected.
  it('still emits for the style already in force, rather than deciding it is a no-op', () => {
    // The same rule PositionSettings holds: this component does not know its owner would ignore
    // the request, and must not swallow it on its behalf.
    const wrapper = render()
    void radio(wrapper, 'dwarfai').trigger('click')
    expect(wrapper.emitted('change')).toEqual([[DEFAULT_TYPOGRAPHY_PREFERENCES]])
  })

  // AMENDED (#635): the same rule, on the style list.
  it('renders only what it was given, never what it just asked for', async () => {
    const wrapper = render()
    await radio(wrapper, 'readable').trigger('click')
    expect(radio(wrapper, 'dwarfai').attributes('aria-checked')).toBe('true')
    expect(radio(wrapper, 'readable').attributes('aria-checked')).toBe('false')
  })

  it('opens Custom on the faces in force, so nothing on screen jumps', async () => {
    const wrapper = render()
    await radio(wrapper, 'custom').trigger('click')
    expect(wrapper.emitted('change')).toEqual([
      [{ style: 'custom', faces: DEFAULT_TYPOGRAPHY_PREFERENCES.faces }]
    ])
  })

  it('moves through the styles with the arrow keys, choosing as it goes and keeping the focus', async () => {
    const wrapper = mount(TypographySettings, {
      props: { preferences: DEFAULT_TYPOGRAPHY_PREFERENCES, applying: false },
      attachTo: document.body
    })
    await radio(wrapper, 'dwarfai').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('change')?.[0]?.[0]).toMatchObject({ style: 'pixel-clean' })
    expect(document.activeElement).toBe(radio(wrapper, 'pixel-clean').element)
    await radio(wrapper, 'dwarfai').trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('change')?.[1]?.[0]).toMatchObject({ style: 'custom' })
    wrapper.unmount()
  })
})
