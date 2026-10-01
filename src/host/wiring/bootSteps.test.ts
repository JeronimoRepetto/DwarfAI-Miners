import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endpointFor, PROTOCOL_VERSION, type EndpointInput } from '@dwarfai/contracts'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../platform/clock/NodeScheduler'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { ConnectionRegistry } from '../transport/connectionRegistry'
import { Dispatcher } from '../transport/dispatcher'
import { createFakeOwnerOnlyPipe } from '../transport/endpoint/fakes/FakeOwnerOnlyPipe'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import { HostStateHolder, LIFECYCLE_FRAMES } from '../transport/lifecycle/hostState'
import { FrameClient } from '../transport/testing/frameClient'
import { createUiEndpoint } from './bootSteps'
import { createHostDispatcher } from './hostDispatcher'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'

// L6 (17 §1.6): the bind step's composition — the platform facts, the one ADR-002 D2 rule and the
// real endpoint server — on this OS's real transport. Synthetic SID only (privacy-guard). On Windows
// the pipe comes from the owner-only pipe helper's double (the native helper is the OS lane's).

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A fresh folder for one case. On POSIX it sits directly under `/tmp`: a socket path must fit
 * `sun_path` (104 bytes on macOS), and the macOS runner's `os.tmpdir()`
 * (`/var/folders/<2>/<30>/T`) leaves too little room for it.
 */
function caseRoot(): string {
  const root =
    process.platform === 'win32'
      ? mkdtempSync(join(tmpdir(), 'dwarfai-022-wiring-'))
      : mkdtempSync('/tmp/dw022-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * Facts for this OS under `root`, as the platform adapter reads them: each OS runs its own rule,
 * with its own `sun_path` limit. The macOS home is `root`, so the socket never lands in the real
 * home.
 */
function factsForThisOs(root: string): EndpointInput {
  if (process.platform === 'win32') {
    return { platform: 'win32', hostDataDir: join(root, 'host'), userSid: 'S-1-5-5-0-4242', sha256 }
  }
  if (process.platform === 'darwin') {
    return {
      platform: 'darwin',
      hostDataDir: join(root, 'DwarfAI-Miners', 'host'),
      home: root,
      caseInsensitiveVolume: false,
      sha256
    }
  }
  return { platform: 'linux', hostDataDir: join(root, 'host'), sha256 }
}

function scheduler(): NodeScheduler {
  return new NodeScheduler({ onTaskError: () => {} })
}

/** The token a bound Host wrote to <hostDataDir>/run/ui.token, or '' when there is none. */
function readToken(hostDataDir: string): string {
  try {
    return readFileSync(join(hostDataDir, 'run', 'ui.token'), 'utf8')
  } catch {
    return ''
  }
}

/** The auth layer's inputs for one Host boot (ISSUE-023). */
function channelDeps(log = new RecordingDiagnosticsLog()) {
  const clock = new FakeClock(1_000)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  return {
    clock,
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    pid: 4242,
    epoch: 'epoch-0001',
    state: () => state.current(),
    dispatcher: new Dispatcher({
      log,
      clock,
      scheduler: new FakeScheduler(clock),
      state: () => state.current().state
    }),
    connections,
    frames: LIFECYCLE_FRAMES,
    // ADDED for the ISSUE-022 Windows half: a Windows endpoint is created only through the
    // owner-only pipe helper; its double here (the native helper is the OS lane's).
    ownerOnlyPipe: createFakeOwnerOnlyPipe().listen,
    // AMENDED for ISSUE-031: run/host.identity, written after the bind (ADR-002 D3).
    identityFile: {
      publish: () => Promise.resolve('written' as const),
      remove: () => Promise.resolve()
    }
  }
}

describe('the bind step composition (ADR-002 D2, D3)', () => {
  it('[ADR-002] the bind step binds the endpoint the one pure rule names for the hostDataDir, and a client reaches it there', async () => {
    const input = factsForThisOs(caseRoot())
    const facts: EndpointFacts = () => Promise.resolve({ ok: true, value: input })
    const endpoint = createUiEndpoint({
      facts,
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps()
    })
    cleanups.push(() => endpoint.close())

    expect(await endpoint.bind()).toBe('bound')

    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)
    await new Promise<void>((resolve, reject) => {
      const socket = connect(named.value.path)
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    })
  })

  it('[ADR-002, FM-037] facts that cannot be read or an endpoint the rule refuses fail the bind with a typed code', async () => {
    const cases: Array<[Awaited<ReturnType<EndpointFacts>>, string]> = [
      [{ ok: false, cause: 'timed out after 5000 ms' }, 'ENDPOINT_FACTS_UNREADABLE'],
      [
        {
          ok: true,
          value: { platform: 'linux', hostDataDir: `/${'d'.repeat(120)}/host`, sha256 }
        },
        'ENDPOINT_SOCKET_PATH_TOO_LONG'
      ],
      [
        { ok: true, value: { platform: 'win32', hostDataDir: 'C:\\h\\host', sha256 } },
        'ENDPOINT_USER_SID_MISSING'
      ]
    ]
    for (const [answer, code] of cases) {
      const endpoint = createUiEndpoint({
        facts: () => Promise.resolve(answer),
        log: new RecordingDiagnosticsLog(),
        scheduler: scheduler(),
        ...channelDeps()
      })

      await expect(endpoint.bind(), code).rejects.toMatchObject({ code })
    }
  })

  it('[ADR-002, S12.02, FM-009] a second Host whose endpoint is held by a running Host that answers hello reports already-running', async () => {
    const input = factsForThisOs(caseRoot())
    const facts: EndpointFacts = () => Promise.resolve({ ok: true, value: input })
    const running = createUiEndpoint({
      facts,
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps()
    })
    cleanups.push(() => running.close())
    expect(await running.bind()).toBe('bound')
    const runningToken = readToken(input.hostDataDir)

    const second = createUiEndpoint({
      facts,
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps()
    })
    cleanups.push(() => second.close())

    await expect(second.bind()).resolves.toBe('already-running')
    // The second Host left the running Host's token in place.
    expect(runningToken).toMatch(/^[0-9a-f]{64}$/)
    expect(readToken(input.hostDataDir)).toBe(runningToken)
  })

  it('[ADR-003, FM-026] the bound endpoint answers a hello that carries the token from run/ui.token with hello.ok', async () => {
    const input = factsForThisOs(caseRoot())
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps()
    })
    cleanups.push(() => endpoint.close())
    expect(await endpoint.bind()).toBe('bound')
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)
    const token = readToken(input.hostDataDir)

    const socket = connect(named.value.path)
    cleanups.push(() => void socket.destroy())
    const client = new FrameClient(socket)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'ui',
      token,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 1 }
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(client.frames).toEqual([
      expect.objectContaining({ type: 'hello.ok', epoch: 'epoch-0001', endpointGeneration: 1 })
    ])
  })

  it('[ADR-027, ADR-002] hello.ok of the bound endpoint advertises the lifecycle frames frame:host.state and frame:host.closing', async () => {
    const input = factsForThisOs(caseRoot())
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps()
    })
    cleanups.push(() => endpoint.close())
    expect(await endpoint.bind()).toBe('bound')
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)

    const socket = connect(named.value.path)
    cleanups.push(() => void socket.destroy())
    const client = new FrameClient(socket)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'notifier',
      token: readToken(input.hostDataDir),
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 1 }
    })
    await client.until(() => client.frames.length > 0)

    const helloOk = client.frames[0] as { capabilities?: string[] }
    expect(helloOk.capabilities).toEqual(
      expect.arrayContaining(['frame:host.closing', 'frame:host.state'])
    )
  })

  it.runIf(process.platform === 'win32')(
    '[ADR-003, FM-036] the bind step creates a Windows pipe only through the owner-only pipe helper it is given',
    async () => {
      const input = factsForThisOs(caseRoot())
      const asked: string[] = []
      const helper: ListenOwnerOnlyPipe = (name) => {
        asked.push(name)
        return Promise.resolve({ ok: true, server: { close: () => Promise.resolve() } })
      }
      const endpoint = createUiEndpoint({
        facts: () => Promise.resolve({ ok: true, value: input }),
        log: new RecordingDiagnosticsLog(),
        scheduler: scheduler(),
        ...channelDeps(),
        ownerOnlyPipe: helper
      })
      cleanups.push(() => endpoint.close())

      expect(await endpoint.bind()).toBe('bound')

      const named = endpointFor(input)
      if (!named.ok) throw new Error(named.error.kind)
      expect(asked).toEqual([named.value.path])
    }
  )

  it('[ADR-005, FM-100] hello.ok of the bound endpoint advertises the conditions the Host runs in, read at each hello', async () => {
    const input = factsForThisOs(caseRoot())
    let conditions: string[] = []
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps(),
      conditions: () => conditions
    })
    cleanups.push(() => endpoint.close())
    expect(await endpoint.bind()).toBe('bound')
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)
    const helloCapabilities = async (): Promise<string[] | undefined> => {
      const socket = connect(named.value.path)
      cleanups.push(() => void socket.destroy())
      const client = new FrameClient(socket)
      client.send({
        type: 'hello',
        endpointGeneration: 1,
        protocolVersion: PROTOCOL_VERSION,
        role: 'ui',
        token: readToken(input.hostDataDir),
        client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 1 }
      })
      await client.until(() => client.frames.length > 0)
      return (client.frames[0] as { capabilities?: string[] }).capabilities
    }

    expect(await helloCapabilities()).not.toContain('db-read-only')
    // Boot step 2 opened a newer file after the bind: the next hello carries it.
    conditions = ['db-read-only']
    expect(await helloCapabilities()).toContain('db-read-only')
  })

  it('[ADR-003] the Host dispatcher main composes serves ping: a ui hello then ping answers the Host time over the bound endpoint', async () => {
    const input = factsForThisOs(caseRoot())
    const log = new RecordingDiagnosticsLog()
    const deps = channelDeps(log)
    const dispatcher = createHostDispatcher({
      log,
      clock: deps.clock,
      scheduler: new FakeScheduler(deps.clock),
      state: () => deps.state().state
    })
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log,
      scheduler: scheduler(),
      ...deps,
      dispatcher
    })
    cleanups.push(() => endpoint.close())
    expect(await endpoint.bind()).toBe('bound')
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)

    const socket = connect(named.value.path)
    cleanups.push(() => void socket.destroy())
    const client = new FrameClient(socket)
    client.send(helloFrame('ui', readToken(input.hostDataDir)))
    await client.until(() => client.frames.length > 0)
    client.send({ type: 'req', id: 'p1', method: 'ping', params: {} })
    await client.until(() => client.frames.length > 1)

    expect(client.frames[1]).toEqual({ type: 'res', id: 'p1', ok: true, result: { at: 1_000 } })
  })

  it('[ADR-003, FM-027, C-11] the bound endpoint shares one throttle: after five failed hellos the next connection gets RATE_LIMITED, even with the right token', async () => {
    const input = factsForThisOs(caseRoot())
    const log = new RecordingDiagnosticsLog()
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log,
      scheduler: scheduler(),
      ...channelDeps(log)
    })
    cleanups.push(() => endpoint.close())
    expect(await endpoint.bind()).toBe('bound')
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)

    const open = (): FrameClient => {
      const socket = connect(named.value.path)
      cleanups.push(() => void socket.destroy())
      return new FrameClient(socket)
    }
    for (let i = 0; i < 5; i += 1) {
      const intruder = open()
      intruder.send(helloFrame('ui', '0'.repeat(64)))
      await intruder.until(() => intruder.closed)
      expect(intruder.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED' }])
    }
    const refused = open()
    refused.send(helloFrame('ui', readToken(input.hostDataDir)))
    await refused.until(() => refused.frames.length > 0)
    expect(refused.frames).toEqual([{ type: 'error', code: 'RATE_LIMITED' }])
    await refused.until(() => refused.closed)
    expect(log.byEvent('channel.rate-limited')).toMatchObject([{ count: 5 }])
  })
})

function helloFrame(role: string, token: string) {
  return {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role,
    token,
    client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 1 }
  }
}

// ADDED for ISSUE-031: run/host.identity is written right after the bind, before ui.token, so no
// hello can be answered before it exists (ADR-002 D3).
describe('the bind step writes run/host.identity (ADR-002 D3)', () => {
  it('[ADR-002] the bind step writes host.identity once the endpoint is bound and before ui.token', async () => {
    const input = factsForThisOs(caseRoot())
    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)
    const seen: string[] = []
    const endpoint = createUiEndpoint({
      facts: () => Promise.resolve({ ok: true, value: input }),
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler(),
      ...channelDeps(),
      identityFile: {
        publish: async () => {
          const reachable = await new Promise<boolean>((resolve) => {
            const socket = connect(named.value.path)
            socket.once('connect', () => {
              socket.destroy()
              resolve(true)
            })
            socket.once('error', () => resolve(false))
          })
          seen.push(`publish: bound ${reachable}, token ${readToken(input.hostDataDir) !== ''}`)
          return 'written'
        },
        remove: () => Promise.resolve()
      }
    })
    cleanups.push(() => endpoint.close())

    expect(await endpoint.bind()).toBe('bound')

    expect(seen).toEqual(['publish: bound true, token false'])
    expect(readToken(input.hostDataDir)).not.toBe('')
  })
})
