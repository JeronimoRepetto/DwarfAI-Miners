// layer: L2
// L2 (17 §1.2): the OpenCode plugin answer channel (16 §4.7 row `AskAnswerChannel` `http`; 15 §2.7
// row "OpenCode HTTP"; ADR-017 item 3; 13 FM-074, FM-116) over a fake OpenCode server that records
// every request it receives, the `FakeSecretReader` and a recording log. The password is drawn at
// run time, so no secret value is written into the repository.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { DwarfId } from '../../../../kernel/domain/values'
import { SECRET_READ_TIMEOUT_MS } from '../../../../kernel/ports/secretReader'
import {
  OPENCODE_PLUGIN_CHANNEL_CAPABILITIES,
  OpenCodePluginAskChannel,
  type OpenCodeAnswerTarget,
  type OpenCodeHttpPost
} from './OpenCodePluginAskChannel'

const DWARF = '00000000-0000-7000-8000-0000000229d1' as DwarfId
const REF = { dwarfId: DWARF }
const REQUEST = 'per-0229'
const TARGET: OpenCodeAnswerTarget = {
  serverOrigin: 'http://127.0.0.1:4096',
  directory: '/home/j/mine one'
}

interface Received {
  url: string
  headers: Record<string, string>
  body: string
  redirect: string
}

/** A fake OpenCode server: records each request and answers the scripted status and body. */
function fakeServer(
  reply: { status: number; body: string } | Error = { status: 200, body: 'true' }
) {
  const received: Received[] = []
  const post: OpenCodeHttpPost = (url, init) => {
    received.push({ url, headers: { ...init.headers }, body: init.body, redirect: init.redirect })
    if (reply instanceof Error) return Promise.reject(reply)
    return Promise.resolve({ status: reply.status, text: () => Promise.resolve(reply.body) })
  }
  return { received, post }
}

function world(
  options: {
    password?: string | null
    target?: OpenCodeAnswerTarget | null
    reply?: { status: number; body: string } | Error
  } = {}
) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const password =
    options.password === undefined ? randomBytes(12).toString('hex') : options.password
  const secrets = new FakeSecretReader({
    scheduler,
    values: password === null ? {} : { 'opencode-password': password }
  })
  const server = fakeServer(options.reply)
  const log = new RecordingDiagnosticsLog()
  const target = options.target === undefined ? TARGET : options.target
  const channel = new OpenCodePluginAskChannel({
    targets: {
      targetOf: (dwarfId, providerRequestId) =>
        dwarfId === DWARF && providerRequestId === REQUEST ? target : null
    },
    secrets,
    post: server.post,
    log
  })
  return { clock, secrets, server, log, channel, password }
}

describe('OpenCodePluginAskChannel (16 §4.7 `http`; ADR-017 item 3)', () => {
  it('[ADR-017, C-22] the answer carries the password only in the Authorization header', async () => {
    const w = world()

    expect(await w.channel.answerPermission(REF, REQUEST, 'allow')).toStrictEqual({
      kind: 'accepted'
    })

    expect(w.server.received).toHaveLength(1)
    const [sent] = w.server.received
    expect(sent?.url).toBe(
      'http://127.0.0.1:4096/permission/per-0229/reply?directory=%2Fhome%2Fj%2Fmine%20one'
    )
    expect(sent?.headers).toStrictEqual({
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`opencode:${w.password}`).toString('base64')}`
    })
    expect(JSON.parse(sent?.body ?? '')).toStrictEqual({ reply: 'once' })
    expect(sent?.redirect).toBe('error')
    // Nowhere else: not in the URL, the body or any other header, and never in a log record.
    const elsewhere = [
      sent?.url,
      sent?.body,
      ...Object.entries(sent?.headers ?? {})
        .filter(([name]) => name !== 'authorization')
        .map(([, value]) => value),
      JSON.stringify([w.log.entries, w.log.refused])
    ].join('\n')
    expect(elsewhere).not.toContain(w.password)
    expect(w.secrets.reads).toStrictEqual(['opencode-password'])
  })

  it('[ADR-010] Allow is sent as once and Deny as reject, never always', async () => {
    const w = world()

    await w.channel.answerPermission(REF, REQUEST, 'allow')
    await w.channel.answerPermission(REF, REQUEST, 'deny')

    expect(w.server.received.map((sent) => JSON.parse(sent.body))).toStrictEqual([
      { reply: 'once' },
      { reply: 'reject' }
    ])
  })

  it('[ADR-017] with no password configured the answer carries no Authorization header', async () => {
    const w = world({ password: null })

    expect(await w.channel.answerPermission(REF, REQUEST, 'deny')).toStrictEqual({
      kind: 'accepted'
    })
    expect(w.server.received[0]?.headers).toStrictEqual({ 'content-type': 'application/json' })
  })

  it('[FM-116] a password read that times out refuses the answer as channel-unavailable', async () => {
    const w = world()
    w.secrets.blocking = true

    const answer = w.channel.answerPermission(REF, REQUEST, 'allow')
    w.clock.advance(SECRET_READ_TIMEOUT_MS)

    expect(await answer).toStrictEqual({ kind: 'refused', reason: 'channel-unavailable' })
    expect(w.server.received).toStrictEqual([])
  })

  it('[ADR-017] an answer is never sent to a server off this machine', async () => {
    for (const serverOrigin of ['http://192.0.2.10:4096', 'https://127.0.0.1:4096', 'nonsense']) {
      const w = world({ target: { serverOrigin, directory: '/home/j/mine' } })

      expect(await w.channel.answerPermission(REF, REQUEST, 'allow')).toStrictEqual({
        kind: 'refused',
        reason: 'channel-unavailable'
      })
      expect(w.server.received).toStrictEqual([])
      expect(w.secrets.reads).toStrictEqual([])
    }
  })

  it("[FM-074] the server's reply decides the outcome: true accepted, false or 404 not open, a refused password channel-rejected, anything else channel-unavailable", async () => {
    const cases: Array<[{ status: number; body: string } | Error, unknown]> = [
      [{ status: 200, body: 'true' }, { kind: 'accepted' }],
      [{ status: 200, body: 'false' }, { kind: 'not-open' }],
      [{ status: 404, body: '' }, { kind: 'not-open' }],
      [
        { status: 401, body: '' },
        { kind: 'refused', reason: 'channel-rejected' }
      ],
      [
        { status: 403, body: '' },
        { kind: 'refused', reason: 'channel-rejected' }
      ],
      [
        { status: 400, body: '' },
        { kind: 'refused', reason: 'channel-rejected' }
      ],
      [
        { status: 500, body: '' },
        { kind: 'refused', reason: 'channel-unavailable' }
      ],
      [new Error('connect ECONNREFUSED'), { kind: 'refused', reason: 'channel-unavailable' }]
    ]
    for (const [reply, outcome] of cases) {
      const w = world({ reply })
      expect(await w.channel.answerPermission(REF, REQUEST, 'deny')).toStrictEqual(outcome)
      // A failure is one allowlisted record that never carries the password.
      expect(w.log.refused).toStrictEqual([])
      expect(JSON.stringify(w.log.entries)).not.toContain(w.password)
    }
  })

  it('[ADR-010] a request the Host holds no address for is not open, and nothing is sent', async () => {
    const w = world({ target: null })

    expect(await w.channel.answerPermission(REF, REQUEST, 'allow')).toStrictEqual({
      kind: 'not-open'
    })
    expect(w.server.received).toStrictEqual([])
    expect(w.secrets.reads).toStrictEqual([])
  })

  it('[ADR-011] a question is never answered on this channel: not open, nothing sent', async () => {
    const w = world()

    expect(
      await w.channel.answerQuestion(REF, REQUEST, [{ step: 0, option: 'Yes' }])
    ).toStrictEqual({ kind: 'not-open' })
    expect(await w.channel.declineQuestion(REF, REQUEST)).toStrictEqual({ kind: 'not-open' })
    expect(w.server.received).toStrictEqual([])
    expect(OPENCODE_PLUGIN_CHANNEL_CAPABILITIES).toStrictEqual({
      staleAnswerSafe: true,
      answeredElsewhere: false
    })
  })
})
