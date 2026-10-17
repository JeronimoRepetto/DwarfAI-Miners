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

  it('[ADR-008] a thinking block signature is replaced whole, so a base64 run after a + is neither a path nor a survivor', () => {
    // Synthetic, real-shaped: standard base64 of 660 made-up bytes, every 25th 4-character group
    // swapped for one holding `+/` (any 4 characters of the alphabet are a valid group).
    const signature = Buffer.from(Array.from({ length: 660 }, (_, i) => (i * 167 + 29) & 255))
      .toString('base64')
      .match(/.{4}/g)
      .map((group, i) => (i % 25 === 3 ? 'Kx+/' : group))
      .join('')
    expect(signature).toMatch(/\+\/[A-Za-z0-9+/]/)
    const raw = jsonl('thinking-turn.jsonl', [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Plan: write /opt/canary/marker.txt', signature }]
        }
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [record] = records(scrubbed)

    expect(record.message.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Plan: write <PATH>',
      signature: '<SIGNATURE>'
    })
    expect(findSurvivors(scrubbed.text, IDENTITY)).toEqual([])
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] an absolute path right after a + outside a signature is still replaced and still a survivor', () => {
    const raw = jsonl('simple-turn.jsonl', [
      { type: 'system', args: 'node +/opt/canary/bin/tool and +C:\\canary\\tool.exe' }
    ])

    const [record] = records(scrubFixtureSet([raw], IDENTITY)[0])

    expect(record.args).toBe('node +<PATH> and +<PATH>')
    expect(findSurvivors('flags +/opt/canary/bin/tool', IDENTITY)).toEqual([
      { rule: 'path', line: 1 }
    ])
  })

  it('[ADR-008] the environment lists of a Claude system/init line become numbered placeholders of the same shape', () => {
    const raw = jsonl('simple-turn.jsonl', [
      {
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write'],
        slash_commands: ['canary-review', 'canary-deploy'],
        terminal_slash_commands: ['canary-color'],
        agents: ['canary-agent'],
        skills: ['canary-skill-a', 'canary-skill-b', 'canary-skill-c'],
        plugins: [{ name: 'canary-plugin', path: 'builtin', source: 'canary-plugin@builtin' }]
      },
      { type: 'system', subtype: 'status', skills: ['canary-skill-a'] }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [init, other] = records(scrubbed)

    expect(init).toEqual({
      type: 'system',
      subtype: 'init',
      tools: ['Read', 'Write'],
      slash_commands: ['<slash-command-1>', '<slash-command-2>'],
      terminal_slash_commands: ['<terminal-slash-command-1>'],
      agents: ['<agent-1>'],
      skills: ['<skill-1>', '<skill-2>', '<skill-3>'],
      plugins: [{ name: '<plugin-1>', path: '<plugin-1>', source: '<plugin-1>' }]
    })
    expect(other.skills).toEqual(['canary-skill-a'])
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] a Codex installationId is replaced by its placeholder, and so is the same id anywhere in the set', () => {
    const installation = '4f1c2b3a-0000-4abc-8def-canary000001'
    const notification = jsonl('s0151b-client1.jsonl', [
      {
        method: 'remoteControl/status/changed',
        params: { status: 'disabled', installationId: installation, environmentId: null }
      }
    ])
    const stderr = {
      name: 's0151b-client1-stderr.jsonl',
      text: `starting remote control websocket task installation_id=${installation}\n`
    }

    const [scrubbed, scrubbedStderr] = scrubFixtureSet([notification, stderr], IDENTITY)
    const [record] = records(scrubbed)

    expect(record.params).toEqual({
      status: 'disabled',
      installationId: '<INSTALLATION_ID>',
      environmentId: null
    })
    expect(scrubbedStderr.text).toBe(
      'starting remote control websocket task installation_id=<INSTALLATION_ID>\n'
    )
    expect(scrubFixtureSet([scrubbed, scrubbedStderr], IDENTITY)).toEqual([
      scrubbed,
      scrubbedStderr
    ])
  })

  it('[ADR-008] an organization id seen under an account key is replaced wherever the set repeats it', () => {
    const org = 'a1b2c3d4-0000-4000-8000-canaryorg001'
    const raw = jsonl('s0221-stream-transcript.jsonl', [
      { type: 'attachment', attachment: { type: 'model', organizationUuid: org } },
      { type: 'system', note: `skills synced for ${org} today` }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)

    expect(scrubbed.text).not.toContain(org)
    expect(records(scrubbed)[1].note).toBe('skills synced for <ACCOUNT_ID> today')
  })

  it('[ADR-008] a Claude synced-skill folder, named by the organization id, never keeps its ids in another provider log', () => {
    const folder = 'a1b2c3d4-0000-4000-8000-canaryorg001_efb568b5-0000-4000-8000-canaryskill1'
    const stderr = {
      name: 'sp12-sp14-serve-stderr.jsonl',
      text: [
        `WARN duplicate skill name existing="C:\\Users\\canary.user\\.claude\\skills\\synced\\${folder}\\pptx\\SKILL.md"`,
        `WARN duplicate skill name existing="/home/canary.user/.claude/skills/synced/${folder}/pptx/SKILL.md"`
      ].join('\n')
    }

    const [scrubbed] = scrubFixtureSet([stderr], IDENTITY)

    expect(scrubbed.text).not.toContain('canaryorg001')
    expect(scrubbed.text).not.toContain('canaryskill1')
    expect(scrubbed.text.split('\n')).toEqual([
      'WARN duplicate skill name existing="<HOME>\\.claude\\skills\\synced\\<CLAUDE_SYNCED_SKILL_DIR>\\pptx\\SKILL.md"',
      'WARN duplicate skill name existing="<HOME>/.claude/skills/synced/<CLAUDE_SYNCED_SKILL_DIR>/pptx/SKILL.md"'
    ])
    expect(
      findSurvivors(stderr.text, { ...IDENTITY, home: '', user: '' }).map(({ rule }) => rule)
    ).toContain('claude-synced-skill')
    expect(findSurvivors(scrubbed.text, IDENTITY)).toEqual([])
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[C-19] a Claude prompt, API request, tool-use and hook id maps to a fake UUID like the other provider ids', () => {
    const ids = {
      promptId: 'e9055bb6-0000-4000-8000-canaryprompt',
      requestRef: 'e932888b-0000-4000-8000-canaryreqref',
      toolUseID: '42edc44f-0000-4000-8000-canarytoolid',
      hook_id: '7a6b5c4d-0000-4000-8000-canaryhookid'
    }
    const raw = jsonl('s0221-stream-transcript.jsonl', [ids, { promptId: ids.promptId }])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [first, second] = records(scrubbed)

    expect(scrubbed.text).not.toContain('canary')
    for (const value of Object.values(first)) {
      expect(value).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/)
    }
    expect(second.promptId).toBe(first.promptId)
  })

  it('[ADR-008] an OpenCode config keeps its plugin and permission fields, and its agents, commands and MCP servers become numbered placeholders', () => {
    const raw = jsonl('s0111-host-launched.jsonl', [
      {
        status: 200,
        path: '/config',
        body: {
          $schema: 'https://opencode.ai/config.json',
          plugin: ['file:///C:/Users/canary.user/.config/opencode/plugin/probe.js'],
          permission: { edit: 'deny' },
          agent: {
            'canary-orchestrator': { prompt: 'You are canary.', mode: 'primary', hidden: false }
          },
          command: { 'canary-cmd': { template: 'run canary', description: 'canary' } },
          mcp: { 'canary-mcp': { type: 'local', command: ['canary-server'] } }
        }
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [record] = records(scrubbed)

    expect(scrubbed.text).not.toContain('canary')
    expect(record.body.permission).toEqual({ edit: 'deny' })
    expect(record.body.plugin).toEqual(['file:///<HOME>/.config/opencode/plugin/probe.js'])
    expect(record.body.agent).toEqual({
      '<agent-1>': { prompt: '<agent-1>', mode: '<agent-1>', hidden: false }
    })
    expect(record.body.command).toEqual({
      '<command-1>': { template: '<command-1>', description: '<command-1>' }
    })
    expect(record.body.mcp).toEqual({
      '<mcp-server-1>': { type: '<mcp-server-1>', command: ['<mcp-server-1>'] }
    })
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] a Codex MCP server status list becomes numbered placeholders of the same shape', () => {
    const raw = jsonl('sp12-app-server-protocol-entry.jsonl', [
      {
        id: 3,
        result: {
          data: [
            {
              name: 'canary-apps',
              pluginId: null,
              serverInfo: { name: 'canary-apps', version: '1.0' },
              tools: { canary_mail_send: { description: 'Send canary mail', inputSchema: {} } },
              resources: [],
              resourceTemplates: [],
              authStatus: 'oAuth'
            }
          ],
          nextCursor: null
        }
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [record] = records(scrubbed)

    expect(scrubbed.text).not.toContain('canary')
    expect(record.result).toEqual({
      data: [
        {
          name: '<mcp-server-1>',
          pluginId: null,
          serverInfo: { name: '<mcp-server-1>', version: '<mcp-server-1>' },
          tools: { '<mcp-server-1-tool-1>': { description: '<mcp-server-1>', inputSchema: {} } },
          resources: [],
          resourceTemplates: [],
          authStatus: '<mcp-server-1>'
        }
      ],
      nextCursor: null
    })
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] a percent-encoded home or repository path in a URL query is replaced like its plain spelling', () => {
    const raw = jsonl('s0111-host-launched-sent.jsonl', [
      {
        method: 'GET',
        url: 'http://127.0.0.1:4096/config?directory=C%3A%2FUsers%2Fcanary.user%2FAppData%2FLocal%2FTemp%2Fdwarfai-rec-1&x=1',
        other: '/session?directory=C%3a%5cUsers%5ccanary.user%5cwork%5cproject',
        posix: '/session?directory=%2Fhome%2Fsomeone%2Fproject'
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const [record] = records(scrubbed)

    expect(scrubbed.text.toLowerCase()).not.toContain('canary')
    expect(scrubbed.text).not.toContain('someone')
    expect(record.url).toBe('http://127.0.0.1:4096/config?directory=<REPO>&x=1')
    expect(record.other).toBe('<PATH>?directory=<HOME>%5cwork%5cproject')
    expect(record.posix).toBe('<PATH>?directory=<HOME>%2Fproject')
    expect(
      findSurvivors(raw.text, { ...IDENTITY, repoRoot: '' }).map(({ rule }) => rule)
    ).toContain('home')
    expect(findSurvivors(scrubbed.text, IDENTITY)).toEqual([])
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] the session folder of an agent scratchpad that ran the probe never keeps its session id', () => {
    const session = '9c8b7a65-0000-4000-8000-canarysessn1'
    const raw = jsonl('sp12-session-new-mcp-sent.jsonl', [
      {
        command: 'node',
        args: [
          `C:\\Users\\canary.user\\AppData\\Local\\Temp\\claude\\C--Users-canary-user-work\\${session}\\scratchpad\\probe\\probe-mcp.mjs`
        ]
      }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)

    expect(scrubbed.text).not.toContain('canarysessn1')
    expect(records(scrubbed)[0].args).toEqual([
      '<HOME>\\AppData\\Local\\Temp\\claude\\<AGENT_SCRATCHPAD>\\probe\\probe-mcp.mjs'
    ])
    expect(findSurvivors(scrubbed.text, IDENTITY)).toEqual([])
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
  })

  it('[ADR-008] a Claude attachment that renders the person setup keeps only its type, and an API request dump keeps only its record type', () => {
    const raw = jsonl('s0221-stream-transcript.jsonl', [
      {
        type: 'attachment',
        uuid: 'att-canary-0001',
        attachment: { type: 'instructions', content: '# CLAUDE.md of canary\nrules' },
        rendered: [{ content: '<system-reminder>CLAUDE.md of canary</system-reminder>' }],
        renderedRole: 'user'
      },
      {
        type: 'attachment',
        attachment: { type: 'skill_listing', skills: ['canary-skill-a', 'canary-skill-b'] },
        rendered: 'canary-skill-a, canary-skill-b'
      },
      { type: 'attachment', attachment: { type: 'credential_org', org: 'canary-org-name' } },
      {
        type: 'attachment',
        attachment: { type: 'date', date: '2026-10-17' },
        rendered: [{ content: 'Today is 2026-10-17.' }]
      },
      { type: 'api-request', request: { system: 'canary system prompt', messages: ['hi'] } },
      { type: 'api-request-shape', shape: { tools: ['canary-tool'] } }
    ])

    const [scrubbed] = scrubFixtureSet([raw], IDENTITY)
    const lines = records(scrubbed)

    expect(lines[0]).toEqual({
      type: 'attachment',
      uuid: lines[0].uuid,
      attachment: { type: 'instructions', redacted: '<PERSONAL_SETUP>' },
      rendered: '<PERSONAL_SETUP>',
      renderedRole: 'user'
    })
    expect(lines[1]).toEqual({
      type: 'attachment',
      attachment: { type: 'skill_listing', redacted: '<PERSONAL_SETUP>' },
      rendered: '<PERSONAL_SETUP>'
    })
    expect(lines[2]).toEqual({
      type: 'attachment',
      attachment: { type: 'credential_org', redacted: '<PERSONAL_SETUP>' }
    })
    expect(lines[3].attachment).toEqual({ type: 'date', date: '2026-10-17' })
    expect(lines[4]).toEqual({ type: 'api-request', redacted: '<API_REQUEST>' })
    expect(lines[5]).toEqual({ type: 'api-request-shape', redacted: '<API_REQUEST>' })
    expect(scrubbed.text).not.toContain('canary-skill')
    expect(scrubbed.text).not.toContain('canary system prompt')
    expect(scrubbed.text).not.toContain('canary-org-name')
    expect(scrubFixtureSet([scrubbed], IDENTITY)).toEqual([scrubbed])
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
