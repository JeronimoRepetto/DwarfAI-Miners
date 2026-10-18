// L8 for the person-run OpenCode server attach (ISSUE-237; 17 §1.8; ADR-017 item 3): the
// production `fetchTransport` against a real local HTTP server on this machine's loopback that is
// protected like a person's `opencode serve` with OPENCODE_SERVER_PASSWORD (S-031-3: 401 without
// the right credential, 200 with it). The server answers the hand-written
// `fixtures/opencode/http-server/1.18.32-synthetic/person-run-password` case. No CLI runs.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSecretReader } from '../../../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { fetchTransport, OpenCodeServerClient } from './personRunServer'

const ROOT = new URL('../../../../../../../', import.meta.url)
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('fixtures/opencode/http-server/1.18.32-synthetic/person-run-password.json', ROOT)
    ),
    'utf8'
  )
) as {
  username: string
  unauthorized: { status: number; body: unknown }
  sessions: { status: number; body: unknown }
}

const PASSWORD = 'pa:ss wörd-0237-os'

const timers: Scheduler = {
  after(ms, task) {
    const handle = setTimeout(task, ms)
    return { cancel: () => clearTimeout(handle) }
  }
}

let server: Server | undefined

afterEach(async () => {
  const open = server
  server = undefined
  if (open !== undefined) await new Promise<void>((resolve) => open.close(() => resolve()))
})

/** A password-protected server on 127.0.0.1, port chosen by the OS; it keeps every request. */
async function protectedServer(): Promise<{ url: string; received: IncomingMessage[] }> {
  const received: IncomingMessage[] = []
  const expected = `Basic ${Buffer.from(`${FIXTURE.username}:${PASSWORD}`, 'utf8').toString('base64')}`
  server = createServer((request, response) => {
    received.push(request)
    const reply =
      request.headers.authorization === expected &&
      request.method === 'GET' &&
      request.url === '/session'
        ? FIXTURE.sessions
        : FIXTURE.unauthorized
    response.writeHead(reply.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply.body))
  })
  const listening = server
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', () => resolve()))
  const { port } = listening.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, received }
}

function client(url: string, stored: string | null) {
  const log = new RecordingDiagnosticsLog()
  const secretReader = new FakeSecretReader({
    scheduler: timers,
    values: stored === null ? {} : { 'opencode-password': stored }
  })
  return {
    log,
    client: new OpenCodeServerClient(
      { owner: 'person', url },
      { secretReader, http: fetchTransport, scheduler: timers, log }
    )
  }
}

describe('OpenCodeServerClient over a real loopback server (L8)', () => {
  it('[ADR-017] against a local password-protected server the driver lists sessions with the stored password', async () => {
    const { url, received } = await protectedServer()

    const outcome = await client(url, PASSWORD).client.listSessions()

    expect(outcome).toStrictEqual({
      kind: 'ok',
      sessions: [
        { providerSessionId: 'ses_0237a', directory: '/home/j/mine one' },
        { providerSessionId: 'ses_0237b', directory: '/home/j/mine two' }
      ]
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.url).toBe('/session')
    const { authorization, ...others } = received[0]?.headers ?? {}
    expect(authorization).toMatch(/^Basic /)
    for (const form of [PASSWORD, encodeURIComponent(PASSWORD)]) {
      expect(JSON.stringify({ url: received[0]?.url, others })).not.toContain(form)
    }
  })

  it('[ADR-017] against a local password-protected server a wrong stored password is unreachable unauthorized, sent once', async () => {
    const { url, received } = await protectedServer()
    const wrong = client(url, 'not-the-servers-password')

    expect(await wrong.client.listSessions()).toStrictEqual({
      kind: 'unreachable',
      cause: 'unauthorized'
    })
    expect(received).toHaveLength(1)
    expect(wrong.log.byEvent('opencode-server.unreachable')[0]?.causeClass).toBe(
      'password-rejected'
    )
  })
})
