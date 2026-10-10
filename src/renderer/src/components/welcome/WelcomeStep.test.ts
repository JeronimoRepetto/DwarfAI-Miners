// @vitest-environment jsdom
/*
 * The first-run consent step as drawn (ISSUE-224; 07 machine 41; UC-075; 14 §6.3): the design's dialog
 * (`molecules/dialog`, through ModalDialog: Tab trapped, focus held inside) with one toggle per offered option, each
 * on, and one Activate. There is no close, skip or "Not now" control, and Esc closes nothing (US-SET-012.AC06): the
 * only way out is Activate, with the ticks as the person left them. A per-integration failure of the answer is one
 * line, shown once with one dismiss (ADR-016; S41.05). Every string without approved copy is a marked placeholder
 * (TC-224-04); the option labels are the approved ones.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import WelcomeStep from './WelcomeStep.vue'
import type { WelcomeFailure, WelcomeOption } from '../../composables/useWelcomeStep'

const COPY_NEEDED = /^⟦COPY NEEDED: .+⟧$/

const BOTH: WelcomeOption[] = [
  { id: 'claude-hooks', ticked: true },
  { id: 'opencode-permissions', ticked: true }
]

afterEach(() => {
  document.body.innerHTML = ''
})

const press = (key: string, shiftKey = false): void => {
  ;(document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
  )
}

const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')
const buttons = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
]
const switches = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="switch"]')
]
const actions = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] .dm-dialog__actions button')
]

interface Shown {
  shown?: boolean
  due?: boolean
  options?: WelcomeOption[]
  failures?: WelcomeFailure[]
  answering?: boolean
}

async function step(props: Shown = {}) {
  const wrapper = mount(WelcomeStep, {
    props: {
      shown: false,
      due: false,
      options: [],
      failures: [],
      answering: false
    },
    attachTo: document.body
  })
  await wrapper.setProps({
    shown: true,
    due: true,
    options: BOTH,
    failures: [],
    answering: false,
    ...props
  })
  await flushPromises()
  return wrapper
}

describe('WelcomeStep', () => {
  it('[US-SET-012.AC07, US-SET-012.AC06] one toggle per offered option, each on, named by its approved label, and one Activate', async () => {
    await step({ options: [{ id: 'opencode-permissions', ticked: true }] })

    expect(dialog()?.getAttribute('aria-modal')).toBe('true')
    expect(switches().map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
      'OpenCode · permission requests'
    ])
    expect(switches().map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['true'])
    expect(actions()).toHaveLength(1)
    expect(actions()[0]!.textContent?.trim()).toMatch(COPY_NEEDED)
  })

  it('[US-SET-012.AC06] there is no close or skip control; Activate with both unticked is the only way out', async () => {
    const wrapper = await step()

    // Esc closes nothing and asks for nothing.
    press('Escape')
    await flushPromises()
    expect(dialog()).not.toBeNull()
    expect(wrapper.emitted()).not.toHaveProperty('activate')
    // The toggles and Activate are every control; nothing else closes the step.
    expect(buttons()).toHaveLength(3)
    expect(actions()).toHaveLength(1)

    for (const toggle of switches()) toggle.click()
    await flushPromises()
    expect(switches().map((toggle) => toggle.getAttribute('aria-checked'))).toEqual([
      'false',
      'false'
    ])
    actions()[0]!.click()

    expect(wrapper.emitted('activate')).toEqual([
      [{ 'claude-hooks': false, 'opencode-permissions': false }]
    ])
  })

  it('[US-SET-012.AC03, NFR-A11Y] the step is keyboard reachable: Tab walks the toggles and Activate, and stays inside', async () => {
    const wrapper = await step()
    const [claude, openCode] = switches()
    const [activate] = actions()
    // Activate holds the focus when the step opens.
    expect(document.activeElement).toBe(activate)

    press('Tab')
    expect(document.activeElement).toBe(claude)
    press('Tab')
    expect(document.activeElement).toBe(openCode)
    press('Tab')
    expect(document.activeElement).toBe(activate)

    claude!.click()
    await flushPromises()
    activate!.click()
    expect(wrapper.emitted('activate')).toEqual([
      [{ 'claude-hooks': false, 'opencode-permissions': true }]
    ])
  })

  it('[US-SET-012.AC03] Activate is held while the answer is in flight', async () => {
    const wrapper = await step({ answering: true })

    expect(actions()[0]!.disabled).toBe(true)
    actions()[0]!.click()
    expect(wrapper.emitted()).not.toHaveProperty('activate')
  })

  it('[ADR-016] a per-integration failure from the result is shown once', async () => {
    const wrapper = await step({
      due: false,
      options: [],
      failures: [{ id: 'opencode-permissions', failure: 'config-write-failed' }]
    })

    const lines = [...document.body.querySelectorAll('[role="dialog"] [role="alert"]')]
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toMatch(COPY_NEEDED)
    expect(lines[0]!.textContent).toContain('OpenCode · permission requests')
    // The consent is answered: no toggle and no Activate, only the one dismiss.
    expect(switches()).toEqual([])
    expect(actions()).toHaveLength(1)
    expect(actions()[0]!.textContent?.trim()).toMatch(COPY_NEEDED)

    actions()[0]!.click()
    expect(wrapper.emitted('acknowledge')).toHaveLength(1)
    expect(wrapper.emitted()).not.toHaveProperty('activate')

    // Once acknowledged the step is not shown again.
    await wrapper.setProps({ shown: false, failures: [] })
    await flushPromises()
    expect(dialog()).toBeNull()
  })

  it('[ADR-016] the step strings without approved copy are marked placeholders', async () => {
    await step()

    expect(dialog()?.getAttribute('aria-label')).toMatch(COPY_NEEDED)
    expect(document.body.querySelector('[role="dialog"] .dm-dialog__title')?.textContent).toMatch(
      COPY_NEEDED
    )
    expect(
      document.body.querySelector('[role="dialog"] .welcome-step__body')?.textContent?.trim()
    ).toMatch(COPY_NEEDED)
  })

  it('[S41.08] nothing is drawn while the step is not shown', async () => {
    await step({ shown: false, due: false, options: [] })

    expect(dialog()).toBeNull()
  })
})
