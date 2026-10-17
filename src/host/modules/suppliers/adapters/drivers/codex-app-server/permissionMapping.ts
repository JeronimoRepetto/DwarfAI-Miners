// Codex app-server asks and answers (15 §2.7 rows Codex approvals and item/tool/requestUserInput;
// §4.4 Ask / answer; codex@8f195c9 app-server-protocol v2 schemas), as pure functions.
//
// Permission — `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`: Allow is
// decision `accept`, Deny is `decline` (it continues the turn). `cancel` (deny and interrupt) is
// never Deny (HR D4), and neither the session-wide accept nor an exec-policy or network amendment
// is ever sent: those widen an approval beyond this one request (ADR-008 item 3). The decision set
// is fixed, so `hasAllowOnce` is true. `item/permissions/requestApproval` answers with a granted
// permission profile, not a decision (its shape is UNVERIFIED): by the option-set rule it has no
// allow-once (`hasAllowOnce: false`, OQ-42 B), and Deny grants nothing for the turn.
//
// Question — `item/tool/requestUserInput` (EXPERIMENTAL): one step per question (its text, its
// option labels, free text always allowed); the answers go as `answers{<questionId>: {answers:
// [label or free text]}}`. A decline sends the empty answer set, the only decline the protocol
// offers (HR A6). A request holding an `isSecret` question is opened as secret: it is never
// rendered and is declined (ADR-009 D3).
//
// `mcpServer/elicitation/request` is declined (15 §4.4: "question path or decline"; the form path
// is not built). A known request without its thread, turn or item ids is malformed: Deny, no ask
// (15 §1.4 fail closed). Any other method is unknown: the client answers -32601.
//
// Thread policy (ADR-011 item 1 `ProviderPolicy.options`): the default is `approvalPolicy:
// "on-request"`, so every approval comes to DwarfAI. Candidate decision (21 §6):
// `src/main/domain/codexPermissions.ts` is adapted, not transplanted: its rule that no mode may
// lift the sandbox (no `danger-full-access`) is kept; its `--sandbox` argv is replaced, because
// `codex app-server` takes the sandbox as a `thread/start` parameter, not as a flag of `codex exec`.
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import type { QuestionAnswers, QuestionPayload } from '../../../../../kernel/domain/sharedContracts'
import type { PermissionModeSpec } from '../../../domain/profile'
import type { AskInput } from '../../../ports/providerDriver'
import { assertNoForbidden } from '../shared/forbiddenFlags'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The approval kinds DwarfAI answers, by request method. */
const APPROVALS = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions'
} as const

export type ApprovalKind = (typeof APPROVALS)[keyof typeof APPROVALS]

export const USER_INPUT_METHOD = 'item/tool/requestUserInput'
export const ELICITATION_METHOD = 'mcpServer/elicitation/request'

/** Every server request method the driver handles; any other is answered -32601. */
export const KNOWN_REQUESTS: ReadonlySet<string> = new Set([
  ...Object.keys(APPROVALS),
  USER_INPUT_METHOD,
  ELICITATION_METHOD
])

/** What one server request means to the driver. */
export type ServerAsk =
  | {
      readonly kind: 'permission'
      readonly approval: ApprovalKind
      readonly threadId: string
      readonly turnId: string
      readonly ask: Omit<Extract<AskInput, { kind: 'permission' }>, 'providerRequestId'>
    }
  | {
      readonly kind: 'question'
      readonly threadId: string
      readonly turnId: string
      /** Per step, the question id the answer is keyed by. */
      readonly questionIds: readonly string[]
      readonly ask: Omit<Extract<AskInput, { kind: 'question' }>, 'providerRequestId'>
    }
  | { readonly kind: 'decline'; readonly reply: Rec }
  | { readonly kind: 'malformed'; readonly reply: Rec | null }

function ids(params: Rec): { threadId: string; turnId: string } | null {
  const threadId = text(params.threadId)
  const turnId = text(params.turnId)
  if (threadId === null || turnId === null || text(params.itemId) === null) return null
  return { threadId, turnId }
}

function requestText(approval: ApprovalKind, params: Rec): string {
  if (approval === 'commandExecution') return text(params.command) ?? text(params.reason) ?? ''
  return text(params.reason) ?? ''
}

/** Reads one known server request (`KNOWN_REQUESTS`); `redact` runs over its request text. */
export function readServerRequest(
  method: string,
  params: unknown,
  redact: (text: string) => string
): ServerAsk {
  if (method === ELICITATION_METHOD) {
    return { kind: 'decline', reply: { action: 'decline', content: null } }
  }
  const p = isRecord(params) ? params : null
  const where = p === null ? null : ids(p)
  const approval = APPROVALS[method as keyof typeof APPROVALS]
  if (approval !== undefined) {
    if (p === null || where === null) {
      return { kind: 'malformed', reply: denyReply(approval) }
    }
    return {
      kind: 'permission',
      approval,
      ...where,
      ask: {
        kind: 'permission',
        channel: 'driver',
        payload: { toolName: approval, requestText: redact(requestText(approval, p)) },
        options: { hasAllowOnce: approval !== 'permissions', hasRejectOnce: true },
        turnKey: where.turnId
      }
    }
  }
  // item/tool/requestUserInput
  const questions = p === null ? null : p.questions
  if (p === null || where === null || !Array.isArray(questions) || questions.length === 0) {
    return { kind: 'malformed', reply: { answers: {} } }
  }
  const steps: QuestionPayload['steps'] = []
  const questionIds: string[] = []
  let secret = false
  for (const question of questions) {
    const id = isRecord(question) ? text(question.id) : null
    if (!isRecord(question) || id === null) return { kind: 'malformed', reply: { answers: {} } }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const label = isRecord(option) ? text(option.label) : null
          return label === null ? [] : [label]
        })
      : []
    questionIds.push(id)
    steps.push({
      text: redact(text(question.question) ?? text(question.header) ?? ''),
      options,
      allowsFreeText: true
    })
    if (question.isSecret === true) secret = true
  }
  return {
    kind: 'question',
    ...where,
    questionIds,
    ask: {
      kind: 'question',
      channel: 'driver',
      payload: { steps },
      secret,
      turnKey: where.turnId
    }
  }
}

function denyReply(approval: ApprovalKind): Rec {
  return approval === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' }
}

/** The reply to an approval, or null when the decision cannot be sent (Allow without allow-once). */
export function permissionReply(approval: ApprovalKind, decision: 'allow' | 'deny'): Rec | null {
  if (decision === 'deny') return denyReply(approval)
  return approval === 'permissions' ? null : { decision: 'accept' }
}

/**
 * The reply to a question: the empty answer set for a decline, else one entry per answered step;
 * null when an answer does not fit the question (a step out of range, or an option it does not
 * list), so nothing is sent (`refused{'invalid-answer'}`).
 */
export function questionReply(
  ask: { readonly questionIds: readonly string[]; readonly ask: { payload: QuestionPayload } },
  answer: { readonly answers: QuestionAnswers } | { readonly decline: true }
): Rec | null {
  if ('decline' in answer) return { answers: {} }
  const out: Record<string, { answers: string[] }> = {}
  for (const given of answer.answers) {
    const id = ask.questionIds[given.step]
    const step = ask.ask.payload.steps[given.step]
    if (id === undefined || step === undefined) return null
    if (given.option !== undefined && !step.options.includes(given.option)) return null
    const values = [given.option, given.freeText].filter(
      (value): value is string => typeof value === 'string' && value !== ''
    )
    out[id] = { answers: [...(out[id]?.answers ?? []), ...values] }
  }
  return { answers: out }
}

/** The sandbox values a mode may set; `danger-full-access` never (codexPermissions.ts rule). */
const SANDBOXES: readonly string[] = ['read-only', 'workspace-write']
const NO_GATE = { subagentDelegationOn: false, launchedWithLetJevChoose: false }

/**
 * The `thread/start` policy params of a permission mode (ADR-011 item 1): `approvalPolicy:
 * "on-request"` unless the mode sets its own, plus the mode's options; a sandbox that lifts the
 * sandbox or a forbidden option is refused with `HostInvariantError` (ADR-008 item 3).
 */
export function threadPolicy(mode: PermissionModeSpec | null): Record<string, string | boolean> {
  const policy: Record<string, string | boolean> = {
    approvalPolicy: 'on-request',
    ...(mode?.providerArgs.options ?? {})
  }
  if ('sandbox' in policy && !SANDBOXES.includes(String(policy.sandbox))) {
    throw new HostInvariantError('a Codex permission mode never lifts the sandbox')
  }
  assertNoForbidden([], policy, { delegationGate: NO_GATE })
  return policy
}
