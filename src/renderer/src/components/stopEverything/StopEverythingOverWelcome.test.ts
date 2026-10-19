// @vitest-environment jsdom
/*
 * Stop everything and quit stays reachable while the first-run step is open (ISSUE-141, lead decision 2026-10-14;
 * ADR-002 D7, OQ-63: it is the one person-facing way to stop the Host; 07 S41.08: quitting before an answer leaves the
 * step due for the next window). The step has no close and no skip (US-SET-012.AC06), so the confirmation must open
 * ABOVE it, whichever opened first: drawn over it, holding the keys and the focus, and the step beneath inert (out of
 * the pointer's and the accessibility tree's reach) until the confirmation closes, when the step is on top again.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import StopEverythingConfirmation from './StopEverythingConfirmation.vue'
import WelcomeStep from '../welcome/WelcomeStep.vue'
import type { StopEverythingView } from '../../composables/useStopEverything'

const CLOSED: StopEverythingView = { kind: 'closed' }
const CONFIRMING: StopEverythingView = { kind: 'confirming', count: 2, sending: false }

const mounted: VueWrapper[] = []

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
})

function welcome(shown: boolean) {
  const wrapper = mount(WelcomeStep, {
    props: {
      shown,
      due: shown,
      options: [{ id: 'claude-hooks', ticked: true }],
      failures: [],
      answering: false
    },
    attachTo: document.body
  })
  mounted.push(wrapper)
  return wrapper
}

function confirmation(view: StopEverythingView) {
  const wrapper = mount(StopEverythingConfirmation, { props: { view }, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

/** The scrim whose dialog is titled like `title`. */
function scrimOf(title: RegExp): HTMLElement {
  const scrim = [...document.body.querySelectorAll<HTMLElement>('.dm-scrim')].find((candidate) =>
    title.test(candidate.querySelector('.dm-dialog__title')?.textContent ?? '')
  )
  if (scrim === undefined) throw new Error(`no dialog titled ${title}`)
  return scrim
}

/** How far above `--z-dialog` the scrim is drawn (ModalDialog's `--dm-dialog-lift`, added to its z-index). */
const liftOf = (scrim: HTMLElement): number =>
  Number(scrim.style.getPropertyValue('--dm-dialog-lift') || '0')

const confirmButton = (): HTMLButtonElement =>
  [
    ...scrimOf(/stop everything/i).querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')
  ][1]!

describe('Stop everything over the first-run step (ISSUE-141)', () => {
  it('[US-RES-002.AC08, ADR-002] the confirmation opened over the open first-run step is on top and holds the focus, the step beneath inert', async () => {
    welcome(true)
    const stop = confirmation(CLOSED)
    await flushPromises()
    const step = scrimOf(/connect your tools/i)

    await stop.setProps({ view: CONFIRMING })
    await flushPromises()
    const over = scrimOf(/stop everything/i)

    expect(step.hasAttribute('inert'), 'the step beneath is inert').toBe(true)
    expect(step.getAttribute('aria-hidden'), 'and out of the accessibility tree').toBe('true')
    expect(over.hasAttribute('aria-hidden')).toBe(false)
    expect(over.hasAttribute('inert'), 'the confirmation is not').toBe(false)
    expect(liftOf(over), 'the confirmation is drawn above the step').toBeGreaterThan(liftOf(step))
    expect(over.contains(document.activeElement), 'the focus is in the confirmation').toBe(true)

    // The keys are the confirmation's: Esc cancels it, and the step (which Esc never closes) stays.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    expect(stop.emitted('cancel')).toHaveLength(1)
  })

  it('[US-RES-002.AC08, ADR-002] the confirmation stays on top when the first-run step opens after it', async () => {
    const step = welcome(false)
    confirmation(CONFIRMING)
    await flushPromises()

    await step.setProps({ shown: true, due: true })
    await flushPromises()

    expect(
      scrimOf(/connect your tools/i).hasAttribute('inert'),
      'the later step opens beneath'
    ).toBe(true)
    expect(scrimOf(/stop everything/i).hasAttribute('inert')).toBe(false)
    expect(scrimOf(/stop everything/i).contains(document.activeElement)).toBe(true)
    confirmButton().click()
  })

  it('[US-SET-012.AC06] once the confirmation is cancelled the step is on top again, still open', async () => {
    welcome(true)
    const stop = confirmation(CLOSED)
    await flushPromises()
    await stop.setProps({ view: CONFIRMING })
    await flushPromises()

    await stop.setProps({ view: CLOSED })
    await flushPromises()

    const step = scrimOf(/connect your tools/i)
    expect(step.hasAttribute('inert')).toBe(false)
    expect(step.contains(document.activeElement), 'the focus is back in the step').toBe(true)
  })
})
