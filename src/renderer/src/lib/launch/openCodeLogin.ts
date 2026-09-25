import { externalLinkOf } from '../../../../shared/externalLink'
import type {
  OpenCodeAuthMethod,
  OpenCodeAuthMethodsResult,
  OpenCodeAuthPrompt,
  OpenCodeCredentialMissing,
  OpenCodeLoginFailureReason,
  OpenCodeLoginResult,
  OpenCodeOAuthStartResult
} from '../../types'

/**
 * The OpenCode login dialog's flow (#597 T5): what the person is being asked,
 * what is in flight, and what each verdict main hands back does to it.
 *
 * Pure, like `launchState.ts` beside it, so the whole flow is tested without a
 * DOM and `useOpenCodeLogin` is only the part that needs a process on the other
 * end.
 *
 * ## What this state never holds
 *
 * A secret. The API key and the pasted OAuth code go from the dialog's own
 * field straight to the bridge, once — the `#597` constraint that neither is
 * ever stored, logged or echoed on this side. So there is no `key` or `code`
 * field here to forget to clear: a transition cannot leak what it was never
 * handed.
 *
 * ## Why an empty method list still offers a key
 *
 * Measured live (OpenCode 1.18.32): `GET /provider/auth` lists only
 * plugin-defined methods, so `anthropic` answers with none at all — and yet a
 * `PUT /auth/anthropic` with an API key connects it. An empty list is
 * therefore the API-key case, never "this provider has no way in".
 */

export type LoginStep =
  | 'closed'
  /** `openCodeAuthMethods` is in flight. */
  | 'loading'
  /** It failed; the dialog says why and offers to ask again. */
  | 'methods-failed'
  /** The key field and/or the OAuth choices are on screen. */
  | 'choose'
  | 'submitting-key'
  /** An OAuth method was chosen and its own prompts are being answered. */
  | 'prompts'
  /** `openCodeStartOAuth` is in flight. */
  | 'starting'
  /** A `'code'` method: the link is out, the pasted code is awaited. */
  | 'code'
  /** The pasted code is being checked. */
  | 'completing'
  /** An `'auto'` method: blocked inside OpenCode until the browser finishes. */
  | 'waiting'

export interface OAuthAuthorization {
  url: string
  method: 'auto' | 'code'
  instructions: string
}

export interface OpenCodeLoginState {
  step: LoginStep
  /** Who this dialog is for — the provider and model the launch named. Null when closed. */
  target: OpenCodeCredentialMissing | null
  methods: OpenCodeAuthMethod[]
  /** The chosen OAuth method's own index into `methods`, or null. */
  method: number | null
  /** Answers to that method's prompts, keyed by each prompt's `key`. Never a secret. */
  answers: Record<string, string>
  authorization: OAuthAuthorization | null
  /** A short sentence for the dialog's alert line, or null. */
  notice: string | null
}

/** One OAuth method the dialog offers as a button. */
export interface OAuthChoice {
  index: number
  label: string
}

/** Everything the dialog draws, read off the state in one place. */
export interface OpenCodeLoginView {
  step: LoginStep
  /** The provider id as OpenCode names it — the only name this app has for it. */
  provider: string
  title: string
  explanation: string
  offersApiKey: boolean
  oauthChoices: OAuthChoice[]
  /** The prompts on screen right now, each with its current answer. */
  prompts: { prompt: OpenCodeAuthPrompt; value: string }[]
  promptsComplete: boolean
  instructions: string
  /** The authorize URL when it is one this app opens, else null. */
  link: string | null
  /** The URL as OpenCode sent it, for a person who has to copy it by hand. */
  url: string
  busy: boolean
  /** What the dialog is waiting on, for the live region; null when idle. */
  busyLabel: string | null
  notice: string | null
}

/**
 * Said when a write succeeded but `GET /provider` still does not list the
 * provider — the login did not take, and pretending otherwise would start a
 * session that mines nothing, which is the whole bug #597 exists for.
 */
export const NOT_CONNECTED_NOTICE =
  'OpenCode took that, but still does not see a login. Check it and try again, or use another way.'

export function closedLogin(): OpenCodeLoginState {
  return {
    step: 'closed',
    target: null,
    methods: [],
    method: null,
    answers: {},
    authorization: null,
    notice: null
  }
}

export function openLogin(target: OpenCodeCredentialMissing): OpenCodeLoginState {
  return { ...closedLogin(), step: 'loading', target: { ...target } }
}

export function closeLogin(): OpenCodeLoginState {
  return closedLogin()
}

/**
 * Short, plain sentences for each way a login operation fails. Never main's
 * own diagnosis — `OpenCodeLoginFailureReason` already collapsed it on
 * purpose — and never anything a secret could be part of.
 */
export function loginFailureSentence(reason: OpenCodeLoginFailureReason): string {
  switch (reason) {
    case 'server-unavailable':
      return 'OpenCode’s login service could not be started.'
    case 'unreachable':
      return 'OpenCode’s login service did not answer.'
    case 'unauthorized':
      return 'OpenCode’s login service turned this app away.'
    case 'refused':
      return 'OpenCode refused that. Check it and try again.'
    case 'timeout':
      return 'That took too long, so it was stopped. Try again.'
    case 'cancelled':
      return 'The sign-in was cancelled.'
    case 'malformed':
      return 'OpenCode answered with something this app cannot read.'
  }
}

export function methodsAnswered(
  state: OpenCodeLoginState,
  result: OpenCodeAuthMethodsResult
): OpenCodeLoginState {
  if (state.step !== 'loading') return state
  if (!result.ok) {
    return { ...state, step: 'methods-failed', notice: loginFailureSentence(result.reason) }
  }
  return { ...state, step: 'choose', methods: result.methods, notice: null }
}

export function retryMethods(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'methods-failed') return state
  return { ...state, step: 'loading', notice: null }
}

/** See the file's own note: an empty list is the API-key case. */
export function offersApiKey(methods: readonly OpenCodeAuthMethod[]): boolean {
  return methods.length === 0 || methods.some((method) => method.type === 'api')
}

export function oauthChoices(methods: readonly OpenCodeAuthMethod[]): OAuthChoice[] {
  const choices: OAuthChoice[] = []
  methods.forEach((method, index) => {
    if (method.type === 'oauth') choices.push({ index, label: method.label })
  })
  return choices
}

export function keySubmitted(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'choose') return state
  return { ...state, step: 'submitting-key', notice: null }
}

/**
 * Choose an OAuth method. A select prompt starts on its first option — the
 * same thing a native `<select>` shows — so its answer exists before anyone
 * touches it, which is also what a `when` pointing at it is compared against.
 */
export function chooseOAuth(state: OpenCodeLoginState, index: number): OpenCodeLoginState {
  if (state.step !== 'choose') return state
  const method = state.methods[index]
  if (method === undefined || method.type !== 'oauth') return state
  const answers: Record<string, string> = {}
  for (const prompt of method.prompts ?? []) {
    if (prompt.type === 'select' && prompt.options[0] !== undefined) {
      answers[prompt.key] = prompt.options[0].value
    }
  }
  return { ...state, step: 'prompts', method: index, answers, notice: null }
}

export function answerPrompt(
  state: OpenCodeLoginState,
  key: string,
  value: string
): OpenCodeLoginState {
  if (state.step !== 'prompts') return state
  return { ...state, answers: { ...state.answers, [key]: value } }
}

function isVisible(prompt: OpenCodeAuthPrompt, answers: Record<string, string>): boolean {
  if (prompt.when === undefined) return true
  const answer = answers[prompt.when.key] ?? ''
  return prompt.when.op === 'eq' ? answer === prompt.when.value : answer !== prompt.when.value
}

export function visiblePrompts(state: OpenCodeLoginState): OpenCodeAuthPrompt[] {
  if (state.method === null) return []
  const prompts = state.methods[state.method]?.prompts ?? []
  return prompts.filter((prompt) => isVisible(prompt, state.answers))
}

/**
 * Whether every prompt on screen has an answer. A text prompt left blank is
 * not one: the source marks none of them optional, and a blank field reaching
 * OpenCode's authorize call would fail there with a far less useful sentence.
 */
export function promptsComplete(state: OpenCodeLoginState): boolean {
  return visiblePrompts(state).every((prompt) => (state.answers[prompt.key] ?? '').trim() !== '')
}

/** The answers the authorize call carries: only the prompts currently visible. */
export function oauthInputs(state: OpenCodeLoginState): Record<string, string> {
  const inputs: Record<string, string> = {}
  for (const prompt of visiblePrompts(state)) inputs[prompt.key] = state.answers[prompt.key] ?? ''
  return inputs
}

export function backToChoices(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'prompts' && state.step !== 'code') return state
  return { ...state, step: 'choose', method: null, answers: {}, authorization: null }
}

export function oauthStarting(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'prompts' || !promptsComplete(state)) return state
  return { ...state, step: 'starting', notice: null }
}

export function oauthStarted(
  state: OpenCodeLoginState,
  result: OpenCodeOAuthStartResult
): OpenCodeLoginState {
  if (state.step !== 'starting') return state
  if (!result.ok) {
    return {
      ...state,
      step: 'choose',
      method: null,
      answers: {},
      notice: loginFailureSentence(result.reason)
    }
  }
  const authorization = {
    url: result.url,
    method: result.method,
    instructions: result.instructions
  }
  return { ...state, step: result.method === 'auto' ? 'waiting' : 'code', authorization }
}

export function codeSubmitted(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'code') return state
  return { ...state, step: 'completing', notice: null }
}

/** The person gave up on an `'auto'` wait: back to the methods, at once. */
export function cancelWait(state: OpenCodeLoginState): OpenCodeLoginState {
  if (state.step !== 'waiting') return state
  return { ...state, step: 'choose', method: null, answers: {}, authorization: null }
}

const ANSWERABLE: readonly LoginStep[] = ['submitting-key', 'completing', 'waiting']

/**
 * A verdict from a write that can complete a login. `connected` is true only
 * when main re-read `GET /provider` and found the provider there — the one
 * moment the dialog closes by itself and the launch goes again.
 */
export function loginAnswered(
  state: OpenCodeLoginState,
  result: OpenCodeLoginResult
): { state: OpenCodeLoginState; connected: boolean } {
  if (!ANSWERABLE.includes(state.step)) return { state, connected: false }
  if (result.ok && result.connected) return { state: closedLogin(), connected: true }
  const back = { ...state, step: 'choose' as const, method: null, answers: {}, authorization: null }
  if (result.ok) return { state: { ...back, notice: NOT_CONNECTED_NOTICE }, connected: false }
  // The person pressed Cancel: nothing went wrong, so nothing is announced.
  const notice = result.reason === 'cancelled' ? null : loginFailureSentence(result.reason)
  return { state: { ...back, notice }, connected: false }
}

function busyLabelOf(state: OpenCodeLoginState): string | null {
  const provider = state.target?.providerId ?? 'this provider'
  switch (state.step) {
    case 'loading':
      return `Asking OpenCode how ${provider} signs in…`
    case 'submitting-key':
      return 'Checking the key…'
    case 'starting':
      return `Asking ${provider} for a sign-in link…`
    case 'completing':
      return 'Checking the code…'
    case 'waiting':
      return 'Waiting for you to finish signing in in your browser…'
    default:
      return null
  }
}

export function loginView(state: OpenCodeLoginState): OpenCodeLoginView {
  const provider = state.target?.providerId ?? ''
  const model = state.target?.model ?? ''
  const busyLabel = busyLabelOf(state)
  return {
    step: state.step,
    provider,
    title: `Sign in to ${provider}`,
    explanation:
      `${model} runs on ${provider}, and OpenCode has no login for it yet. ` +
      'Sign in here and the session starts by itself.',
    offersApiKey: offersApiKey(state.methods),
    oauthChoices: oauthChoices(state.methods),
    prompts: visiblePrompts(state).map((prompt) => ({
      prompt,
      value: state.answers[prompt.key] ?? ''
    })),
    promptsComplete: promptsComplete(state),
    instructions: state.authorization?.instructions ?? '',
    link: state.authorization === null ? null : externalLinkOf(state.authorization.url),
    url: state.authorization?.url ?? '',
    busy: busyLabel !== null,
    busyLabel,
    notice: state.notice
  }
}
