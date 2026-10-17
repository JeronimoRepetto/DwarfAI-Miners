// The Codex acp Deny (15 §2.7 ACP row, §4.5; HR A2, D4): codex-acp keeps the native Codex decision
// of every option in `_meta.codex.decision` (cxacp@bf37821 test data). A Deny prefers the
// `reject_once` option whose decision is `decline` (Codex rejects the action and continues the
// turn), never a `cancel` listed before it (reject **and** interrupt); without such an option it is
// the generic ACP reply: the first `reject_once`, else a JSON-RPC error (fail closed, HR A3). The
// option's kind stays the contract: a `decline` on any other kind is never sent for a Deny. Allow is
// the generic reply (`allow_once` by `optionId`, never `allow_always`). Pure: no I/O.
import { permissionReply, type PermissionReply } from '../acp/client/permissionMapping'

/** One option of a codex-acp `session/request_permission`, with the adapter's own `_meta`. */
export interface CodexPermissionOption {
  readonly optionId: string
  readonly kind: string
  readonly _meta?: unknown
}

/** The Codex decision `codex-acp` keeps for one option, if it carries one. */
function codexDecision(option: CodexPermissionOption): string | null {
  const codex = (option._meta as { codex?: { decision?: unknown } } | null | undefined)?.codex
  return typeof codex?.decision === 'string' ? codex.decision : null
}

export function codexPermissionReply(
  options: readonly CodexPermissionOption[],
  decision: 'allow' | 'deny'
): PermissionReply {
  if (decision === 'deny') {
    const decline = options.find(
      (option) => option.kind === 'reject_once' && codexDecision(option) === 'decline'
    )
    if (decline !== undefined) return { kind: 'select', optionId: decline.optionId }
  }
  return permissionReply(options, decision)
}
