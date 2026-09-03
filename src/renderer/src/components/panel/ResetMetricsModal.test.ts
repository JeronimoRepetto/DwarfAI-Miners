// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ResetMetricsModal from './ResetMetricsModal.vue'

/**
 * The typed reset-metrics confirmation modal (#138, components.md's shared
 * "Confirmation modal" spec + screens/settings.md's Data Base section).
 * Presentational, exactly like ShortcutSettings: `confirming`/`error` arrive
 * as props (main's verdict, via useResetMetrics), the typed text is owned
 * here (it never has to leave this component), and every intent — confirm,
 * close — leaves as an event.
 */
function render(props: { confirming?: boolean; error?: string | null } = {}) {
  return mount(ResetMetricsModal, {
    props: { confirming: props.confirming ?? false, error: props.error ?? null }
  })
}

describe('ResetMetricsModal — rendering', () => {
  it('gives the title and message exactly as the design states them', () => {
    const wrapper = render()
    expect(wrapper.find('.modal-title').text()).toBe('Reset metrics')
    expect(wrapper.find('.modal-message').text()).toBe(
      'Are you sure you want to delete your data? Type "yes" to confirm.'
    )
  })

  it('has a close (x) control', () => {
    const wrapper = render()
    expect(wrapper.find('.modal-close').exists()).toBe(true)
    expect(wrapper.find('.modal-close').attributes('aria-label')).toBeTruthy()
  })

  it('uses real buttons, so every control is keyboard operable', () => {
    const wrapper = render()
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('type')).toBe('button')
    }
  })
})

describe('ResetMetricsModal — the Confirm gate', () => {
  it('starts disabled with nothing typed', () => {
    expect(render().find('.modal-confirm').attributes('disabled')).toBeDefined()
  })

  it.each(['n', 'ye', 'no', 'yes please'])('stays disabled for %s', async (value) => {
    const wrapper = render()
    await wrapper.find('.modal-input').setValue(value)
    expect(wrapper.find('.modal-confirm').attributes('disabled')).toBeDefined()
  })

  it.each(['yes', 'Yes', 'YES', ' yes '])('enables once %s is typed', async (value) => {
    const wrapper = render()
    await wrapper.find('.modal-input').setValue(value)
    expect(wrapper.find('.modal-confirm').attributes('disabled')).toBeUndefined()
  })

  it('emits confirm only when the gate is open', async () => {
    const wrapper = render()
    await wrapper.find('.modal-input').setValue('yes')
    await wrapper.find('.modal-confirm').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('locks the input and the confirm button while a reset is in flight', () => {
    const wrapper = render({ confirming: true })
    expect(wrapper.find('.modal-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.modal-confirm').attributes('disabled')).toBeDefined()
  })

  it('shows the reason a reset failed, as an alert', () => {
    const wrapper = render({ error: 'The panel lost contact with the app.' })
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe('The panel lost contact with the app.')
  })

  it('has no alert when nothing went wrong', () => {
    expect(render().find('[role="alert"]').exists()).toBe(false)
  })
})

describe('ResetMetricsModal — closing', () => {
  it('emits close from the x control', async () => {
    const wrapper = render()
    await wrapper.find('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('emits close on Escape', async () => {
    const wrapper = render({})
    await wrapper.find('.reset-modal').trigger('keydown', { key: 'Escape', code: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
