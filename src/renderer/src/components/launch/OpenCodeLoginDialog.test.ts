// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerPrompt,
  chooseOAuth,
  codeSubmitted,
  keySubmitted,
  loginView,
  methodsAnswered,
  oauthStarted,
  oauthStarting,
  openLogin,
  type OpenCodeLoginState
} from '../../lib/launch/openCodeLogin'
import type { OpenCodeAuthMethod } from '../../types'
import OpenCodeLoginDialog from './OpenCodeLoginDialog.vue'

/*
 * The OpenCode login dialog (#597 T5), as drawn: presentational, like
 * ResetMetricsModal — it is handed the flow's view and reports intents. The
 * one thing it holds is the text of its own secret fields, and only until the
 * press that sends it.
 */

const TARGET = { providerId: 'anthropic', model: 'anthropic/claude-sonnet-4' }
const SECRET = 'sk-test-not-a-real-key'
const BROWSER: OpenCodeAuthMethod = { type: 'oauth', label: 'Sign in with the browser' }
const API: OpenCodeAuthMethod = { type: 'api', label: 'API key' }
const WITH_PROMPTS: OpenCodeAuthMethod = {
  type: 'oauth',
  label: 'Login with GitHub',
  prompts: [
    {
      type: 'select',
      key: 'deploymentType',
      message: 'Deployment',
      options: [
        { label: 'GitHub.com', value: 'github.com' },
        { label: 'Enterprise', value: 'enterprise', hint: 'Your own server' }
      ]
    },
    {
      type: 'text',
      key: 'enterpriseUrl',
      message: 'Enterprise URL',
      placeholder: 'company.ghe.com',
      when: { key: 'deploymentType', op: 'eq', value: 'enterprise' }
    }
  ]
}

function choosing(methods: OpenCodeAuthMethod[]): OpenCodeLoginState {
  return methodsAnswered(openLogin(TARGET), { ok: true, methods })
}

function started(method: 'auto' | 'code'): OpenCodeLoginState {
  return oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
    ok: true,
    url: 'https://auth.example.test/authorize?x=1',
    method,
    instructions: 'Finish signing in, then come back.'
  })
}

const mounted: VueWrapper[] = []

function dialog(state: OpenCodeLoginState, attach = false) {
  const wrapper = mount(OpenCodeLoginDialog, {
    props: { view: loginView(state) },
    ...(attach ? { attachTo: document.body } : {})
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

describe('what it is and who it is for', () => {
  it('is a modal dialog labelled by a title naming the provider', () => {
    const wrapper = dialog(choosing([]))
    const root = wrapper.get('[role="dialog"]')
    expect(root.attributes('aria-modal')).toBe('true')
    const title = wrapper.get(`#${root.attributes('aria-labelledby')}`)
    expect(title.text()).toContain('anthropic')
  })

  it('explains, in plain words, which model needs which login', () => {
    const wrapper = dialog(choosing([]))
    const root = wrapper.get('[role="dialog"]')
    const explanation = wrapper.get(`#${root.attributes('aria-describedby')}`)
    expect(explanation.text()).toContain('anthropic/claude-sonnet-4')
  })

  it('reports a dismissal from its close control', async () => {
    const wrapper = dialog(choosing([]))
    await wrapper.get('.login-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape', async () => {
    const wrapper = dialog(choosing([]))
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('busy states', () => {
  it('announces what it is waiting on, politely, and marks itself busy', () => {
    const wrapper = dialog(openLogin(TARGET))
    const status = wrapper.get('[role="status"]')
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toMatch(/anthropic/)
    expect(wrapper.get('[role="dialog"]').attributes('aria-busy')).toBe('true')
  })

  it('is not busy on the choice', () => {
    const wrapper = dialog(choosing([]))
    expect(wrapper.get('[role="dialog"]').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('[role="status"]').text()).toBe('')
  })

  it('locks the key field while a key is being checked', () => {
    const wrapper = dialog(keySubmitted(choosing([])))
    expect(wrapper.find('.login-key').exists()).toBe(false)
  })
})

describe('a failure', () => {
  it('shows the reason as an alert, and offers to ask again', async () => {
    const failed = methodsAnswered(openLogin(TARGET), { ok: false, reason: 'unreachable' })
    const wrapper = dialog(failed)

    expect(wrapper.get('[role="alert"]').text()).toMatch(/did not answer/i)
    await wrapper.get('.login-retry').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})

describe('the API key', () => {
  it('is a labelled password field, never echoed', () => {
    const wrapper = dialog(choosing([]))
    const input = wrapper.get<HTMLInputElement>('.login-key')
    expect(input.attributes('type')).toBe('password')
    expect(input.attributes('autocomplete')).toBe('off')
    const label = wrapper.get(`label[for="${input.attributes('id')}"]`)
    expect(label.text()).toMatch(/API key/i)
  })

  it('reports the key once, and clears its own field right after', async () => {
    const wrapper = dialog(choosing([]))
    await wrapper.get('.login-key').setValue(SECRET)
    await wrapper.get('.login-key-form').trigger('submit')

    expect(wrapper.emitted('submit-key')).toEqual([[SECRET]])
    expect(wrapper.get<HTMLInputElement>('.login-key').element.value).toBe('')
  })

  it('reports nothing for an empty field', async () => {
    const wrapper = dialog(choosing([]))
    await wrapper.get('.login-key-form').trigger('submit')
    expect(wrapper.emitted('submit-key')).toBeUndefined()
  })

  it('offers no key field when only OAuth methods exist', () => {
    expect(
      dialog(choosing([BROWSER]))
        .find('.login-key')
        .exists()
    ).toBe(false)
  })

  it('never writes the key into the page outside its own field', async () => {
    const wrapper = dialog(choosing([]))
    await wrapper.get('.login-key').setValue(SECRET)
    expect(wrapper.html()).not.toContain(SECRET)
  })
})

describe('OAuth', () => {
  it('offers each OAuth method as its own button, reporting its index', async () => {
    const wrapper = dialog(choosing([API, BROWSER]))
    const buttons = wrapper.findAll('.login-method')
    expect(buttons.map((button) => button.text())).toEqual(['Sign in with the browser'])
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('choose-oauth')).toEqual([[1]])
  })

  it('draws a select prompt as a labelled picker with its options', async () => {
    const wrapper = dialog(chooseOAuth(choosing([WITH_PROMPTS]), 0))
    const select = wrapper.get<HTMLSelectElement>('select.login-prompt')
    expect(wrapper.get(`label[for="${select.attributes('id')}"]`).text()).toBe('Deployment')
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'GitHub.com',
      'Enterprise — Your own server'
    ])

    await select.setValue('enterprise')
    expect(wrapper.emitted('answer')).toEqual([['deploymentType', 'enterprise']])
  })

  it('draws a visible text prompt as a labelled field, with its placeholder', async () => {
    const state = answerPrompt(
      chooseOAuth(choosing([WITH_PROMPTS]), 0),
      'deploymentType',
      'enterprise'
    )
    const wrapper = dialog(state)
    const input = wrapper.get<HTMLInputElement>('input.login-prompt')
    expect(input.attributes('placeholder')).toBe('company.ghe.com')
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toBe('Enterprise URL')

    await input.setValue('company.ghe.com')
    expect(wrapper.emitted('answer')).toEqual([['enterpriseUrl', 'company.ghe.com']])
  })

  it('holds Continue until every visible prompt is answered', async () => {
    const incomplete = answerPrompt(
      chooseOAuth(choosing([WITH_PROMPTS]), 0),
      'deploymentType',
      'enterprise'
    )
    expect(dialog(incomplete).get('.login-continue').attributes('disabled')).toBeDefined()

    const wrapper = dialog(chooseOAuth(choosing([WITH_PROMPTS]), 0))
    await wrapper.get('.login-continue').trigger('click')
    expect(wrapper.emitted('continue')).toHaveLength(1)
  })

  it('goes back from the prompts', async () => {
    const wrapper = dialog(chooseOAuth(choosing([WITH_PROMPTS]), 0))
    await wrapper.get('.login-back').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })

  it('shows the instructions and the link, and opens it through the app, not the page', async () => {
    const wrapper = dialog(started('code'))
    expect(wrapper.get('.login-instructions').text()).toBe('Finish signing in, then come back.')
    const link = wrapper.get('a.login-link')
    expect(link.attributes('href')).toBe('https://auth.example.test/authorize?x=1')

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.element.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(wrapper.emitted('open-link')).toHaveLength(1)
  })

  it('shows an address it will not open as text, not as a link', () => {
    const state = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'javascript:alert(1)',
      method: 'code',
      instructions: ''
    })
    const wrapper = dialog(state)
    expect(wrapper.find('a.login-link').exists()).toBe(false)
    expect(wrapper.get('.login-url').text()).toBe('javascript:alert(1)')
  })

  it('takes a pasted code in a labelled, unechoed field, and clears it after reporting', async () => {
    const wrapper = dialog(started('code'))
    const input = wrapper.get<HTMLInputElement>('.login-code')
    expect(input.attributes('type')).toBe('password')
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toMatch(/code/i)

    await input.setValue(SECRET)
    await wrapper.get('.login-code-form').trigger('submit')

    expect(wrapper.emitted('submit-code')).toEqual([[SECRET]])
    expect(input.element.value).toBe('')
  })

  it('locks the code field while the code is being checked', () => {
    expect(
      dialog(codeSubmitted(started('code')))
        .find('.login-code')
        .exists()
    ).toBe(false)
  })

  it('waits on an auto method with a Cancel that reports itself', async () => {
    const wrapper = dialog(started('auto'))
    expect(wrapper.find('.login-code').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toMatch(/browser/i)

    await wrapper.get('.login-cancel').trigger('click')
    expect(wrapper.emitted('cancel-wait')).toHaveLength(1)
  })
})

describe('focus', () => {
  it('moves into the dialog when it opens, onto the first field', () => {
    const wrapper = dialog(choosing([]), true)
    expect(document.activeElement).toBe(wrapper.get('.login-key').element)
  })

  it('keeps Tab inside the dialog', async () => {
    const wrapper = dialog(choosing([]), true)
    const root = wrapper.get('[role="dialog"]')
    const focusable = root.element.querySelectorAll<HTMLElement>('button, input, select, a[href]')
    const last = focusable[focusable.length - 1]!
    last.focus()

    await root.trigger('keydown', { key: 'Tab' })

    expect(document.activeElement).toBe(focusable[0])
  })

  it('keeps Shift+Tab inside the dialog too', async () => {
    const wrapper = dialog(choosing([]), true)
    const root = wrapper.get('[role="dialog"]')
    const focusable = root.element.querySelectorAll<HTMLElement>('button, input, select, a[href]')
    focusable[0]!.focus()

    await root.trigger('keydown', { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(focusable[focusable.length - 1])
  })

  it('gives focus back to whatever held it when it closes', () => {
    const before = document.createElement('button')
    document.body.appendChild(before)
    before.focus()

    const wrapper = dialog(choosing([]), true)
    expect(document.activeElement).not.toBe(before)
    mounted.pop()!.unmount()
    void wrapper

    expect(document.activeElement).toBe(before)
    before.remove()
  })
})
