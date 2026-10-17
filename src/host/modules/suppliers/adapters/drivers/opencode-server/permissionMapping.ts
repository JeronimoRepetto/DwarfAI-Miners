// OpenCode's HTTP answer vocabulary (15 §2.7 rows "OpenCode HTTP" and "OpenCode /question"). Pure.
//
// Permission: Allow is `once`, Deny is `reject`; `always` is never sent (ADR-008 item 3), although
// every ask OpenCode lists offers it (`permission.asked.always`). The request is
// `POST /permission/{id}/reply?directory=<cwd>` with `{reply}`, the route and body S-011-1 recorded
// at OpenCode 1.18.32 (`fixtures/opencode/http-server/1.18.32/s0111-person-run-deny*`: 200 `true`).
//
// Question: `POST /question/{id}/reply` with one array of selected labels per step, and the decline
// `POST /question/{id}/reject` (`oc@b471c2b:…/groups/question.ts:12-16`). The body field name is
// UNVERIFIED (no question was recorded; `question` is U→none in row O1), so no driver path offers a
// question card on it yet.
import type { QuestionAnswers } from '../../../../../kernel/domain/sharedContracts'

/** One HTTP call of the OpenCode server, as data (the transport sends it). */
export interface ServerRequest {
  readonly method: 'GET' | 'POST'
  /** Path and query, already encoded. */
  readonly path: string
  readonly body?: unknown
}

export type PermissionReply = 'once' | 'reject'

/** The reply word for a decision: never `always`. */
export function permissionReply(decision: 'allow' | 'deny'): PermissionReply {
  return decision === 'allow' ? 'once' : 'reject'
}

const scoped = (path: string, directory: string): string =>
  `${path}?directory=${encodeURIComponent(directory)}`

export function permissionReplyRequest(
  requestId: string,
  decision: 'allow' | 'deny',
  directory: string
): ServerRequest {
  return {
    method: 'POST',
    path: scoped(`/permission/${encodeURIComponent(requestId)}/reply`, directory),
    body: { reply: permissionReply(decision) }
  }
}

/** A question answer: per step, the chosen label or the free text, in step order. */
export function questionReplyRequest(
  requestId: string,
  answers: QuestionAnswers,
  directory: string
): ServerRequest {
  const steps = [...answers].sort((a, b) => a.step - b.step)
  return {
    method: 'POST',
    path: scoped(`/question/${encodeURIComponent(requestId)}/reply`, directory),
    body: {
      answers: steps.map((answer) =>
        answer.option !== undefined
          ? [answer.option]
          : answer.freeText !== undefined
            ? [answer.freeText]
            : []
      )
    }
  }
}

/** A declined question (ADR-009 D3 `{ decline: true }`). */
export function questionRejectRequest(requestId: string, directory: string): ServerRequest {
  return {
    method: 'POST',
    path: scoped(`/question/${encodeURIComponent(requestId)}/reject`, directory)
  }
}
