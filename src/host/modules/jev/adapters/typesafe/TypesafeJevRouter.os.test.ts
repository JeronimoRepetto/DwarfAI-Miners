import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { JEV_ATTEMPT_TIMEOUT_MS } from '../../ports/jevRouter'
import {
  CONTRACT_JEV_KEY,
  CONTRACT_MODEL_REQUEST,
  CONTRACT_ROUTE_REQUEST
} from '../../testing/jevRouter.contract'
import { answerFor } from './testing/scriptedTypesafeFetch'
import { TypesafeJevRouter } from './TypesafeJevRouter'

// L8 (17 §1.8): the real adapter, the real SDK and the platform's own fetch over a real socket to a
// fake TypeSafe server on the loopback interface (the SDK accepts a base URL). Nothing leaves the
// machine; the server answers each question it is asked, or plays a failure. Runs on every OS.

type Play = 'answers' | 401 | 429 | 'hang' | 'garbage'

interface FakeTypesafe {
  baseURL: string
  /** Every request the server received: its path, bearer and parsed body. */
  received: Array<{ path: string | undefined; authorization: string | undefined; body: unknown }>
  close(): Promise<void>
}

const servers: FakeTypesafe[] = []

async function fakeTypesafe(play: Play): Promise<FakeTypesafe> {
  const received: FakeTypesafe['received'] = []
  const hanging: ServerResponse[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        questions: Parameters<typeof answerFor>[0]
      }
      received.push({ path: req.url, authorization: req.headers.authorization, body })
      if (play === 'hang') {
        hanging.push(res)
        return
      }
      if (play === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('not json')
        return
      }
      const status = play === 'answers' ? 200 : play
      const payload = play === 'answers' ? answerFor(body.questions) : { error: 'scripted' }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const fake: FakeTypesafe = {
    baseURL: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  servers.push(fake)
  return fake
}

function routerTo(baseURL: string) {
  const clock = new FakeClock()
  const log = new RecordingDiagnosticsLog()
  const router = new TypesafeJevRouter({ scheduler: new FakeScheduler(clock), log, baseURL })
  return { router, clock, log }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('TypesafeJevRouter (OS, loopback TypeSafe)', () => {
  it('[INV-88, FM-119] both requests reach TypeSafe once over a real socket, with the key only as the bearer', async () => {
    const server = await fakeTypesafe('answers')
    const { router } = routerTo(server.baseURL)

    expect((await router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)).kind).toBe('answers')
    expect((await router.routeModel(CONTRACT_MODEL_REQUEST, CONTRACT_JEV_KEY)).kind).toBe('answers')
    expect(server.received.map((r) => r.path)).toStrictEqual(['/v1/systemone', '/v1/systemone'])
    for (const request of server.received) {
      expect(request.authorization).toBe(`Bearer ${CONTRACT_JEV_KEY}`)
      expect(JSON.stringify(request.body)).not.toContain(CONTRACT_JEV_KEY)
    }
  })

  it('[US-RES-006.AC02, FM-120] a rejected key and a rate limit are fallbacks, each sent once', async () => {
    const rejected = await fakeTypesafe(401)
    expect(
      await routerTo(rejected.baseURL).router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    ).toStrictEqual({ kind: 'fallback', reason: 'unauthorized' })
    expect(rejected.received).toHaveLength(1)

    const limited = await fakeTypesafe(429)
    expect(
      await routerTo(limited.baseURL).router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    ).toStrictEqual({ kind: 'fallback', reason: 'rate-limited' })
    expect(limited.received).toHaveLength(1)

    const garbage = await fakeTypesafe('garbage')
    expect(
      await routerTo(garbage.baseURL).router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    ).toStrictEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('[FM-119] an unreachable TypeSafe and a server that never answers are fallbacks', async () => {
    // A port that was just closed: the connection is refused.
    const closed = await fakeTypesafe('answers')
    const address = closed.baseURL
    await closed.close()
    expect(
      await routerTo(address).router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    ).toStrictEqual({ kind: 'fallback', reason: 'unreachable' })

    const silent = await fakeTypesafe('hang')
    const { router, clock } = routerTo(silent.baseURL)
    const pending = router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    // Wait until the request is on the server, then let the attempt's time run out.
    for (let i = 0; i < 200 && silent.received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(silent.received).toHaveLength(1)
    clock.advance(JEV_ATTEMPT_TIMEOUT_MS)
    expect(await pending).toStrictEqual({ kind: 'fallback', reason: 'timeout' })
  })
})
