// layer: L6
// L6 (17 §1.6): the Host lifecycle frames over the real seam-B transport — frame codec, hello-first
// authentication, roles, the connection registry — behind an in-process duplex, with every port
// faked (ADR-002 D6, D7; ADR-003 item 12; 14 B-F04, B-F05, §3.5; 07 S12.10, S12.17).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { CleanShutdownReason } from '../../kernel/ports/shutdownCheckpoint'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry, type AttachedConnection } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { CLEAN_EXIT_REASONS, createCleanExit } from './cleanExit'
import { HostStateHolder } from './hostState'
import { closeOnOsSessionEnd } from './osSessionEnd'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0028'

/** One Host transport with its lifecycle: real connections, faked ports. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-028-lifecycle-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const journal: string[] = []
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const dispatcher = new Dispatcher({ log, clock, state: () => state.current().state })
  const ids = new SequenceIdGenerator()
  const checkpoint = new RecordingShutdownCheckpoint(journal)
  const exits: number[] = []
  const endpoint = {
    closed: false,
    close() {
      this.closed = true
      journal.push('endpoint.close')
      return Promise.resolve()
    }
  }
  const cleanExit = createCleanExit({
    checkpoint,
    connections,
    endpoint,
    scheduler,
    log,
    exit: (code) => {
      exits.push(code)
      journal.push(`exit:${code}`)
    }
  })

  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () => [],
      scheduler,
      clock,
      log,
      dispatcher,
      connections
    })
    const client = new FrameClient(pair.client)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    // Every frame a client receives is journaled as it arrives (the in-process pair delivers a
    // write at once), so the journal orders it against the checkpoint, the endpoint and the exit.
    const seen = { count: 1 }
    pair.client.on('data', () => {
      for (; seen.count < client.frames.length; seen.count += 1) {
        const frame = client.frames[seen.count] as { name?: string }
        journal.push(`${role}:${frame.name ?? 'frame'}`)
      }
    })
    return client
  }

  return { journal, log, connections, state, checkpoint, exits, endpoint, cleanExit, attach }
}

/** The evt frames a client received after hello.ok, each validated against its contract schema. */
function evts(
  client: FrameClient
): Array<{ seq: number; epoch: string; name: string; data: unknown }> {
  return client.frames.slice(1).map((frame) => {
    const evt = evtFrameSchema.parse(frame)
    const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
    const schema = schemas[evt.name]
    if (schema === undefined) throw new Error(`no contract schema for ${evt.name}`)
    schema.parse(evt.data)
    return evt
  })
}

/** A viewer as the registry sees it (a viewer cannot authenticate yet: AUTH_FAILED until ISSUE-170). */
class FakeViewer implements AttachedConnection {
  readonly role = 'viewer' as const
  readonly clientId = 'viewer-1'
  readonly frames: HostFrameName[] = []
  ended = false

  send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    void data
    this.frames.push(name)
  }

  end(): Promise<void> {
    this.ended = true
    return Promise.resolve()
  }
}

describe('host.state and host.closing (ADR-002 D6, D7; ADR-003 item 12; 14 B-F04, B-F05)', () => {
  it('[ADR-002] a ui connection receives host.state on starting, migrating, ready and upgrade-pending changes; a notifier connection receives none', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    h.state.report({ state: 'starting', jobStatus: 'none' })
    h.state.report({ state: 'migrating', jobStatus: 'none' })
    h.state.report({ state: 'starting', jobStatus: 'none' })
    h.state.report({ state: 'ready', jobStatus: 'none' })
    h.state.report({ state: 'ready', jobStatus: 'none' }) // no change: nothing is sent
    h.state.report({ state: 'upgrade-pending', jobStatus: 'none' })
    await ui.settle()

    const frames = evts(ui)
    expect(frames.map((frame) => frame.data)).toEqual([
      { state: 'starting', jobStatus: 'none' },
      { state: 'migrating', jobStatus: 'none' },
      { state: 'starting', jobStatus: 'none' },
      { state: 'ready', jobStatus: 'none' },
      { state: 'upgrade-pending', jobStatus: 'none' }
    ])
    expect(frames.every((frame) => frame.name === 'host.state' && frame.epoch === EPOCH)).toBe(true)
    // seq is per connection, monotonic, from 1 after hello.ok (14 §3.2).
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5])
    expect(notifier.frames.slice(1)).toEqual([])
    // hello.ok of a later client carries the same state (ADR-003 item 5).
    const late = await h.attach('ui')
    expect(late.frames[0]).toMatchObject({ state: 'upgrade-pending', jobStatus: 'none' })
  })

  it('[ADR-003] host.closing reaches both the ui and the notifier connections before they close; a viewer sees only its connection close', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')
    const viewer = new FakeViewer()
    h.connections.attach(viewer)

    await h.cleanExit.closeCleanly('stop-all')
    await ui.settle()

    for (const client of [ui, notifier]) {
      const frames = evts(client)
      expect(frames.map((frame) => [frame.name, frame.data])).toEqual([
        ['host.closing', { reason: 'stop-all', clean: true }]
      ])
      expect(client.closed).toBe(true)
    }
    expect(viewer.frames).toEqual([])
    expect(viewer.ended).toBe(true)
    expect(h.connections.connections()).toEqual([])
    expect(h.endpoint.closed).toBe(true)
  })

  it('[ADR-002] host.closing never carries the retired reason idle', async () => {
    for (const reason of CLEAN_EXIT_REASONS) {
      const h = await host()
      const ui = await h.attach('ui')
      await h.cleanExit.closeCleanly(reason)
      await ui.settle()
      expect(evts(ui).map((frame) => frame.data)).toEqual([{ reason, clean: true }])
    }
    expect([...CLEAN_EXIT_REASONS].sort()).toEqual(['os-session-end', 'stop-all', 'upgrade'])

    // TC-028-04: a caller that gets past the type with 'idle' is refused, and nothing is sent.
    const h = await host()
    const ui = await h.attach('ui')
    await expect(h.cleanExit.closeCleanly('idle' as CleanShutdownReason)).rejects.toThrow(/idle/)
    await ui.settle()
    expect(evts(ui)).toEqual([])
    expect(h.checkpoint.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(ui.closed).toBe(false)
  })

  it('[S12.10] an OS session end closes cleanly with reason os-session-end and marks the checkpoint', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')
    const listeners: Array<() => void> = []
    closeOnOsSessionEnd({ onSessionEnd: (listener) => listeners.push(listener) }, h.cleanExit)
    expect(h.exits).toEqual([])

    for (const listener of listeners) listener()
    await ui.settle()

    expect(h.checkpoint.calls).toEqual([
      { kind: 'flush' },
      { kind: 'markClean', reason: 'os-session-end' }
    ])
    for (const client of [ui, notifier]) {
      expect(evts(client).map((frame) => frame.data)).toEqual([
        { reason: 'os-session-end', clean: true }
      ])
    }
    expect(h.exits).toEqual([0])
    expect(h.log.byEvent('host.exit')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', causeClass: 'os-session-end' })
    ])
  })

  it('[ADR-002] the checkpoint runs before host.closing is sent', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    await h.cleanExit.closeCleanly('upgrade')
    await ui.settle()
    await notifier.settle()

    expect(h.journal).toEqual([
      'checkpoint.flush',
      'checkpoint.markClean:upgrade',
      'ui:host.closing',
      'notifier:host.closing',
      'endpoint.close',
      'exit:0'
    ])
    // A second call while the first runs or after it is the same exit, not a second one.
    await h.cleanExit.closeCleanly('stop-all')
    expect(h.exits).toEqual([0])
    expect(h.checkpoint.calls).toHaveLength(2)
  })
})
