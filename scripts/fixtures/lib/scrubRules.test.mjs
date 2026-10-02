import { describe, expect, it } from 'vitest'
import { FIXED_EPOCH_MS, findSurvivors, scrubFixtureSet } from './scrubRules.mjs'

/**
 * L7 pure tests of the scrub rules (17 §1.4 "Redaction (scrub rules)"). Every personal value here
 * is synthetic: the maintainer is `canary.user` on `canary-host`, and no value has ever been a real
 * path, name, address or credential.
 */

const IDENTITY = {
  home: 'C:\\Users\\canary.user',
  user: 'canary.user',
  host: 'canary-host',
  repoRoot: 'C:\\Users\\canary.user\\AppData\\Local\\Temp\\dwarfai-rec-1'
}

/** One JSONL document from records, one record per line. */
function jsonl(name, records) {
  return { name, text: records.map((record) => JSON.stringify(record)).join('\n') + '\n' }
}

/** The records of a scrubbed JSONL document. */
function records(document) {
  return document.text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

describe('scrub rules (17 §1.4)', () => {
  it('[ADR-008] a home directory, user name, host name and e-mail are replaced by their placeholders', () => {
    const raw = jsonl('simple-turn.jsonl', [
      {
        type: 'system',
        cwd: 'C:\\Users\\canary.user\\AppData\\Local\\Temp\\dwarfai-rec-1',
        file: 'C:\\Users\\canary.user\\AppData\\Local\\Temp\\dwarfai-rec-1\\src\\a.ts',
        config: 'C:/Users/canary.user/.config/tool/settings.json',
        encoded: 'C--Users-canary-user-AppData-Local-Temp-dwarfai-rec-1',
        other: '/home/someone/project/readme.md',
        tool: '/usr/local/bin/node',
        url: 'https://example.com/v1/models',
        text: 'Hi canary.user, running on canary-host as CANARY.USER; mail canary.user@example.com'
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [record] = records(scrubbed)

    expect(record).toEqual({
      type: 'system',
      cwd: '<REPO>',
      file: '<REPO>\\src\\a.ts',
      config: '<HOME>/.config/tool/settings.json',
      encoded: '<REPO>',
      other: '<HOME>/project/readme.md',
      tool: '<PATH>',
      url: 'https://example.com/v1/models',
      text: 'Hi <USER>, running on <HOST> as <USER>; mail <EMAIL>'
    })
    for (const value of ['canary.user', 'canary-user', 'canary-host', 'someone', '@example.com']) {
      expect(scrubbed.text.toLowerCase()).not.toContain(value)
    }
  })

  it('[ADR-008] the maintainer home is replaced whole, with a space in it or outside Users and home', () => {
    const spaced = { home: 'C:\\Users\\Canary User', user: 'j', host: 'canary-host', repoRoot: '' }
    const elsewhere = { home: '/srv/people/j', user: 'j', host: 'canary-host', repoRoot: '' }
    const raw = jsonl('simple-turn.jsonl', [
      { a: 'C:\\Users\\Canary User\\.config\\x.json', b: '/srv/people/j/.config/x.json' }
    ])

    const [fromSpaced] = records(scrubFixtureSet([raw], spaced)[0])
    const [fromElsewhere] = records(scrubFixtureSet([raw], elsewhere)[0])

    expect(fromSpaced.a).toBe('<HOME>\\.config\\x.json')
    expect(fromElsewhere.b).toBe('<HOME>/.config/x.json')
  })

  it('[ADR-026] an sk- key, a bearer token and a hook-token-shaped value never survive scrubbing', () => {
    const skKey = 'sk-ant-api03-CANARYcanary0123456789CANARYcanary0123456789'
    const bearer = 'canaryBearer.0123.token'
    const hookToken = 'd4e5f6a7'.repeat(8)
    const raw = {
      name: 'simple-turn-stderr.jsonl',
      text: [
        JSON.stringify({ env: { API_KEY: skKey }, headers: { authorization: `Bearer ${bearer}` } }),
        `plain text line: token=${hookToken} and ${skKey}`,
        `{"broken": "Authorization: bearer ${bearer}"`
      ].join('\n')
    }

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)

    for (const secret of [skKey, bearer, hookToken]) expect(scrubbed.text).not.toContain(secret)
    expect(scrubbed.text).toContain('Bearer [redacted]')
    expect(scrubbed.text).toContain('token=[redacted]')
  })

  it('[ADR-008] a provider account or organization id and a Windows SID are replaced', () => {
    const raw = jsonl('simple-turn.jsonl', [
      {
        type: 'system',
        account: { accountUuid: 'acct-canary-0001', organization_id: 4242, orgId: 'org-Canary42' },
        user_id: 'user-canary-0001',
        owner: 'S-1-5-5-0-4242'
      }
    ])

    const [record] = records(scrubFixtureSet([raw], IDENTITY)[0])

    expect(record).toEqual({
      type: 'system',
      account: {
        accountUuid: '<ACCOUNT_ID>',
        organization_id: '<ACCOUNT_ID>',
        orgId: '<ACCOUNT_ID>'
      },
      user_id: '<ACCOUNT_ID>',
      owner: '<SID>'
    })
  })

  it('[C-19] the same provider session, message and tool-call id maps to the same fake UUID inside one fixture set', () => {
    const session = '7c1e2a40-55aa-4c3b-9d10-aabbccddeeff'
    const received = jsonl('simple-turn.jsonl', [
      { type: 'system', session_id: session, model: 'claude-canary-4-5' },
      {
        type: 'assistant',
        session_id: session,
        message: {
          id: 'msg_01CanaryMessage0001',
          content: [{ type: 'tool_use', id: 'toolu_01CanaryTool0001', name: 'Read' }]
        }
      },
      { type: 'user', session_id: session, tool_use_id: 'toolu_01CanaryTool0001' },
      { type: 'result', session_id: session, text: `resume with --resume ${session}` }
    ])
    const sent = jsonl('simple-turn-sent.jsonl', [
      { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: session } }
    ])

    const [out, outSent] = scrubFixtureSet([received, sent], IDENTITY)
    const [system, assistant, user, result] = records(out)
    const [request] = records(outSent)

    const fake = system.session_id
    expect(fake).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/)
    expect([assistant.session_id, user.session_id, result.session_id]).toEqual([fake, fake, fake])
    expect(request.params.sessionId).toBe(fake)
    expect(result.text).toBe(`resume with --resume ${fake}`)
    const toolId = assistant.message.content[0].id
    expect(toolId).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/)
    expect(user.tool_use_id).toBe(toolId)
    expect(new Set([fake, toolId, assistant.message.id]).size).toBe(3)
    // Protocol request ids and model names are not provider ids: they stay.
    expect(request.id).toBe(3)
    expect(system.model).toBe('claude-canary-4-5')
    expect(out.text + outSent.text).not.toMatch(/Canary(?:Message|Tool)|7c1e2a40/)
  })

  it('[C-04] timestamps are shifted to the fixed epoch and a 2 999 ms gap stays 2 999 ms', () => {
    const spawnedAt = Date.parse('2026-09-30T14:21:07.250Z')
    const timing = jsonl('exits-at-once-timing.jsonl', [
      { at: spawnedAt, event: 'spawned' },
      { at: spawnedAt + 2_999, event: 'exit', code: 1 }
    ])
    const transcript = jsonl('exits-at-once.jsonl', [
      { type: 'system', timestamp: new Date(spawnedAt + 500).toISOString() },
      { type: 'result', time: { created: Math.floor((spawnedAt + 2_000) / 1_000) } }
    ])

    const [outTiming, outTranscript] = scrubFixtureSet([timing, transcript], IDENTITY)
    const [spawned, exit] = records(outTiming)
    const [system, result] = records(outTranscript)

    expect(spawned.at).toBe(FIXED_EPOCH_MS + 250)
    expect(exit.at - spawned.at).toBe(2_999)
    expect(Date.parse(system.timestamp) - spawned.at).toBe(500)
    expect(system.timestamp).toBe('2025-01-01T00:00:00.750Z')
    expect(result.time.created).toBe((FIXED_EPOCH_MS + 2_000) / 1_000)
  })

  it('[ADR-008] scrubbing an already scrubbed file changes nothing', () => {
    const session = '7c1e2a40-55aa-4c3b-9d10-aabbccddeeff'
    const raw = [
      jsonl('simple-turn.jsonl', [
        {
          type: 'system',
          session_id: session,
          cwd: IDENTITY.repoRoot,
          timestamp: '2026-09-30T14:21:07.250Z',
          note: 'C:\\Users\\canary.user\\.ssh and canary.user@example.com on canary-host'
        },
        { type: 'assistant', session_id: session, message: { id: 'msg_01CanaryMessage0001' } },
        { type: 'result', at: Date.parse('2026-09-30T14:21:10.249Z'), text: 'Bearer abc.def' }
      ]),
      {
        name: 'simple-turn-stderr.jsonl',
        text: `not json: ${IDENTITY.repoRoot}\\x and /usr/bin/git sk-${'a1B2'.repeat(6)}\r\n`
      },
      {
        name: 'simple-turn-probe.json',
        text: JSON.stringify({ version: '2.1.14', home: IDENTITY.home, session_id: session })
      },
      // A negative fixture: a truncated JSON document is scrubbed as text.
      { name: 'truncated-probe.json', text: `{"version": "2.1.14", "home": "${IDENTITY.user}"\n` }
    ]

    const once = scrubFixtureSet(raw, IDENTITY)
    const twice = scrubFixtureSet(once, IDENTITY)

    expect(once.map(({ text }) => text).join('')).not.toContain('canary')
    expect(twice).toEqual(once)
  })

  it('[ADR-008, ADR-026] the survivor check names each personal value or secret left in a text, and nothing in a scrubbed one', () => {
    const leaky = [
      '{"cwd":"C:\\\\Users\\\\canary.user\\\\work"}',
      'by canary.user on canary-host',
      'mail canary.user@example.com',
      'Authorization: Bearer abc.def',
      'owner S-1-5-5-0-4242',
      `key sk-${'a1B2'.repeat(6)}`,
      `hook ${'d4e5f6a7'.repeat(8)}`
    ].join('\n')

    const rules = findSurvivors(leaky, IDENTITY).map(({ rule, line }) => `${line}:${rule}`)

    expect(rules).toEqual([
      '1:home',
      '2:host',
      '2:user',
      '3:email',
      '4:bearer',
      '5:sid',
      '6:secret',
      '7:secret'
    ])
    const [scrubbed] = scrubFixtureSet([{ name: 'leaky.jsonl', text: leaky }], IDENTITY)
    expect(findSurvivors(scrubbed.text, IDENTITY)).toEqual([])
  })
})
