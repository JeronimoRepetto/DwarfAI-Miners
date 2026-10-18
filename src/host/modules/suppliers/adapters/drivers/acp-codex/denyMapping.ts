// The Codex acp Deny (15 §2.7 ACP row, §4.5; HR A2, D4), as the shared client's `permissionReply`
// hook: codex-acp keeps the native Codex decision of every option in `_meta.codex.decision`
// (cxacp@bf37821 test data). A Deny prefers the `reject_once` option whose decision is `decline`
// (Codex rejects the action and continues the turn), never a `cancel` listed before it (reject
// **and** interrupt). Otherwise the hook answers `null` and the client's default mapping applies:
// the first `reject_once`, else a JSON-RPC error (HR A3); Allow is always the default
// (`allow_once` by `optionId`, never `allow_always`). The option's kind stays the contract: the
// client honours a choice only inside the decision's own kind, and this hook never offers another.
// Pure: no I/O.
import type { AcpPermissionOption, PermissionReplyHook } from '../acp/client/permissionMapping'

/** The Codex decision `codex-acp` keeps for one option, if it carries one. */
function codexDecision(option: AcpPermissionOption): string | null {
  const codex = (option.meta as { codex?: { decision?: unknown } } | undefined)?.codex
  return typeof codex?.decision === 'string' ? codex.decision : null
}

export const codexDecline: PermissionReplyHook = (options, decision) => {
  if (decision !== 'deny') return null
  const decline = options.find(
    (option) => option.kind === 'reject_once' && codexDecision(option) === 'decline'
  )
  return decline?.optionId ?? null
}
