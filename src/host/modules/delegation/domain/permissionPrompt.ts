// Claude's permission prompt tool as the Host serves it (AMENDMENT-21, owner-approved 2026-10-17;
// 15 §2.7 row "Claude --permission-prompt-tool"; ADR-010 items 1, 5).
//
// - `readPermissionPromptCall` reads the tool's input `{ tool_name, input, tool_use_id }` (the
//   SP-08 recording's shape). A call without a non-blank tool name, an object input or a tool use
//   id is malformed: no ask opens for it and it is denied (fail closed, 15 §2.7 "Unknown /
//   malformed set").
// - `permissionPromptReply` is the tool's answer: Allow → `{ behavior: 'allow', updatedInput }`
//   with the call's own input unchanged (an Allow without `updatedInput` was once read as a deny);
//   Deny → `{ behavior: 'deny', message }`; any bridge failure → a deny too. The two messages are
//   read by the model, never shown to the person.
//
// Pure: no I/O (05 §2.2, R1).

/** One permission prompt, as Claude asks it. */
export interface PermissionPromptCall {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  /** The `tool_use` block's id: the ask's provider request id. */
  readonly toolUseId: string
}

/** The tool's answer, Claude's permission-prompt-tool shape (15 §2.7). */
export type PermissionPromptReply =
  | { readonly behavior: 'allow'; readonly updatedInput: Readonly<Record<string, unknown>> }
  | { readonly behavior: 'deny'; readonly message: string }

/** The person answered Deny. */
export const PERMISSION_DENIED_MESSAGE = 'The person denied this tool use in DwarfAI-Miners.'

/** No answer could be had (malformed call, session gone, bridge error): denied, fail closed. */
export const PERMISSION_UNAVAILABLE_MESSAGE =
  'DwarfAI-Miners could not ask the person about this tool use, so it is denied.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readPermissionPromptCall(args: unknown): PermissionPromptCall | null {
  if (!isRecord(args)) return null
  const { tool_name: toolName, input, tool_use_id: toolUseId } = args
  if (typeof toolName !== 'string' || toolName.trim() === '') return null
  if (!isRecord(input)) return null
  if (typeof toolUseId !== 'string' || toolUseId === '') return null
  return { toolName, input, toolUseId }
}

export function permissionPromptReply(
  call: PermissionPromptCall | null,
  decision: 'allow' | 'deny' | 'unavailable'
): PermissionPromptReply {
  if (call !== null && decision === 'allow') {
    return { behavior: 'allow', updatedInput: call.input }
  }
  return {
    behavior: 'deny',
    message:
      call !== null && decision === 'deny'
        ? PERMISSION_DENIED_MESSAGE
        : PERMISSION_UNAVAILABLE_MESSAGE
  }
}
