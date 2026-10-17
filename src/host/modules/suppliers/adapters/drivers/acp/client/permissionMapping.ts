// The ACP rows of 15 §2.7 (frozen): Allow / Deny → a `session/request_permission` reply. Allow is
// the first option whose `kind` is `allow_once`, chosen by its `optionId` (never by its label,
// `cxacp@bf37821:docs/permission-extension.md:16`); Deny is the option whose `kind` is
// `reject_once`. `allow_always` and `reject_always` are never sent (ADR-008 item 3). An option set
// without `allow_once` is reported with `hasAllowOnce: false` (OQ-42 B), and an Allow for it is
// refused, never widened. A Deny with no `reject_once` either is a JSON-RPC error (fail closed,
// HR A3). Pure: no I/O.
import type { PermissionPayload } from '../../../../../../kernel/domain/sharedContracts'

/** One `PermissionOption` of an ACP permission request, as the driver reads it. */
export interface AcpPermissionOption {
  readonly optionId: string
  readonly kind: string
}

/** What one Allow or Deny becomes on the wire. */
export type PermissionReply =
  /** `{ outcome: { outcome: 'selected', optionId } }` */
  | { readonly kind: 'select'; readonly optionId: string }
  /** A Deny the option set cannot carry: the request is answered with a JSON-RPC error. */
  | { readonly kind: 'error' }
  /** An Allow the option set cannot carry without widening it: nothing is sent. */
  | { readonly kind: 'refuse' }

export function optionSet(options: readonly AcpPermissionOption[]): {
  hasAllowOnce: boolean
  hasRejectOnce: boolean
} {
  return {
    hasAllowOnce: options.some((option) => option.kind === 'allow_once'),
    hasRejectOnce: options.some((option) => option.kind === 'reject_once')
  }
}

export function permissionReply(
  options: readonly AcpPermissionOption[],
  decision: 'allow' | 'deny'
): PermissionReply {
  const wanted = decision === 'allow' ? 'allow_once' : 'reject_once'
  const chosen = options.find((option) => option.kind === wanted)
  if (chosen !== undefined) return { kind: 'select', optionId: chosen.optionId }
  return decision === 'allow' ? { kind: 'refuse' } : { kind: 'error' }
}

/** A card line is one line, capped before redaction (the `toolSummary` rule of the drivers). */
const REQUEST_TEXT_MAX_CHARS = 240

/** The 06 §0.2 card payload of a request: the tool's name and one redacted line. */
export function permissionPayload(
  toolCall: {
    readonly name?: string | null
    readonly kind?: string | null
    readonly title?: string | null
  },
  redact: (text: string) => string
): PermissionPayload {
  const toolName = nonEmpty(toolCall.name) ?? nonEmpty(toolCall.kind) ?? 'tool'
  const firstLine = (nonEmpty(toolCall.title) ?? toolName).split(/\r?\n/)[0] ?? toolName
  return { toolName, requestText: redact(firstLine.slice(0, REQUEST_TEXT_MAX_CHARS)) }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
