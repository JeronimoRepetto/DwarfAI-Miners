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
  /** The option's `_meta`, kept for a driver whose agent names its native decision there. */
  readonly meta?: Readonly<Record<string, unknown>>
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

/**
 * A driver's choice of the option for one decision, by optionId (15 §2.7: with
 * `_meta.codex.decision`, prefer the native `decline`); `null` leaves the default mapping.
 */
export type PermissionReplyHook = (
  options: readonly AcpPermissionOption[],
  decision: 'allow' | 'deny'
) => string | null

/** The options of a request as the driver reads them, each with its `_meta` when it has one. */
export function optionsOf(
  options: readonly { optionId: string; kind: string; _meta?: unknown }[]
): AcpPermissionOption[] {
  return options.map(({ optionId, kind, _meta }) =>
    _meta !== null && typeof _meta === 'object' && !Array.isArray(_meta)
      ? { optionId, kind, meta: { ..._meta } }
      : { optionId, kind }
  )
}

/**
 * The reply of one decision: the hook's option when it is one of the request's options of the
 * decision's own kind (`allow_once` for Allow, `reject_once` for Deny), else the default mapping.
 * A hook can never widen an answer to an "always" option (ADR-008 item 3).
 */
export function replyWith(
  options: readonly AcpPermissionOption[],
  decision: 'allow' | 'deny',
  hook?: PermissionReplyHook
): PermissionReply {
  const wanted = decision === 'allow' ? 'allow_once' : 'reject_once'
  const chosen = hook?.(options, decision) ?? null
  const valid = options.some((option) => option.optionId === chosen && option.kind === wanted)
  return valid && chosen !== null
    ? { kind: 'select', optionId: chosen }
    : permissionReply(options, decision)
}
