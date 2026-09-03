// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
import ShortcutSettings from './ShortcutSettings.vue'

function shortcutState(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    accelerator: DEFAULT_TOGGLE_ACCELERATOR,
    registered: true,
    platform: 'win32',
    ...overrides
  }
}

function render(
  props: {
    state?: ShortcutState | null
    error?: string | null
    recording?: boolean
    applying?: boolean
  } = {}
) {
  return mount(ShortcutSettings, {
    props: {
      state: props.state === undefined ? shortcutState() : props.state,
      error: props.error ?? null,
      recording: props.recording ?? false,
      applying: props.applying ?? false
    },
    attachTo: document.body
  })
}

describe('ShortcutSettings — rendering the real state', () => {
  it('shows the current combination with the names printed on this keyboard', () => {
    // The wire format ('Control+Alt+Shift+P') is never shown to a human.
    const wrapper = render()
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + Shift + P')
  })

  it('uses the platform the main process reported, not a guess from the user agent', () => {
    const wrapper = render({
      state: shortcutState({ accelerator: 'Command+Alt+P', platform: 'darwin' })
    })
    expect(wrapper.find('.recorder').text()).toBe('Cmd + Option + P')
  })

  it('waits for the real state instead of showing a plausible default', () => {
    const wrapper = render({ state: null })
    expect(wrapper.find('.recorder').text()).not.toContain('Ctrl')
    expect(wrapper.find('.recorder').attributes('disabled')).toBeDefined()
  })

  it('never calls an unregistered shortcut active, and invites the user to change it', () => {
    const wrapper = render({ state: shortcutState({ registered: false }) })
    const hint = wrapper.find('.hint').text()
    expect(hint).toMatch(/unavailable/i)
    expect(hint).not.toMatch(/active/i)
    // The combination is still named, so the user knows WHICH one is dead.
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + Shift + P')
  })

  it('says the shortcut is live only when it really registered', () => {
    expect(render().find('.hint').text()).toMatch(/active/i)
  })

  it('shows the reason a change was refused, as an alert', () => {
    const wrapper = render({ error: 'Ctrl + Alt + M is already in use by another application.' })
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe('Ctrl + Alt + M is already in use by another application.')
  })

  it('has no alert when nothing went wrong', () => {
    expect(render().find('[role="alert"]').exists()).toBe(false)
  })
})

describe('ShortcutSettings — recording', () => {
  it('makes clear it is listening, in text and in the pressed state', () => {
    const idle = render()
    expect(idle.find('.recorder').attributes('aria-pressed')).toBe('false')

    const listening = render({ recording: true })
    expect(listening.find('.recorder').attributes('aria-pressed')).toBe('true')
    expect(listening.find('.recorder').text()).toMatch(/press/i)
    expect(listening.find('.hint').text()).toMatch(/listening/i)
    // The way out of a recorder that has taken over the keyboard must be stated.
    expect(listening.find('.hint').text()).toMatch(/escape/i)
  })

  it('asks its owner to start listening on click, and to stop on a second click', async () => {
    const idle = render()
    await idle.find('.recorder').trigger('click')
    expect(idle.emitted('start-recording')).toHaveLength(1)

    const listening = render({ recording: true })
    await listening.find('.recorder').trigger('click')
    expect(listening.emitted('stop-recording')).toHaveLength(1)
    expect(listening.emitted('start-recording')).toBeUndefined()
  })

  it('hands every keystroke to its owner while listening', async () => {
    const wrapper = render({ recording: true })
    await wrapper.find('.recorder').trigger('keydown', { key: 'm', code: 'KeyM', ctrlKey: true })
    const recorded = wrapper.emitted('record')
    expect(recorded).toHaveLength(1)
    expect((recorded?.[0]?.[0] as KeyboardEvent).code).toBe('KeyM')
  })

  it('lets Escape cancel the recording without also closing the panel', async () => {
    // Both would be reasonable meanings for Escape; doing both at once would
    // lose the panel the moment the user changed their mind about a chord.
    const wrapper = render({ recording: true })
    await wrapper.find('.recorder').trigger('keydown', { key: 'Escape', code: 'Escape' })
    expect(wrapper.emitted('record')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('closes on Escape when it is not recording', async () => {
    const wrapper = render()
    await wrapper.find('.recorder').trigger('keydown', { key: 'Escape', code: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('ShortcutSettings — reset to default', () => {
  it('offers the reset and asks its owner to perform it', async () => {
    const wrapper = render({ state: shortcutState({ accelerator: 'Control+Alt+M' }) })
    const reset = wrapper.find('.reset')
    expect(reset.attributes('disabled')).toBeUndefined()
    await reset.trigger('click')
    expect(wrapper.emitted('reset')).toHaveLength(1)
  })

  it('is pointless and therefore disabled when the default is already working', () => {
    expect(render().find('.reset').attributes('disabled')).toBeDefined()
  })

  it('stays available when the default is set but failed to register', () => {
    // Retrying is exactly how a user recovers once the other application that
    // owned the combination has quit.
    const wrapper = render({ state: shortcutState({ registered: false }) })
    expect(wrapper.find('.reset').attributes('disabled')).toBeUndefined()
  })
})

describe('ShortcutSettings — accessibility and plumbing', () => {
  // AMENDED (#138): this component is REHOSTED into the redesigned Settings
  // screen as one plain section of a full page (screens/settings.md), not an
  // overlay — a prior report on #142 already flagged its `role="dialog"` as
  // stale. There is no per-section close button any more (leaving Settings is
  // selecting another nav area, exactly like leaving Map or Mines), so the
  // dialog role and its close button are both REMOVED here. What survives is
  // the escape hatch itself: Escape still emits 'close' (see the "recording"
  // describe block above), which is the assertion this test now makes.
  it('emits close on Escape, with no leftover dialog role', () => {
    const wrapper = render()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.close-settings').exists()).toBe(false)
  })

  it('uses real buttons, so every control is keyboard operable', () => {
    const wrapper = render()
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('type')).toBe('button')
    }
  })

  it('names the recorder by its field label plus its value, and points at the hint', () => {
    const wrapper = render()
    const recorder = wrapper.find('.recorder')
    const labelledBy = (recorder.attributes('aria-labelledby') ?? '').split(' ')
    expect(labelledBy).toHaveLength(2)
    for (const id of labelledBy) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true)
    }
    const describedBy = recorder.attributes('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(wrapper.find(`#${describedBy}`).classes()).toContain('hint')
  })

  it('moves focus to the recorder on open, so a keyboard user lands on the control', () => {
    const wrapper = render()
    expect(document.activeElement).toBe(wrapper.find('.recorder').element)
  })

  it('locks the controls while a change is in flight', () => {
    const wrapper = render({ applying: true })
    expect(wrapper.find('.recorder').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.reset').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.hint').text()).toMatch(/applying/i)
  })
})
