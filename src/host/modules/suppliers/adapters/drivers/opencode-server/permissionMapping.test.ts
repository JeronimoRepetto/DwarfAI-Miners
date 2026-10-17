// 15 §2.7 OpenCode rows: the reply vocabulary, checked against the S-011-1 recording.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  permissionReply,
  permissionReplyRequest,
  questionRejectRequest,
  questionReplyRequest
} from './permissionMapping'

const SENT = fileURLToPath(
  new URL(
    '../../../../../../../fixtures/opencode/http-server/1.18.32/s0111-person-run-deny-sent.jsonl',
    import.meta.url
  )
)

describe('OpenCode permission mapping', () => {
  it('[C-06, C-07] Allow replies once and Deny replies reject, never always', () => {
    expect(permissionReply('allow')).toBe('once')
    expect(permissionReply('deny')).toBe('reject')
    const allow = permissionReplyRequest('per_1', 'allow', '/work/mine')
    const deny = permissionReplyRequest('per_1', 'deny', '/work/mine')
    expect(allow).toEqual({
      method: 'POST',
      path: '/permission/per_1/reply?directory=%2Fwork%2Fmine',
      body: { reply: 'once' }
    })
    expect(deny.body).toEqual({ reply: 'reject' })
    expect(JSON.stringify([allow, deny])).not.toContain('always')
    // The recorded Deny of S-011-1 (OpenCode 1.18.32) carried exactly this body, and was accepted.
    const recorded = readFileSync(SENT, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method: string; body?: { reply?: string } })
    const replies = recorded.filter((request) => request.body?.reply !== undefined)
    expect(replies).toHaveLength(1)
    expect({ method: replies[0]?.method, body: replies[0]?.body }).toEqual({
      method: deny.method,
      body: deny.body
    })
  })

  it('[C-09] a question reply is one array of labels per step and a decline is the reject route', () => {
    expect(
      questionReplyRequest(
        'que_1',
        [
          { step: 1, freeText: 'tomorrow' },
          { step: 0, option: 'Yes' }
        ],
        '/w'
      )
    ).toEqual({
      method: 'POST',
      path: '/question/que_1/reply?directory=%2Fw',
      body: { answers: [['Yes'], ['tomorrow']] }
    })
    expect(questionRejectRequest('que_1', '/w')).toEqual({
      method: 'POST',
      path: '/question/que_1/reject?directory=%2Fw'
    })
  })
})
