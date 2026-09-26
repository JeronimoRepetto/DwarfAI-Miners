import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  answerPrompt,
  backToChoices,
  cancelWait as leaveWait,
  chooseOAuth as chooseMethod,
  closeLogin,
  closedLogin,
  codeSubmitted,
  keySubmitted,
  loginAnswered,
  loginFailureSentence,
  loginView,
  methodsAnswered,
  oauthInputs,
  oauthStarted,
  oauthStarting,
  openLogin,
  retryMethods,
  type OpenCodeLoginState,
  type OpenCodeLoginView
} from '../lib/launch/openCodeLogin'
import type {
  OpenCodeAuthMethodsResult,
  OpenCodeCredentialMissing,
  OpenCodeLoginResult,
  OpenCodeOAuthStartResult
} from '../types'

/**
 * Completing a missing OpenCode login from the panel (#597 T5): the bridge
 * half of the dialog. Every rule about what the dialog shows and what a
 * verdict does lives in `lib/launch/openCodeLogin`; this file only calls the
 * preload members and hands their answers to it.
 *
 * ## Secrets pass through, and stop nowhere
 *
 * `submitKey` and `submitCode` take the secret as an argument and hand it
 * straight to the bridge. It is never assigned to a ref, never put in a
 * notice (a thrown bridge error's message is discarded, not shown, because it
 * is the one string here that could carry what was sent) and never logged.
 *
 * ## Why every answer is checked against a generation
 *
 * An `'auto'` completion blocks for up to five minutes. The person can cancel
 * it, close the dialog, or open it again for another launch in that time, and
 * the answer still arrives afterwards. Each of those bumps `generation`, and
 * an answer carrying an older one is dropped — above all a late success, which
 * must never relaunch behind a wait somebody already gave up on.
 */

// Singleton store, like useAgentLaunch's: one Add Panel exists, so at most
// one login dialog does, and `openCodeCancelOAuth` names no flow for exactly
// that reason.
const state = ref<OpenCodeLoginState>(closedLogin())
let generation = 0
let onConnected: () => void | Promise<void> = () => {}

const LOST_BRIDGE: OpenCodeLoginResult = { ok: false, reason: 'unreachable' }

export interface OpenCodeLogin {
  state: Ref<OpenCodeLoginState>
  view: ComputedRef<OpenCodeLoginView>
  /** Open on the provider and model a launch was refused for; `connected` runs once it takes. */
  open: (target: OpenCodeCredentialMissing, connected: () => void | Promise<void>) => Promise<void>
  /** Close, cancelling any `'auto'` wait still blocked in main. */
  close: () => void
  retry: () => Promise<void>
  submitKey: (key: string) => Promise<void>
  chooseOAuth: (index: number) => Promise<void>
  answer: (key: string, value: string) => void
  continueOAuth: () => Promise<void>
  submitCode: (code: string) => Promise<void>
  back: () => void
  cancelWait: () => void
  openLink: () => Promise<void>
}

async function ask<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call()
  } catch {
    return fallback
  }
}

function waitingInMain(): boolean {
  return state.value.step === 'waiting'
}

async function loadMethods(): Promise<void> {
  const target = state.value.target
  if (target === null) return
  const mine = generation
  const result = await ask<OpenCodeAuthMethodsResult>(
    () => window.api.openCodeAuthMethods(target.providerId),
    { ok: false, reason: 'unreachable' }
  )
  if (mine !== generation) return
  state.value = methodsAnswered(state.value, result)
}

async function settle(result: OpenCodeLoginResult, mine: number): Promise<void> {
  if (mine !== generation) return
  const answered = loginAnswered(state.value, result)
  state.value = answered.state
  if (!answered.connected) return
  generation += 1
  await onConnected()
}

async function complete(code?: string): Promise<void> {
  const target = state.value.target
  const method = state.value.method
  if (target === null || method === null) return
  const mine = generation
  const result = await ask<OpenCodeLoginResult>(
    () =>
      window.api.openCodeCompleteOAuth({
        providerId: target.providerId,
        method,
        ...(code === undefined ? {} : { code })
      }),
    LOST_BRIDGE
  )
  await settle(result, mine)
}

async function start(): Promise<void> {
  const target = state.value.target
  const method = state.value.method
  if (target === null || method === null) return
  const next = oauthStarting(state.value)
  if (next === state.value) return
  const inputs = oauthInputs(state.value)
  state.value = next
  const mine = generation
  const result = await ask<OpenCodeOAuthStartResult>(
    () =>
      window.api.openCodeStartOAuth({
        providerId: target.providerId,
        method,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {})
      }),
    { ok: false, reason: 'unreachable' }
  )
  if (mine !== generation) return
  state.value = oauthStarted(state.value, result)
  // An 'auto' method has nothing more to ask the person for: the completion
  // is the wait itself, so it goes out now and blocks until the browser is done.
  if (state.value.step === 'waiting') await complete()
}

export function useOpenCodeLogin(): OpenCodeLogin {
  async function open(
    target: OpenCodeCredentialMissing,
    connected: () => void | Promise<void>
  ): Promise<void> {
    close()
    generation += 1
    onConnected = connected
    state.value = openLogin(target)
    await loadMethods()
  }

  function close(): void {
    if (waitingInMain()) window.api.openCodeCancelOAuth()
    generation += 1
    onConnected = () => {}
    state.value = closeLogin()
  }

  async function retry(): Promise<void> {
    const next = retryMethods(state.value)
    if (next === state.value) return
    state.value = next
    await loadMethods()
  }

  async function submitKey(key: string): Promise<void> {
    const target = state.value.target
    if (target === null || key.trim() === '') return
    const next = keySubmitted(state.value)
    if (next === state.value) return
    state.value = next
    const mine = generation
    const result = await ask<OpenCodeLoginResult>(
      () => window.api.openCodeSubmitApiKey(target.providerId, key),
      LOST_BRIDGE
    )
    await settle(result, mine)
  }

  async function chooseOAuth(index: number): Promise<void> {
    state.value = chooseMethod(state.value, index)
    if (state.value.step !== 'prompts') return
    // A method that asks nothing first has nothing to show on a prompts step.
    const prompts = state.value.methods[index]?.prompts ?? []
    if (prompts.length === 0) await start()
  }

  function answer(key: string, value: string): void {
    state.value = answerPrompt(state.value, key, value)
  }

  async function continueOAuth(): Promise<void> {
    await start()
  }

  async function submitCode(code: string): Promise<void> {
    if (code.trim() === '') return
    const next = codeSubmitted(state.value)
    if (next === state.value) return
    state.value = next
    await complete(code)
  }

  function back(): void {
    state.value = backToChoices(state.value)
  }

  function cancelWait(): void {
    if (!waitingInMain()) return
    window.api.openCodeCancelOAuth()
    generation += 1
    state.value = leaveWait(state.value)
  }

  async function openLink(): Promise<void> {
    const link = loginView(state.value).link
    if (link === null) return
    const mine = generation
    let notice: string | null = null
    try {
      const result = await window.api.openExternalLink(link)
      if (!result.opened) notice = result.reason
    } catch {
      notice = loginFailureSentence('unreachable')
    }
    if (mine !== generation || notice === null) return
    state.value = { ...state.value, notice }
  }

  return {
    state,
    view: computed(() => loginView(state.value)),
    open,
    close,
    retry,
    submitKey,
    chooseOAuth,
    answer,
    continueOAuth,
    submitCode,
    back,
    cancelWait,
    openLink
  }
}
