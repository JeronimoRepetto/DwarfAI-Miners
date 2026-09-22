import { describe, expect, it } from 'vitest'
import { buildOpenCodePermissionPush } from './permissionPushPayload'

/**
 * The plugin's own address, exactly as it arrives: a bound `URL` instance
 * (docs/opencode-format.md Row 15 — `typeof ctx.serverUrl` is `"object"`, not
 * `"string"`), read back live against the OS-reported LISTEN port in Row 16 /
 * #588 T2's own STEP 0 measurement.
 */
const serverUrl = new URL('http://127.0.0.1:63417/')

/**
 * Field shapes come straight off docs/opencode-format.md Row 15/Row 16 — the
 * two events this app's OpenCode plugin ever forwards, reproduced verbatim
 * from what was captured there.
 */
const asked = {
  type: 'permission.asked',
  properties: {
    id: 'per_abc123',
    sessionID: 'ses_xyz789',
    permission: 'bash',
    patterns: ['echo hello'],
    metadata: { command: 'echo hello' },
    always: ['echo *'],
    tool: { messageID: 'msg_1', callID: 'call_1' }
  }
}

const replied = {
  type: 'permission.replied',
  properties: {
    sessionID: 'ses_xyz789',
    requestID: 'per_abc123',
    reply: 'once'
  }
}

describe('buildOpenCodePermissionPush', () => {
  it('builds a push payload from a permission.asked event', () => {
    expect(buildOpenCodePermissionPush(asked, serverUrl)).toEqual({
      provider: 'opencode',
      kind: 'asked',
      serverUrl: 'http://127.0.0.1:63417/',
      sessionId: 'ses_xyz789',
      requestId: 'per_abc123',
      permission: 'bash',
      patterns: ['echo hello'],
      command: 'echo hello',
      callId: 'call_1'
    })
  })

  it('builds a push payload from a permission.replied event', () => {
    expect(buildOpenCodePermissionPush(replied, serverUrl)).toEqual({
      provider: 'opencode',
      kind: 'replied',
      serverUrl: 'http://127.0.0.1:63417/',
      sessionId: 'ses_xyz789',
      requestId: 'per_abc123',
      reply: 'once'
    })
  })

  it('carries serverUrl as a plain string, never the URL instance', () => {
    // ctx.serverUrl is a URL object (Row 15), so this function does the
    // .href conversion itself rather than trusting a caller to stringify it
    // correctly before the payload crosses to JSON on the wire.
    const result = buildOpenCodePermissionPush(asked, serverUrl)
    expect(typeof result?.serverUrl).toBe('string')
    expect(result?.serverUrl).toBe('http://127.0.0.1:63417/')
  })

  it('omits the optional asked fields when the source carried none of them', () => {
    expect(
      buildOpenCodePermissionPush(
        {
          type: 'permission.asked',
          properties: { id: 'per_1', sessionID: 'ses_1', permission: 'bash' }
        },
        serverUrl
      )
    ).toEqual({
      provider: 'opencode',
      kind: 'asked',
      serverUrl: 'http://127.0.0.1:63417/',
      sessionId: 'ses_1',
      requestId: 'per_1',
      permission: 'bash'
    })
  })

  it('drops patterns rather than keeping a partially-malformed array', () => {
    expect(
      buildOpenCodePermissionPush(
        {
          type: 'permission.asked',
          properties: {
            id: 'per_1',
            sessionID: 'ses_1',
            permission: 'bash',
            patterns: ['echo *', 7]
          }
        },
        serverUrl
      )
    ).toEqual({
      provider: 'opencode',
      kind: 'asked',
      serverUrl: 'http://127.0.0.1:63417/',
      sessionId: 'ses_1',
      requestId: 'per_1',
      permission: 'bash'
    })
  })

  it.each([
    ['a non-object event', 'nope'],
    ['null', null],
    ['an array', [asked]],
    ['an unrecognized type', { type: 'session.idle', properties: {} }],
    ['missing properties', { type: 'permission.asked' }],
    ['non-object properties', { type: 'permission.asked', properties: 'nope' }],
    [
      'an asked event missing id',
      { type: 'permission.asked', properties: { sessionID: 's', permission: 'bash' } }
    ],
    [
      'an asked event missing sessionID',
      { type: 'permission.asked', properties: { id: 'p', permission: 'bash' } }
    ],
    [
      'an asked event missing permission',
      { type: 'permission.asked', properties: { id: 'p', sessionID: 's' } }
    ],
    [
      'a replied event missing requestID',
      { type: 'permission.replied', properties: { sessionID: 's', reply: 'once' } }
    ],
    [
      'a replied event missing reply',
      { type: 'permission.replied', properties: { sessionID: 's', requestID: 'p' } }
    ]
  ])('rejects %s', (_label, event) => {
    expect(buildOpenCodePermissionPush(event, serverUrl)).toBeNull()
  })

  it('is not fooled by a type on the prototype chain', () => {
    expect(
      buildOpenCodePermissionPush(
        JSON.parse('{"__proto__":{"type":"permission.asked"}}'),
        serverUrl
      )
    ).toBeNull()
  })
})
