// layer: L6
// L6 (17 §1.6): the console viewer's role over the real seam-B transport (ADR-003 item 12, frozen;
// ADR-031 item 2; 14 §6.5 "Roles"; 13 FM-040): hello-first authentication with a per-view token the
// conversation module's console resolver issued, the role table and the frame publisher's per-dwarf
// filter, behind in-process duplexes. The token is read from the file the resolver wrote, as the
// viewer reads it.
//
// TC-170-02 (token used twice or after 60 s → AUTH_FAILED).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, resFrameSchema, type MessageView } from '@dwarfai/contracts'
import type { DwarfId, MessageId } from '../kernel/domain/values'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { createHostConsoleResolver, VIEW_TOKEN_TTL_MS } from '../modules/conversation'
import { FakeConversationQueries } from '../modules/conversation/testing/FakeConversationQueries'
import { emptyDrainGate } from '../wiring/emptyDrainGate'
import { createHostDispatcher } from '../wiring/hostDispatcher'
import { HelloThrottle } from './auth/throttle'
import { UI_TOKEN_FILE, UiToken } from './auth/uiToken'
import { collectCapabilities } from './capabilities'
import { acceptConnection } from './connection'
import { ConnectionRegistry } from './connectionRegistry'
import { createUpgradeDrain } from './lifecycle/drain'
import { HostStateHolder } from './lifecycle/hostState'
import { METHOD_ROLES } from './roles'
import { registerConversationFeed } from './methods/conversationFeed'
import { createUpgradeTargetRule } from './methods/hostUpgradeRequest'
import { SectionRegistry } from './snapshot/sectionRegistry'
import { FrameClient } from './testing/frameClient'
import { inProcessDuplex } from './testing/inProcessDuplex'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0170'
const T0 = 1_790_000_000_000
const id = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const DWARF_A = id(0xa1) as DwarfId
const DWARF_B = id(0xb2) as DwarfId

function message(dwarfId: DwarfId, n: number, text: string): MessageView {
  return {
    id: id(0x300 + n) as MessageId,
    dwarfId,
    role: 'dwarf',
    text,
    attachments: [],
    providerTime: T0,
    createdAt: T0
  }
}

async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-170-viewer-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const uiSecret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const ids = new SequenceIdGenerator()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: EPOCH,
    ids,
    sections: new SectionRegistry(),
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => true
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const conversation = new FakeConversationQueries()
  conversation.seed(DWARF_A, [message(DWARF_A, 1, 'a said')])
  conversation.seed(DWARF_B, [message(DWARF_B, 2, 'b said')])
  registerConversationFeed(dispatcher, { conversation })
  const consoles = createHostConsoleResolver({
    crew: { get: () => ({ owned: true, usagePath: 'driver' }) },
    observed: { processIdentityOf: () => null },
    clock,
    ids,
    hostDataDir: root,
    viewer: { program: join(root, 'dwarfai'), entry: join(root, 'dwarfai-viewer.js'), cwd: root }
  })

  const throttle = new HelloThrottle(clock)
  const connect = (): FrameClient => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle,
      viewers: consoles.viewerTokens
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    return client
  }
  /** A console view of `dwarfId`, as the viewer finds it: its viewId and the token in its file. */
  const openView = async (dwarfId: DwarfId) => {
    const target = await consoles.resolver.targetFor(dwarfId)
    const file = target.credentialFile ?? ''
    // Its first line is the token, its second the dwarf it is bound to (viewerTokenFile.ts).
    const [token = '', bound] = readFileSync(file, 'utf8').split(/\n/)
    expect(bound).toBe(dwarfId)
    return { viewId: basename(file, '.token'), token }
  }
  const hello = async (
    client: FrameClient,
    fields: { role: 'ui' | 'viewer'; token: string; viewId?: string }
  ) => {
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 },
      ...fields
    })
    await client.until(() => client.frames.length > 0)
    return client.frames[0] as { type: string; code?: string }
  }
  return { connect, openView, hello, clock, connections, uiSecret, conversation, dispatcher }
}

let nextId = 0
async function call(client: FrameClient, method: string, params: unknown) {
  nextId += 1
  const requestId = `req-${nextId}`
  client.send({ type: 'req', id: requestId, method, params })
  const isRes = (frame: unknown) =>
    (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === requestId
  await client.until(() => client.frames.some(isRes))
  return resFrameSchema.parse(client.frames.find(isRes))
}

const codeOf = (res: Awaited<ReturnType<typeof call>>): string => (res.ok ? 'ok' : res.error.code)

describe('the viewer role over seam B (ADR-003 item 12)', () => {
  it('[FM-040] a per-view token used twice or after 60 s is refused AUTH_FAILED', async () => {
    const h = await host()

    const once = await h.openView(DWARF_A)
    expect((await h.hello(h.connect(), { role: 'viewer', ...once })).type).toBe('hello.ok')
    expect(await h.hello(h.connect(), { role: 'viewer', ...once })).toMatchObject({
      type: 'error',
      code: 'AUTH_FAILED'
    })

    const late = await h.openView(DWARF_A)
    h.clock.advance(VIEW_TOKEN_TTL_MS + 1)
    expect(await h.hello(h.connect(), { role: 'viewer', ...late })).toMatchObject({
      type: 'error',
      code: 'AUTH_FAILED'
    })
  })

  it('[ADR-003] a viewer hello with the uiToken, with no viewId, or with another view token is refused', async () => {
    const h = await host()
    const a = await h.openView(DWARF_A)
    const b = await h.openView(DWARF_B)

    for (const fields of [
      { role: 'viewer' as const, token: h.uiSecret, viewId: a.viewId },
      { role: 'viewer' as const, token: a.token },
      { role: 'viewer' as const, token: b.token, viewId: a.viewId }
    ]) {
      expect(await h.hello(h.connect(), fields)).toMatchObject({
        type: 'error',
        code: 'AUTH_FAILED'
      })
    }
    // A per-view token is never a uiToken either.
    expect(await h.hello(h.connect(), { role: 'ui', token: b.token })).toMatchObject({
      type: 'error',
      code: 'AUTH_FAILED'
    })
  })

  it('[ADR-031] a viewer subscribed to one dwarf receives nothing of another and any other method is FORBIDDEN', async () => {
    const h = await host()
    const viewer = h.connect()
    expect((await h.hello(viewer, { role: 'viewer', ...(await h.openView(DWARF_A)) })).type).toBe(
      'hello.ok'
    )
    expect(codeOf(await call(viewer, 'events.subscribe', {}))).toBe('ok')

    h.connections.publishFrame(
      'conversation.appended',
      { dwarfId: DWARF_B, messages: [message(DWARF_B, 3, 'b secret')] },
      { dwarfId: DWARF_B }
    )
    h.connections.publishFrame(
      'conversation.appended',
      { dwarfId: DWARF_A, messages: [message(DWARF_A, 4, 'a live')] },
      { dwarfId: DWARF_A }
    )
    await viewer.until(() => JSON.stringify(viewer.frames).includes('a live'))
    expect(JSON.stringify(viewer.frames)).not.toContain('b secret')

    // Its own feed, and FORBIDDEN for another dwarf's.
    const own = await call(viewer, 'conversation.feed', { dwarfId: DWARF_A })
    expect(own.ok && JSON.stringify(own.result).includes('a said')).toBe(true)
    expect(codeOf(await call(viewer, 'conversation.feed', { dwarfId: DWARF_B }))).toBe('FORBIDDEN')

    // Every served method outside its row of the role table (14 §2.3) is FORBIDDEN.
    const outside = h.dispatcher
      .methods()
      .filter((method) => !(METHOD_ROLES[method] ?? []).includes('viewer'))
    expect(outside).toContain('host.shutdown')
    expect(outside).toContain('session.snapshot')
    for (const method of outside) {
      expect(codeOf(await call(viewer, method, {})), method).toBe('FORBIDDEN')
    }
  })
})
