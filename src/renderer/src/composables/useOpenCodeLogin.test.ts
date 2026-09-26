// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOT_CONNECTED_NOTICE } from '../lib/launch/openCodeLogin'
import { useOpenCodeLogin } from './useOpenCodeLogin'

/*
 * The OpenCode login dialog's bridge half (#597 T5): which preload member each
 * step calls, with what, and what the dialog does with the answer. The flow's
 * own rules are `lib/launch/openCodeLogin`'s and are tested there.
 */

const TARGET = { providerId: 'anthropic', model: 'anthropic/claude-sonnet-4' }
const SECRET = 'sk-test-not-a-real-key'
const BROWSER = { type: 'oauth' as const, label: 'Sign in with the browser' }

/**
 * Every member the composable AWAITS resolves a real result shape, on the rule
 * useAgentLaunch.test.ts states: a bare `vi.fn()` resolves undefined, and a
 * throw after that becomes an unhandled rejection only the full suite catches.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    openCodeAuthMethods: vi.fn().mockResolvedValue({ ok: true, methods: [] }),
    openCodeSubmitApiKey: vi.fn().mockResolvedValue({ ok: true, connected: true }),
    openCodeStartOAuth: vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://auth.example.test/a',
      method: 'code',
      instructions: 'Paste the code.'
    }),
    openCodeCompleteOAuth: vi.fn().mockResolvedValue({ ok: true, connected: true }),
    openCodeCancelOAuth: vi.fn(),
    openExternalLink: vi.fn().mockResolvedValue({ opened: true }),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

/** A promise the test resolves by hand, for a call that must still be in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The store is a module-scope singleton, so each test starts from closed. */
beforeEach(() => {
  stubApi()
  useOpenCodeLogin().close()
})

describe('opening', () => {
  it('asks main for this provider’s methods, and shows the choice', async () => {
    const api = stubApi({
      openCodeAuthMethods: vi.fn().mockResolvedValue({ ok: true, methods: [BROWSER] })
    })
    const login = useOpenCodeLogin()

    await login.open(TARGET, () => {})

    expect(api.openCodeAuthMethods).toHaveBeenCalledWith('anthropic')
    expect(login.view.value.step).toBe('choose')
    expect(login.view.value.oauthChoices).toEqual([{ index: 0, label: BROWSER.label }])
  })

  it('shows a loading state while the methods are in flight', async () => {
    const pending = deferred<unknown>()
    stubApi({ openCodeAuthMethods: vi.fn().mockReturnValue(pending.promise) })
    const login = useOpenCodeLogin()

    const opening = login.open(TARGET, () => {})
    expect(login.view.value.step).toBe('loading')
    expect(login.view.value.busy).toBe(true)

    pending.resolve({ ok: true, methods: [] })
    await opening
    expect(login.view.value.step).toBe('choose')
  })

  it('says why the methods failed, and asks again on retry', async () => {
    const api = stubApi({
      openCodeAuthMethods: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: 'server-unavailable' })
        .mockResolvedValueOnce({ ok: true, methods: [] })
    })
    const login = useOpenCodeLogin()

    await login.open(TARGET, () => {})
    expect(login.view.value.step).toBe('methods-failed')
    expect(login.view.value.notice).not.toBeNull()

    await login.retry()
    expect(api.openCodeAuthMethods).toHaveBeenCalledTimes(2)
    expect(login.view.value.step).toBe('choose')
  })

  it('treats a bridge that throws as a failure it can say, not a hang', async () => {
    stubApi({ openCodeAuthMethods: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const login = useOpenCodeLogin()

    await login.open(TARGET, () => {})

    expect(login.view.value.step).toBe('methods-failed')
  })
})

describe('the API key', () => {
  it('sends the key once, straight to the bridge, and never keeps it', async () => {
    const api = stubApi({
      openCodeSubmitApiKey: vi.fn().mockResolvedValue({ ok: true, connected: false })
    })
    const login = useOpenCodeLogin()
    await login.open(TARGET, () => {})

    await login.submitKey(SECRET)

    expect(api.openCodeSubmitApiKey).toHaveBeenCalledOnce()
    expect(api.openCodeSubmitApiKey).toHaveBeenCalledWith('anthropic', SECRET)
    // Not in the flow's state, and not in anything the dialog is handed.
    expect(JSON.stringify(login.state.value)).not.toContain(SECRET)
    expect(JSON.stringify(login.view.value)).not.toContain(SECRET)
  })

  it('does not send an empty key', async () => {
    const api = stubApi()
    const login = useOpenCodeLogin()
    await login.open(TARGET, () => {})

    await login.submitKey('   ')

    expect(api.openCodeSubmitApiKey).not.toHaveBeenCalled()
  })

  it('closes and hands over to the launch once the provider is connected', async () => {
    const onConnected = vi.fn()
    stubApi()
    const login = useOpenCodeLogin()
    await login.open(TARGET, onConnected)

    await login.submitKey(SECRET)

    expect(login.view.value.step).toBe('closed')
    expect(onConnected).toHaveBeenCalledOnce()
  })

  it('stays open and says so when the login did not take', async () => {
    const onConnected = vi.fn()
    stubApi({ openCodeSubmitApiKey: vi.fn().mockResolvedValue({ ok: true, connected: false }) })
    const login = useOpenCodeLogin()
    await login.open(TARGET, onConnected)

    await login.submitKey(SECRET)

    expect(login.view.value.step).toBe('choose')
    expect(login.view.value.notice).toBe(NOT_CONNECTED_NOTICE)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('never puts the key in a notice when the bridge throws', async () => {
    stubApi({ openCodeSubmitApiKey: vi.fn().mockRejectedValue(new Error(SECRET)) })
    const login = useOpenCodeLogin()
    await login.open(TARGET, () => {})

    await login.submitKey(SECRET)

    expect(login.view.value.step).toBe('choose')
    expect(login.view.value.notice).not.toBeNull()
    expect(JSON.stringify(login.state.value)).not.toContain(SECRET)
  })
})

describe('OAuth', () => {
  async function choosingBrowser(overrides: Record<string, unknown> = {}, onConnected = vi.fn()) {
    const api = stubApi({
      openCodeAuthMethods: vi.fn().mockResolvedValue({ ok: true, methods: [BROWSER] }),
      ...overrides
    })
    const login = useOpenCodeLogin()
    await login.open(TARGET, onConnected)
    return { api, login, onConnected }
  }

  it('starts a method with no prompts at once, by its index', async () => {
    const { api, login } = await choosingBrowser()

    await login.chooseOAuth(0)

    expect(api.openCodeStartOAuth).toHaveBeenCalledWith({ providerId: 'anthropic', method: 0 })
    expect(login.view.value.step).toBe('code')
    expect(login.view.value.link).toBe('https://auth.example.test/a')
  })

  it('asks the prompts first, then starts with only the visible answers', async () => {
    const method = {
      type: 'oauth' as const,
      label: 'Login with GitHub',
      prompts: [
        {
          type: 'select' as const,
          key: 'deploymentType',
          message: 'Deployment',
          options: [
            { label: 'GitHub.com', value: 'github.com' },
            { label: 'Enterprise', value: 'enterprise' }
          ]
        }
      ]
    }
    const api = stubApi({
      openCodeAuthMethods: vi.fn().mockResolvedValue({ ok: true, methods: [method] })
    })
    const login = useOpenCodeLogin()
    await login.open(TARGET, () => {})

    await login.chooseOAuth(0)
    expect(login.view.value.step).toBe('prompts')
    expect(api.openCodeStartOAuth).not.toHaveBeenCalled()

    login.answer('deploymentType', 'enterprise')
    await login.continueOAuth()

    expect(api.openCodeStartOAuth).toHaveBeenCalledWith({
      providerId: 'anthropic',
      method: 0,
      inputs: { deploymentType: 'enterprise' }
    })
  })

  it('completes a `code` method with the pasted code, and never keeps it', async () => {
    const { api, login, onConnected } = await choosingBrowser()
    await login.chooseOAuth(0)

    await login.submitCode(SECRET)

    expect(api.openCodeCompleteOAuth).toHaveBeenCalledWith({
      providerId: 'anthropic',
      method: 0,
      code: SECRET
    })
    expect(JSON.stringify(login.state.value)).not.toContain(SECRET)
    expect(onConnected).toHaveBeenCalledOnce()
  })

  it('waits on an `auto` method at once, with nothing more to send', async () => {
    const pending = deferred<unknown>()
    const { api, login, onConnected } = await choosingBrowser({
      openCodeStartOAuth: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://auth.example.test/device',
        method: 'auto',
        instructions: 'Enter code ABCD-1234'
      }),
      openCodeCompleteOAuth: vi.fn().mockReturnValue(pending.promise)
    })

    const choosing = login.chooseOAuth(0)
    await vi.waitFor(() => expect(api.openCodeCompleteOAuth).toHaveBeenCalled())
    expect(api.openCodeCompleteOAuth).toHaveBeenCalledWith({ providerId: 'anthropic', method: 0 })
    expect(login.view.value.step).toBe('waiting')
    expect(login.view.value.instructions).toBe('Enter code ABCD-1234')

    pending.resolve({ ok: true, connected: true })
    await choosing
    expect(onConnected).toHaveBeenCalledOnce()
    expect(login.view.value.step).toBe('closed')
  })

  it('cancels a wait through main, and ignores the verdict that follows', async () => {
    const pending = deferred<unknown>()
    const { api, login, onConnected } = await choosingBrowser({
      openCodeStartOAuth: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://auth.example.test/device',
        method: 'auto',
        instructions: ''
      }),
      openCodeCompleteOAuth: vi.fn().mockReturnValue(pending.promise)
    })
    const choosing = login.chooseOAuth(0)
    await vi.waitFor(() => expect(login.view.value.step).toBe('waiting'))

    login.cancelWait()

    expect(api.openCodeCancelOAuth).toHaveBeenCalledOnce()
    expect(login.view.value.step).toBe('choose')
    // Even a late success must not launch behind a wait the person gave up on.
    pending.resolve({ ok: true, connected: true })
    await choosing
    expect(onConnected).not.toHaveBeenCalled()
    expect(login.view.value.step).toBe('choose')
  })

  it('cancels the wait when the dialog is closed during it', async () => {
    const pending = deferred<unknown>()
    const { api, login, onConnected } = await choosingBrowser({
      openCodeStartOAuth: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://auth.example.test/device',
        method: 'auto',
        instructions: ''
      }),
      openCodeCompleteOAuth: vi.fn().mockReturnValue(pending.promise)
    })
    const choosing = login.chooseOAuth(0)
    await vi.waitFor(() => expect(login.view.value.step).toBe('waiting'))

    login.close()

    expect(api.openCodeCancelOAuth).toHaveBeenCalledOnce()
    expect(login.view.value.step).toBe('closed')
    pending.resolve({ ok: true, connected: true })
    await choosing
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('does not cancel anything when closed with no wait running', async () => {
    const { api, login } = await choosingBrowser()

    login.close()

    expect(api.openCodeCancelOAuth).not.toHaveBeenCalled()
  })

  it('opens the sign-in link through the app’s own external-link path', async () => {
    const { api, login } = await choosingBrowser()
    await login.chooseOAuth(0)

    await login.openLink()

    expect(api.openExternalLink).toHaveBeenCalledWith('https://auth.example.test/a')
  })

  it('says so when main refuses to open the link', async () => {
    const { login } = await choosingBrowser({
      openExternalLink: vi.fn().mockResolvedValue({ opened: false, reason: 'Refused.' })
    })
    await login.chooseOAuth(0)

    await login.openLink()

    expect(login.view.value.notice).toBe('Refused.')
  })
})
