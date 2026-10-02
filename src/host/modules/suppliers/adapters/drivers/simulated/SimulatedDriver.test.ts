import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { FolderPath, LaunchId, MessageId } from '../../../../../kernel/domain/values'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import type { ProviderProfile } from '../../../domain/profile'
import type {
  DriverEvent,
  DriverLaunchRequest,
  InstalledProvider,
  TurnInput
} from '../../../ports/providerDriver'
import {
  SIMULATED_HANDSHAKE_MS,
  SIMULATED_STEP_MS,
  SimulatedDriver,
  type SimulatedSession
} from './SimulatedDriver'

const PROFILE: ProviderProfile = {
  id: 'simulated',
  label: 'Simulated',
  binaries: [],
  models: [],
  efforts: [],
  permissionModes: [],
  drivers: ['acp'],
  publicLaunch: 'enabled'
}

const CAPABILITIES: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'none',
  usage: { fidelity: 0, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}

const INSTALL: InstalledProvider = {
  providerId: 'simulated',
  binaryPath: 'simulated',
  version: '1',
  resolvedVia: 'path',
  statMtimeMs: 0
}

function setup(seed = 'seed-1') {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const driver = new SimulatedDriver({
    profile: PROFILE,
    transport: 'acp',
    capabilities: CAPABILITIES,
    seed,
    clock,
    scheduler
  })
  return { clock, scheduler, driver }
}

function request(
  launchId: string,
  onSpawned: (identity: ProcessIdentity) => Promise<void> = async () => {}
): DriverLaunchRequest {
  return {
    launchId: launchId as LaunchId,
    install: INSTALL,
    cwd: '/work/mine' as FolderPath,
    prompt: 'first prompt',
    permissionMode: null,
    delegation: null,
    spawnTag: `v1:install:${launchId}:epoch`,
    onSpawned
  }
}

const TURN: TurnInput = {
  messageId: 'message-1' as MessageId,
  kind: 'message',
  text: 'dig the north seam',
  attachments: []
}

/** Lets every pending promise continuation run (no timers: the scheduler is fake). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function launched(
  setupResult: ReturnType<typeof setup>,
  launchId = 'launch-1'
): Promise<SimulatedSession> {
  const pending = setupResult.driver.launch(request(launchId))
  await settle()
  setupResult.clock.advance(SIMULATED_HANDSHAKE_MS)
  return pending
}

/** Reads events until one matches `last` (inclusive); every event is already buffered. */
async function readUntil(
  session: SimulatedSession,
  last: (event: DriverEvent) => boolean
): Promise<DriverEvent[]> {
  const seen: DriverEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
    if (last(event)) break
  }
  return seen
}

describe('SimulatedDriver (reference)', () => {
  it('[C-01] launch resolves only after the simulated handshake and binds the SessionRef', async () => {
    const env = setup()
    const spawned: ProcessIdentity[] = []
    let resolved = false
    const pending = env.driver
      .launch(
        request('launch-1', async (identity) => {
          spawned.push(identity)
        })
      )
      .then((session) => {
        resolved = true
        return session
      })

    await settle()
    expect(spawned).toHaveLength(1)
    expect(resolved).toBe(false)

    env.clock.advance(SIMULATED_HANDSHAKE_MS - 1)
    await settle()
    expect(resolved).toBe(false)

    env.clock.advance(1)
    const session = await pending
    expect(session.ref.providerId).toBe('simulated')
    expect(session.ref.providerSessionId).toMatch(/^sim-[0-9a-f]{8}$/)
    expect(session.capabilities).toEqual(CAPABILITIES)

    // Seeded: the same seed and launch bind the same ref; another seed binds another.
    const again = await launched(setup('seed-1'))
    const other = await launched(setup('seed-2'))
    expect(again.ref).toEqual(session.ref)
    expect(other.ref.providerSessionId).not.toBe(session.ref.providerSessionId)
  })

  it('[C-05] a turn yields the echo with echoOf, activity, one turn.ended and status working then idle', async () => {
    const env = setup()
    const session = await launched(env)

    const receipt = await session.sendTurn(TURN)
    env.clock.advance(10_000)
    const events = await readUntil(session, (e) => e.t === 'status' && e.value === 'idle')

    expect(receipt.correlation).not.toBe('')
    expect(receipt.heldUntilTurnEnd).toBe(false)

    const kinds = events.map((e) => e.t)
    expect(kinds[0]).toBe('status')
    expect(events[0]).toEqual({ t: 'status', value: 'working' })
    expect(events.at(-1)).toEqual({ t: 'status', value: 'idle' })

    const echo = events.find((e) => e.t === 'message' && e.record.echoOf !== undefined)
    expect(echo).toMatchObject({
      t: 'message',
      record: { role: 'person', text: TURN.text, echoOf: receipt.correlation }
    })

    const activity = events.filter((e) => e.t === 'activity')
    expect(activity.length).toBeGreaterThan(0)

    const ended = events.filter((e) => e.t === 'turn.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      t: 'turn.ended',
      end: { kind: 'concluded', reliability: 'reliable', cancelledFromApp: false }
    })
    // turn.ended follows every activity of its turn (15 §1.4).
    expect(kinds.lastIndexOf('activity')).toBeLessThan(kinds.indexOf('turn.ended'))
  })

  it('[C-18] a simulated transport loss yields error transport-lost then exited once', async () => {
    const env = setup()
    const session = await launched(env)

    session.simulateTransportLoss()
    session.simulateTransportLoss()

    const events: DriverEvent[] = []
    for await (const event of session.events()) events.push(event)

    expect(events).toEqual([
      { t: 'error', cause: { kind: 'transport-lost', detail: expect.any(String) } },
      { t: 'exited', code: null }
    ])
    await expect(session.sendTurn(TURN)).rejects.toEqual({
      kind: 'session-closed',
      reason: expect.any(String)
    })
  })

  it('[C-08] interrupt mid-turn yields turn.ended interrupted with cancelledFromApp, then idle, and no later step of the turn', async () => {
    const env = setup()
    const session = await launched(env)

    await session.sendTurn(TURN)
    env.clock.advance(SIMULATED_STEP_MS)
    await session.interrupt()
    env.clock.advance(10_000)
    await session.interrupt()
    session.simulateTransportLoss()

    const events: DriverEvent[] = []
    for await (const event of session.events()) events.push(event)
    const afterInterrupt = events.slice(events.findIndex((e) => e.t === 'turn.ended'))

    expect(events.filter((e) => e.t === 'turn.ended')).toEqual([
      {
        t: 'turn.ended',
        end: expect.objectContaining({ kind: 'interrupted', cancelledFromApp: true })
      }
    ])
    expect(afterInterrupt.map((e) => e.t)).toEqual(['turn.ended', 'status', 'error', 'exited'])
    expect(afterInterrupt[1]).toEqual({ t: 'status', value: 'idle' })
    expect(events.some((e) => e.t === 'message' && e.record.role === 'dwarf')).toBe(false)
  })

  it('[C-13] an answer for a request the session never opened is refused ask-closed', async () => {
    const session = await launched(setup())
    const refused = { kind: 'refused', reason: 'ask-closed' }

    expect(await session.answerPermission({ providerRequestId: 'r-1', decision: 'allow' })).toEqual(
      refused
    )
    expect(await session.answerQuestion({ providerRequestId: 'r-2', answers: [] })).toEqual(refused)
    expect(await session.answerQuestion({ providerRequestId: 'r-3', decline: true })).toEqual(
      refused
    )
  })

  it('[C-28] close end-thread resolves closed and ends the stream with exited once; detach is unsupported', async () => {
    const session = await launched(setup())

    expect(await session.close('detach')).toEqual({ kind: 'failed', reason: 'unsupported' })
    expect(await session.close('end-thread')).toEqual({ kind: 'closed' })
    expect(await session.close('end-thread')).toEqual({ kind: 'closed' })

    const events: DriverEvent[] = []
    for await (const event of session.events()) events.push(event)
    expect(events).toEqual([{ t: 'exited', code: 0 }])
  })

  it('[ADR-009] a second launch with the same launchId rejects could-not-start without spawning', async () => {
    const env = setup()
    await launched(env, 'launch-7')
    const spawned: ProcessIdentity[] = []

    const outcome = env.driver
      .launch(request('launch-7', async (identity) => void spawned.push(identity)))
      .then(
        () => 'resolved',
        (error: unknown) => error
      )
    await settle()
    env.clock.advance(SIMULATED_HANDSHAKE_MS)

    expect(await outcome).toEqual({ cause: 'could-not-start', detail: expect.any(String) })
    expect(spawned).toEqual([])
  })
})
