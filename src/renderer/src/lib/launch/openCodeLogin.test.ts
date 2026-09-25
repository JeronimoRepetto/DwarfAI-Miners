import { describe, expect, it } from 'vitest'
import type { OpenCodeAuthMethod } from '../../types'
import {
  NOT_CONNECTED_NOTICE,
  answerPrompt,
  backToChoices,
  cancelWait,
  chooseOAuth,
  closedLogin,
  codeSubmitted,
  keySubmitted,
  loginAnswered,
  loginView,
  methodsAnswered,
  oauthInputs,
  oauthStarted,
  oauthStarting,
  openLogin,
  promptsComplete,
  retryMethods,
  visiblePrompts,
  type OpenCodeLoginState
} from './openCodeLogin'

/*
 * The OpenCode login dialog's flow (#597 T5), as pure transitions: what the
 * person is being asked, what is in flight, and what a verdict does to it.
 * Nothing here holds a secret — the key and the pasted code go straight from
 * the dialog's own field to the bridge — so no state below ever carries one.
 */

const TARGET = { providerId: 'anthropic', model: 'anthropic/claude-sonnet-4' }

const API: OpenCodeAuthMethod = { type: 'api', label: 'API key' }
const BROWSER: OpenCodeAuthMethod = { type: 'oauth', label: 'Sign in with the browser' }
/** Measured shape: github-copilot's one OAuth method asks a deployment type first. */
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
        { label: 'Enterprise', value: 'enterprise' }
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

describe('opening the dialog', () => {
  it('starts closed, with nobody to sign in', () => {
    expect(closedLogin().step).toBe('closed')
    expect(closedLogin().target).toBeNull()
  })

  it('opens on the provider and model the launch named, loading their methods', () => {
    const state = openLogin(TARGET)
    expect(state.step).toBe('loading')
    expect(state.target).toEqual(TARGET)
  })

  it('moves to the choice once the methods arrive', () => {
    const state = choosing([API, BROWSER])
    expect(state.step).toBe('choose')
    expect(state.methods).toEqual([API, BROWSER])
  })

  it('says why when the methods could not be read, and can ask again', () => {
    const failed = methodsAnswered(openLogin(TARGET), { ok: false, reason: 'server-unavailable' })
    expect(failed.step).toBe('methods-failed')
    expect(failed.notice).toMatch(/could not be started/i)

    const again = retryMethods(failed)
    expect(again.step).toBe('loading')
    expect(again.notice).toBeNull()
  })

  it('ignores a methods answer that lands after the dialog closed', () => {
    expect(methodsAnswered(closedLogin(), { ok: true, methods: [API] }).step).toBe('closed')
  })
})

describe('which ways in are offered', () => {
  /*
   * Measured live on anthropic: `GET /provider/auth` lists only plugin-defined
   * methods, so a provider whose API key works can still answer with none.
   * An empty list is therefore the API-key case, never "no way in".
   */
  it('offers the key field when the method list is empty', () => {
    const view = loginView(choosing([]))
    expect(view.offersApiKey).toBe(true)
    expect(view.oauthChoices).toEqual([])
  })

  it('offers the key field when an api method is listed', () => {
    expect(loginView(choosing([API, BROWSER])).offersApiKey).toBe(true)
  })

  it('offers no key field when only OAuth methods are listed', () => {
    const view = loginView(choosing([BROWSER]))
    expect(view.offersApiKey).toBe(false)
    expect(view.oauthChoices).toEqual([{ index: 0, label: 'Sign in with the browser' }])
  })

  it('numbers each OAuth choice by its own place in the method list', () => {
    // The index is what `openCodeStartOAuth` sends, so it must be the method's
    // own position — an api method before it still counts.
    expect(loginView(choosing([API, BROWSER])).oauthChoices).toEqual([
      { index: 1, label: 'Sign in with the browser' }
    ])
  })
})

describe('naming the provider and the model in plain words', () => {
  it('names both in the title and the explanation', () => {
    const view = loginView(openLogin(TARGET))
    expect(view.title).toContain('anthropic')
    expect(view.explanation).toContain('anthropic/claude-sonnet-4')
    expect(view.explanation).toContain('anthropic')
  })
})

describe('the API key', () => {
  it('is busy while the key is being checked, and says so', () => {
    const state = keySubmitted(choosing([]))
    expect(state.step).toBe('submitting-key')
    const view = loginView(state)
    expect(view.busy).toBe(true)
    expect(view.busyLabel).not.toBeNull()
  })

  it('only submits from the choice', () => {
    expect(keySubmitted(openLogin(TARGET)).step).toBe('loading')
  })

  it('closes and reports success when the provider now reads as connected', () => {
    const { state, connected } = loginAnswered(keySubmitted(choosing([])), {
      ok: true,
      connected: true
    })
    expect(connected).toBe(true)
    expect(state.step).toBe('closed')
  })

  it('stays open and says the login did not take when it is still not connected', () => {
    const { state, connected } = loginAnswered(keySubmitted(choosing([])), {
      ok: true,
      connected: false
    })
    expect(connected).toBe(false)
    expect(state.step).toBe('choose')
    expect(state.notice).toBe(NOT_CONNECTED_NOTICE)
  })

  it('stays open with a short reason when the write failed', () => {
    const { state, connected } = loginAnswered(keySubmitted(choosing([])), {
      ok: false,
      reason: 'refused'
    })
    expect(connected).toBe(false)
    expect(state.step).toBe('choose')
    expect(state.notice).toMatch(/refused|accept/i)
  })
})

describe('OAuth', () => {
  it('asks the chosen method’s prompts before starting, with a select defaulted', () => {
    const state = chooseOAuth(choosing([WITH_PROMPTS]), 0)
    expect(state.step).toBe('prompts')
    expect(state.method).toBe(0)
    expect(state.answers).toEqual({ deploymentType: 'github.com' })
  })

  it('honours `when`: a prompt appears only while its condition holds', () => {
    const state = chooseOAuth(choosing([WITH_PROMPTS]), 0)
    expect(visiblePrompts(state).map((prompt) => prompt.key)).toEqual(['deploymentType'])

    const enterprise = answerPrompt(state, 'deploymentType', 'enterprise')
    expect(visiblePrompts(enterprise).map((prompt) => prompt.key)).toEqual([
      'deploymentType',
      'enterpriseUrl'
    ])
  })

  it('honours a `neq` condition too', () => {
    const method: OpenCodeAuthMethod = {
      type: 'oauth',
      label: 'x',
      prompts: [
        { type: 'text', key: 'a', message: 'A' },
        { type: 'text', key: 'b', message: 'B', when: { key: 'a', op: 'neq', value: 'skip' } }
      ]
    }
    const state = chooseOAuth(choosing([method]), 0)
    expect(visiblePrompts(state).map((prompt) => prompt.key)).toEqual(['a', 'b'])
    expect(visiblePrompts(answerPrompt(state, 'a', 'skip')).map((p) => p.key)).toEqual(['a'])
  })

  it('needs every visible text prompt answered, and sends only the visible answers', () => {
    const enterprise = answerPrompt(
      chooseOAuth(choosing([WITH_PROMPTS]), 0),
      'deploymentType',
      'enterprise'
    )
    expect(promptsComplete(enterprise)).toBe(false)

    const filled = answerPrompt(enterprise, 'enterpriseUrl', 'company.ghe.com')
    expect(promptsComplete(filled)).toBe(true)
    expect(oauthInputs(filled)).toEqual({
      deploymentType: 'enterprise',
      enterpriseUrl: 'company.ghe.com'
    })

    // Back to github.com: the enterprise URL is hidden again, so it is not sent.
    const back = answerPrompt(filled, 'deploymentType', 'github.com')
    expect(oauthInputs(back)).toEqual({ deploymentType: 'github.com' })
  })

  it('goes back to the choice from the prompts', () => {
    const back = backToChoices(chooseOAuth(choosing([WITH_PROMPTS]), 0))
    expect(back.step).toBe('choose')
    expect(back.method).toBeNull()
    expect(back.answers).toEqual({})
  })

  it('refuses a choice that is not an OAuth method', () => {
    expect(chooseOAuth(choosing([API]), 0).step).toBe('choose')
    expect(chooseOAuth(choosing([BROWSER]), 5).step).toBe('choose')
  })

  it('asks for the pasted code on a `code` method, showing the link and instructions', () => {
    const starting = oauthStarting(chooseOAuth(choosing([BROWSER]), 0))
    expect(starting.step).toBe('starting')
    const state = oauthStarted(starting, {
      ok: true,
      url: 'https://auth.example.test/authorize?x=1',
      method: 'code',
      instructions: 'Paste the code shown after signing in.'
    })
    expect(state.step).toBe('code')
    const view = loginView(state)
    expect(view.instructions).toBe('Paste the code shown after signing in.')
    expect(view.link).toBe('https://auth.example.test/authorize?x=1')
  })

  it('waits on an `auto` method, and says it is waiting', () => {
    const state = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'https://auth.example.test/device',
      method: 'auto',
      instructions: 'Enter code ABCD-1234'
    })
    expect(state.step).toBe('waiting')
    expect(loginView(state).busy).toBe(true)
    expect(loginView(state).busyLabel).toMatch(/browser/i)
  })

  it('never offers a link this app would not open', () => {
    const state = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'javascript:alert(1)',
      method: 'code',
      instructions: ''
    })
    expect(loginView(state).link).toBeNull()
  })

  it('returns to the choice with a reason when the authorize call failed', () => {
    const state = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: false,
      reason: 'unreachable'
    })
    expect(state.step).toBe('choose')
    expect(state.notice).toMatch(/did not answer/i)
  })

  it('is busy while a pasted code is being checked', () => {
    const code = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'https://auth.example.test/a',
      method: 'code',
      instructions: ''
    })
    expect(codeSubmitted(code).step).toBe('completing')
    expect(loginView(codeSubmitted(code)).busy).toBe(true)
  })

  it('treats a cancelled wait as the person’s own choice: back to the methods, no alarm', () => {
    const waiting = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'https://auth.example.test/a',
      method: 'auto',
      instructions: ''
    })
    const { state } = loginAnswered(waiting, { ok: false, reason: 'cancelled' })
    expect(state.step).toBe('choose')
    expect(state.notice).toBeNull()
    expect(state.authorization).toBeNull()
  })

  it('leaves the wait at once when the person cancels it', () => {
    const waiting = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'https://auth.example.test/a',
      method: 'auto',
      instructions: ''
    })
    const cancelled = cancelWait(waiting)
    expect(cancelled.step).toBe('choose')
    expect(cancelled.authorization).toBeNull()
  })

  it('says the sign-in timed out when the bounded wait ran out', () => {
    const waiting = oauthStarted(oauthStarting(chooseOAuth(choosing([BROWSER]), 0)), {
      ok: true,
      url: 'https://auth.example.test/a',
      method: 'auto',
      instructions: ''
    })
    const { state } = loginAnswered(waiting, { ok: false, reason: 'timeout' })
    expect(state.step).toBe('choose')
    expect(state.notice).toMatch(/too long|in time/i)
  })

  it('ignores a verdict that lands after the dialog closed', () => {
    const { state, connected } = loginAnswered(closedLogin(), { ok: true, connected: true })
    expect(state.step).toBe('closed')
    expect(connected).toBe(false)
  })
})

describe('what is busy', () => {
  it('is idle on the choice, and busy while loading', () => {
    expect(loginView(choosing([])).busy).toBe(false)
    expect(loginView(choosing([])).busyLabel).toBeNull()
    expect(loginView(openLogin(TARGET)).busy).toBe(true)
  })
})
