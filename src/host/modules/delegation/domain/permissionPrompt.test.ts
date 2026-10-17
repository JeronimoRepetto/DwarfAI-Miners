import { describe, expect, it } from 'vitest'
import {
  PERMISSION_DENIED_MESSAGE,
  PERMISSION_UNAVAILABLE_MESSAGE,
  permissionPromptReply,
  readPermissionPromptCall
} from './permissionPrompt'

// AMENDMENT-21 (owner, 2026-10-17): the `permission` tool reads Claude's permission-prompt-tool
// input and answers its shape (15 §2.7 row "Claude --permission-prompt-tool"). The input below is
// the SP-08 recording's call (fixtures/claude/stream-json/2.1.x/sp08-allow-mcp.jsonl).
const RECORDED = {
  tool_name: 'Write',
  input: { file_path: '<REPO>\\sp08-allow-marker.txt', content: 'marker' },
  tool_use_id: '00000000-0000-4000-8000-000000000001'
}

describe('readPermissionPromptCall', () => {
  it('[ADR-010] the recorded prompt-tool call reads as its tool name, input and tool use id', () => {
    expect(readPermissionPromptCall(RECORDED)).toEqual({
      toolName: 'Write',
      input: { file_path: '<REPO>\\sp08-allow-marker.txt', content: 'marker' },
      toolUseId: '00000000-0000-4000-8000-000000000001'
    })
  })

  it('[ADR-010] a call without a tool name, an object input or a tool use id is malformed (fail closed)', () => {
    const malformed: unknown[] = [
      null,
      'Write',
      [],
      { ...RECORDED, tool_name: '' },
      { ...RECORDED, tool_name: '  ' },
      { ...RECORDED, tool_name: 7 },
      { ...RECORDED, input: 'rm -rf /' },
      { ...RECORDED, input: null },
      { ...RECORDED, input: ['a'] },
      { ...RECORDED, tool_use_id: undefined },
      { ...RECORDED, tool_use_id: '' },
      { tool_name: 'Write', input: {} }
    ]
    for (const args of malformed) expect(readPermissionPromptCall(args)).toBeNull()
  })
})

describe('permissionPromptReply (15 §2.7)', () => {
  it('[ADR-010] Allow answers behavior allow with the call input unchanged as updatedInput', () => {
    const call = readPermissionPromptCall(RECORDED)
    expect(call).not.toBeNull()
    expect(permissionPromptReply(call, 'allow')).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '<REPO>\\sp08-allow-marker.txt', content: 'marker' }
    })
  })

  it('[ADR-010] Deny answers behavior deny with a message, and a bridge failure denies with its own', () => {
    const call = readPermissionPromptCall(RECORDED)
    expect(permissionPromptReply(call, 'deny')).toEqual({
      behavior: 'deny',
      message: PERMISSION_DENIED_MESSAGE
    })
    expect(permissionPromptReply(call, 'unavailable')).toEqual({
      behavior: 'deny',
      message: PERMISSION_UNAVAILABLE_MESSAGE
    })
    // A malformed call can never be allowed: there is no input to hand back.
    expect(permissionPromptReply(null, 'allow')).toEqual({
      behavior: 'deny',
      message: PERMISSION_UNAVAILABLE_MESSAGE
    })
    expect(PERMISSION_DENIED_MESSAGE).not.toEqual(PERMISSION_UNAVAILABLE_MESSAGE)
  })
})
