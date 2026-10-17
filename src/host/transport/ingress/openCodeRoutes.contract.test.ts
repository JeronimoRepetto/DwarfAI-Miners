// layer: L6
// The OpenCode plugin route of the loopback ingress (ADR-016 items 1–4; 13 FM-038; 19 §9.2
// `ingress.rejected`), over the real `node:http` listener on 127.0.0.1 and an OS-chosen port,
// beside the Claude hooks route so a token of one channel can be tried on the other. The tokens are
// drawn at run time, so no token value is written into the repository.
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { inMemoryChannelTokens } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { ChannelTokenCheck } from '../auth/channelTokenCheck'
import { createClaudeHooksRoute } from './claudeHooksRoute'
import { createHttpIngress, MAX_INGRESS_BODY_BYTES, type HttpIngress } from './httpIngress'
import {
  createOpenCodePluginRoute,
  OPENCODE_PLUGIN_PATH,
  type OpenCodePluginEvidence
} from './openCodeRoutes'
import {
  InMemoryIngressPortRecord,
  post,
  RecordingObservationControl,
  T0
} from './testing/ingressHarness'

const SERVER_URL = 'http://127.0.0.1:4096/'

/** A plugin report as the written plugin sends it (ISSUE-227 `pluginArtifact.ts`). */
function reportBody(
  event: Record<string, unknown> = askedEvent(),
  serverUrl: string | null = SERVER_URL
): string {
  return JSON.stringify({ event, serverUrl })
}

/** `permission.asked` as OpenCode 1.18.32 emits it (S-011-1 `s0111-person-run-deny-events`). */
function askedEvent(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    type: 'permission.asked',
    properties: {
      id: 'per-1',
      sessionID: 'ses-1',
      permission: 'edit',
      patterns: ['deny-probe.txt'],
      metadata: { filepath: '/home/j/mine/deny-probe.txt', diff: '+probe' },
      always: ['*'],
      tool: { messageID: 'msg-1', callID: 'call-1' },
      ...properties
    }
  }
}

interface World {
  port: number
  pluginToken: string
  claudeToken: string
  log: RecordingDiagnosticsLog
  observation: RecordingObservationControl
  evidence: OpenCodePluginEvidence[]
  ingress: HttpIngress
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setUp(): Promise<World> {
  const tokens = inMemoryChannelTokens()
  const log = new RecordingDiagnosticsLog()
  const observation = new RecordingObservationControl()
  const evidence: OpenCodePluginEvidence[] = []
  const check = new ChannelTokenCheck({ tokens: tokens.store, log })
  const ingress = createHttpIngress({
    routes: [
      createClaudeHooksRoute({
        tokens: check,
        preferences: { integrationState: () => 'on-verified' },
        observation,
        evidence: { accept: () => undefined },
        log
      }),
      createOpenCodePluginRoute({
        tokens: check,
        observation,
        evidence: { accept: (item) => void evidence.push(item) },
        log
      })
    ],
    clock: new FakeClock(T0),
    log,
    portRecord: new InMemoryIngressPortRecord(),
    onPortChanged: () => undefined
  })
  const port = await ingress.start()
  cleanups.push(() => ingress.close())
  return {
    port,
    pluginToken: tokens.issue('opencode-plugin', T0),
    claudeToken: tokens.issue('claude-hooks', T0),
    log,
    observation,
    evidence,
    ingress
  }
}

function send(
  w: World,
  options: { token?: string; body?: string; headers?: Record<string, string> }
) {
  return post(w.port, {
    path: OPENCODE_PLUGIN_PATH,
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { 'x-dwarfai-token': options.token }),
      ...options.headers
    },
    body: options.body ?? reportBody()
  })
}

function rejected(causeClass: string) {
  return { level: 'warn', event: 'ingress.rejected', subsystem: 'opencode-plugin', causeClass }
}

describe('the OpenCode plugin route of the loopback ingress (ADR-016)', () => {
  it('[ADR-016, FM-038] a Claude hook token on /opencode/* gets 401; a request with an Origin header or a wrong Host gets 403; a body above 256 KiB is refused', async () => {
    const w = await setUp()

    const claudeToken = await send(w, { token: w.claudeToken })
    expect(claudeToken.status).toBe(401)
    const missing = await send(w, {})
    expect(missing.status).toBe(401)

    const origin = await send(w, {
      token: w.pluginToken,
      headers: { origin: 'http://127.0.0.1:5173' }
    })
    expect(origin.status).toBe(403)
    const host = await send(w, {
      token: w.pluginToken,
      headers: { host: `localhost:${w.port}` }
    })
    expect(host.status).toBe(403)

    const padding = 'x'.repeat(MAX_INGRESS_BODY_BYTES)
    const oversized = await send(w, {
      token: w.pluginToken,
      body: reportBody(askedEvent({ padding }))
    })
    expect(oversized.status).toBe(413)

    expect(w.evidence).toStrictEqual([])
    expect(w.observation.calls).toStrictEqual([])
    expect(w.log.byEvent('ingress.rejected')).toStrictEqual([
      rejected('401'),
      rejected('401'),
      rejected('403-origin'),
      rejected('403-host'),
      rejected('413')
    ])
    // The plugin token is not a Claude hooks token either.
    const crossed = await post(w.port, {
      path: '/hooks/claude/event',
      headers: { 'x-dwarfai-token': w.pluginToken },
      body: '{}'
    })
    expect(crossed.status).toBe(401)
  })

  it('[ADR-016] a permission report with the active plugin token is accepted as evidence and nudges the observer', async () => {
    const w = await setUp()

    const answer = await send(w, { token: w.pluginToken })

    expect(answer.status).toBe(204)
    expect(answer.body).toBe('')
    expect(w.evidence).toStrictEqual([
      {
        kind: 'permission.asked',
        sessionId: 'ses-1',
        requestId: 'per-1',
        permission: 'edit',
        patterns: ['deny-probe.txt'],
        serverOrigin: 'http://127.0.0.1:4096'
      }
    ])
    expect(w.observation.nudges()).toStrictEqual([{ providerId: 'opencode', sessionId: 'ses-1' }])
    expect(w.log.byEvent('ingress.rejected')).toStrictEqual([])
  })

  it('[ADR-016] a plugin report never answers an ask, launches or changes a setting', async () => {
    const w = await setUp()

    // A reply report, even one naming a decision, is evidence of a reply, never a reply.
    const replied = await send(w, {
      token: w.pluginToken,
      body: reportBody({
        type: 'permission.replied',
        properties: { sessionID: 'ses-1', requestID: 'per-1', reply: 'once' }
      })
    })
    expect(replied.status).toBe(204)
    const asked = await send(w, { token: w.pluginToken })
    expect(asked.status).toBe(204)

    // The route reaches only the evidence sink and the observer's nudge: no member that answers,
    // launches, ends a session or changes a setting is ever called.
    expect(w.evidence).toStrictEqual([
      { kind: 'permission.replied', sessionId: 'ses-1', requestId: 'per-1' },
      expect.objectContaining({ kind: 'permission.asked', requestId: 'per-1' })
    ])
    expect(w.observation.calls.map((call) => call.member)).toStrictEqual(['nudge', 'nudge'])
  })

  it('[ADR-016, ADR-017] a report naming a server off this machine, or a malformed report, is refused with 400', async () => {
    const w = await setUp()

    const bodies = [
      reportBody(askedEvent(), 'http://192.0.2.10:4096/'),
      reportBody(askedEvent(), 'https://127.0.0.1:4096/'),
      reportBody(askedEvent(), 'http://user:pw@127.0.0.1:4096/'),
      reportBody(askedEvent(), null),
      reportBody(askedEvent({ id: 42 })),
      reportBody(askedEvent({ sessionID: '' })),
      reportBody({ type: 'session.idle', properties: { sessionID: 'ses-1' } }),
      JSON.stringify({ event: askedEvent(), serverUrl: SERVER_URL, command: 'allow' }),
      'not json'
    ]
    for (const body of bodies) {
      expect((await send(w, { token: w.pluginToken, body })).status).toBe(400)
    }

    expect(w.evidence).toStrictEqual([])
    expect(w.log.byEvent('ingress.rejected')).toStrictEqual(bodies.map(() => rejected('400')))
  })
})
