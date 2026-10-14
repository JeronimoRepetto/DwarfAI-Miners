// The tool side of a delegation failure (16 §5.4 "Domain failure → tool failure kind"; ADR-013).
//
// - `toolFailure` maps a 06 `DelegationFailure`, or a refusal that creates no delegation (the
//   limits and an unknown ticket), to the `{ kind, detail }` of a `failed` tool result. The tool
//   vocabulary is the transplanted `DelegationFailureKind`. `handoff-failed` and `parent-gone` have
//   no tool result (the first happens only on the turn-input path, the second has no parent to
//   receive it), so they map to `null`.
// - Every `detail` ends with `NATIVE_SUBAGENT_FALLBACK_SENTENCE`, so a parent that cannot delegate
//   falls back to its own subagent instead of waiting. The reason before it comes from the
//   caller; this module writes no reason text of its own (the `effort-ceiling` reason sentence is
//   design's, ADR-028).
// - `producesParentLine`: every 06 failure but `parent-gone` gives the parent's chat the one
//   PO #45 line (INV-82); the limits and an unknown ticket create no delegation and no line.
//
// Pure: no I/O (05 §2.2, R1).
import type { DelegationFailure } from './delegation'
import type { DelegationLimitRefusal } from './limits'

/** Ends every failure `detail` and both tool descriptions (16 §5.4). */
export const NATIVE_SUBAGENT_FALLBACK_SENTENCE =
  'Use your own native subagent mechanism for this subtask instead.'

/** The tool result's `failure.kind` (16 §5.4; the transplanted `DelegationFailureKind`). */
export type DelegationToolFailureKind =
  | 'disabled'
  | 'jev-unreachable'
  | 'jev-unsure'
  | 'provider-not-launchable'
  | 'launch-failed'
  | 'concurrency-limit'
  | 'depth-exceeded'
  | 'unknown-ticket'

/** The `failure` of a `{ status: 'failed' }` tool result (16 §5.4). */
export interface DelegationToolFailure {
  readonly kind: DelegationToolFailureKind
  readonly detail: string
}

/** What a tool failure is made from. */
export type ToolFailureSource = DelegationFailure | DelegationLimitRefusal | 'unknown-ticket'

const TOOL_KIND: Readonly<Record<ToolFailureSource, DelegationToolFailureKind | null>> = {
  'gate-closed': 'disabled',
  'jev-unreachable': 'jev-unreachable',
  // effort-ceiling included (ADR-028 D2)
  'jev-could-not-choose': 'jev-unsure',
  'no-provider': 'provider-not-launchable',
  'worker-failed': 'launch-failed',
  // no tool kind of its own exists (16 §13 O-16-04)
  'worker-lost': 'launch-failed',
  'handoff-failed': null,
  'parent-gone': null,
  'concurrency-limit': 'concurrency-limit',
  'depth-exceeded': 'depth-exceeded',
  'unknown-ticket': 'unknown-ticket'
}

const PARENT_LINE: Readonly<Record<ToolFailureSource, boolean>> = {
  'gate-closed': true,
  'jev-unreachable': true,
  'jev-could-not-choose': true,
  'no-provider': true,
  'worker-failed': true,
  'worker-lost': true,
  'handoff-failed': true,
  'parent-gone': false,
  'concurrency-limit': false,
  'depth-exceeded': false,
  'unknown-ticket': false
}

/** The tool failure for `source`, or `null` when no tool result exists for it. */
export function toolFailure(
  source: ToolFailureSource,
  reason?: string
): DelegationToolFailure | null {
  const kind = TOOL_KIND[source]
  if (kind === null) return null
  const lead = reason?.trim() ?? ''
  const detail =
    lead === '' ? NATIVE_SUBAGENT_FALLBACK_SENTENCE : `${lead} ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
  return { kind, detail }
}

/** Whether the parent's chat gets the one PO #45 failure line (INV-82). */
export function producesParentLine(source: ToolFailureSource): boolean {
  return PARENT_LINE[source]
}
