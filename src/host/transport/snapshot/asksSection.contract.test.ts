// layer: L6
// L6 (17 §1.6): the snapshot's `asks` section (14 §3.7, §4.1–§4.3, frozen; ADR-010 items 6, 9;
// ADR-003 item 7) over the real seam-B transport — frame codec, hello-first authentication, roles,
// the Host dispatcher main composes and the connection registry — behind in-process duplexes. The
// asks are rows of a template-database copy read by the real `SqliteAskRepository` (owner amendment
// L `live`, `asks_live` / `asks_needs_you`), so a Host restart is a new repository and read model
// over the same rows; crew is a double that knows each dwarf's mine. The ask frames are projected by
// frames/askFrames.ts from a recording bus, as the broker will publish them (later: ISSUE-129,
// ISSUE-140). Every frame and every snapshot page is checked against its contract schema (14 §1.4).
//
// TC-130-01 (the section holds exactly the open and answering asks with `currentStep` and the
// needs-you order), TC-130-02 (the section and the frames reach `ui` only).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  snapshotChunkSchema,
  snapshotPageSchema,
  type HostFrameName,
  type SnapshotPage,
  type SnapshotSectionData
} from '@dwarfai/contracts'
import type { AskId, DwarfId, EventId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import {
  createAskQueries,
  type AskingEvent,
  type AskRecord,
  type AskRepository
} from '../../modules/asking'
import type { CrewQueries } from '../../modules/crew'
import { permissionAsk, questionAsk } from '../../modules/asking/testing/askRepository.contract'
import { ASK_DWARFS, ASK_MINE, ASK_T0, seededAskDb } from '../../modules/asking/testing/sqliteAskDb'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { ASK_FRAMES, publishAskFrames } from '../frames/askFrames'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { createUpgradeTargetRule } from '../methods/hostUpgradeRequest'
import { fixedSnapshotMeta } from '../testing/fixedSnapshotMeta'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerAsksSection } from './asksSection'
import { SectionRegistry } from './sectionRegistry'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0130'
const [DWARF_A, DWARF_B] = ASK_DWARFS

/** A test `tails` section of about 15 MiB: enough to need more than one page (8 MiB, ADR-003 item 4). */
const BIG_TAILS = Array.from({ length: 30 }, (_, n) => ({ n, pad: 'x'.repeat(512 * 1024) }))

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** Crew's `get`, reduced to the one field the needs-you queue reads: both seeded dwarfs' mine. */
const crew: Pick<CrewQueries, 'get'> = {
  get: (dwarfId) =>
    ASK_DWARFS.includes(dwarfId)
      ? ({ id: dwarfId, mineId: ASK_MINE } as ReturnType<CrewQueries['get']>)
      : null
}

let eventSeq = 0

/** An asking event in the kernel envelope (08 §1.2), published after its commit. */
function event<E extends AskingEvent>(type: E['type'], payload: E['payload']): E {
  eventSeq += 1
  return {
    type,
    v: 1,
    id: `event-0130-section-${eventSeq}` as EventId,
    at: ASK_T0,
    hostEpoch: EPOCH,
    payload
  } as E
}

interface HostOptions {
  /** Registers a test `tails` section big enough to page the snapshot. */
  bigTails?: boolean
}

/**
 * One Host boot over the asks stored in `db`: a new repository and read model, the `asks` section
 * registered on its section registry and the ask frames routed to its connections.
 */
async function host(store: ReturnType<typeof seededAskDb>, options: HostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-130-section-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  // `host.state {ready}` is the ui target's first frame: seq 1.
  state.report({ state: 'ready', jobStatus: 'none' })
  const sections = new SectionRegistry()
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
    sections,
    snapshotMeta: fixedSnapshotMeta(() => state.current().state),
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const repository: AskRepository = store.open()
  const queries = createAskQueries({ asks: repository, crew })
  registerAsksSection(sections, { asks: queries })
  if (options.bigTails === true) {
    sections.registerSection('tails', ['ui'], () => BIG_TAILS as never)
  }
  const bus = new RecordingEventBus<AskingEvent>()
  cleanups.push(publishAskFrames({ events: bus, asks: queries, frames: connections }))
  const throttle = new HelloThrottle(clock)

  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: ASK_FRAMES,
          sections: sections.names()
        }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
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
    return client
  }

  /** Saves `ask` in its own transaction, then publishes `AskOpened` as the broker's `open` will. */
  const open = (ask: AskRecord): void => {
    store.runner.inTransaction(() => repository.save(ask))
    bus.publish(event('AskOpened', { ask }))
  }

  return { log, queries, repository, attach, open }
}

let nextId = 0

/** Sends one request and returns its `res` frame. */
async function request(client: FrameClient, method: string, params: unknown = {}) {
  nextId += 1
  const id = `req-0130-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

/** One `session.snapshot` page, validated against 14 §3.7 (the test `tails` section is not). */
async function page(client: FrameClient, params: unknown = {}): Promise<SnapshotPage> {
  const res = await request(client, 'session.snapshot', params)
  if (!res.ok) throw new Error(`snapshot refused: ${res.error.code}`)
  const raw = res.result as SnapshotPage
  for (const chunk of raw.chunks) {
    if (chunk.section !== 'tails') snapshotChunkSchema.parse(chunk)
  }
  return snapshotPageSchema
    .omit({ chunks: true })
    .passthrough()
    .parse(raw) as unknown as SnapshotPage
}

/** Every page of one snapshot, in order. */
async function readAll(client: FrameClient, params: unknown = {}): Promise<SnapshotPage[]> {
  const pages = [await page(client, params)]
  for (let last = pages[0]; last?.next !== undefined; last = pages.at(-1)) {
    pages.push(await page(client, { snapshotId: last.snapshotId, cursor: last.next }))
  }
  return pages
}

/** The `asks` chunk of a snapshot's pages, or undefined when none carries it. */
function asksOf(pages: SnapshotPage[]): SnapshotSectionData<'asks'> | undefined {
  for (const p of pages) {
    const chunk = p.chunks.find((c) => c.section === 'asks')
    if (chunk !== undefined) return chunk.data as SnapshotSectionData<'asks'>
  }
  return undefined
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id: string }).id === id
  )
}

/** The evt frames a client received, validated, in arrival order. */
function evts(client: FrameClient) {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => {
      const evt = evtFrameSchema.parse(frame)
      validateFrame(evt.name, evt.data)
      return evt
    })
}

describe('the asks section of session.snapshot (14 §3.7, §4.1–§4.3; ADR-010 items 6, 9)', () => {
  it('[ADR-010] the asks section lists every open or answering ask with its current step and the needs-you order', async () => {
    const store = seededAskDb()
    const first = await host(store)
    const queuedA = questionAsk(1, DWARF_A, { openedAt: ASK_T0 + 300, currentStep: 0 })
    const frontB = questionAsk(2, DWARF_B, { openedAt: ASK_T0 + 200 })
    const frontA = permissionAsk(3, DWARF_A, { openedAt: ASK_T0 + 100 })
    const closed = permissionAsk(4, DWARF_B, {
      openedAt: ASK_T0 + 50,
      state: 'answered-elsewhere',
      closedAt: ASK_T0 + 60
    })
    for (const ask of [queuedA, frontB, frontA, closed]) first.open(ask)
    // The person walked B's question to its second step (OQ-03); A's front ask is being answered.
    store.runner.inTransaction(() => {
      first.repository.save({ ...frontB, currentStep: 1 })
      first.repository.settle(frontA.id as AskId, { requestId: 'r-0130-a' })
    })
    const expected = {
      asks: [{ ...frontA, state: 'answering' }, { ...frontB, currentStep: 1 }, queuedA],
      needsYou: [
        { dwarfId: DWARF_A, mineId: ASK_MINE, askedAt: ASK_T0 + 100 },
        { dwarfId: DWARF_B, mineId: ASK_MINE, askedAt: ASK_T0 + 200 }
      ]
    }

    expect(asksOf(await readAll(await first.attach('ui')))).toStrictEqual(expected)

    // A Host restart: a new boot over the same rows, before any ask event was published to it.
    const restarted = await host(store)
    expect(asksOf(await readAll(await restarted.attach('ui')))).toStrictEqual(expected)
  })

  it('[ADR-003] hello.ok advertises section:asks and the three ask frames', async () => {
    const h = await host(seededAskDb())
    const ui = await h.attach('ui')

    const capabilities = (ui.frames[0] as { capabilities: string[] }).capabilities
    expect(capabilities).toEqual(
      expect.arrayContaining([
        'section:asks',
        'frame:ask.opened',
        'frame:ask.closed',
        'frame:ask.step'
      ])
    )
  })

  it('[ADR-003] a closed ask is never in the asks section', async () => {
    const store = seededAskDb()
    const h = await host(store)
    const ask = permissionAsk(1, DWARF_A)
    const kept = questionAsk(2, DWARF_B)
    h.open(ask)
    h.open(kept)
    const ui = await h.attach('ui')
    expect(asksOf(await readAll(ui))?.asks.map((a) => a.id)).toEqual([ask.id, kept.id])

    for (const state of ['answered-in-app', 'cancelled', 'closed-by-death'] as const) {
      store.runner.inTransaction(() => h.repository.save({ ...ask, state, closedAt: ASK_T0 + 500 }))
      expect(asksOf(await readAll(ui))).toStrictEqual({
        asks: [kept],
        needsYou: [{ dwarfId: DWARF_B, mineId: ASK_MINE, askedAt: kept.openedAt }]
      })
    }
  })

  it('[ADR-003] the asks section is served to ui only: a notifier neither receives nor may request it', async () => {
    const store = seededAskDb()
    const h = await host(store)
    h.open(permissionAsk(1, DWARF_A))
    const notifier = await h.attach('notifier')

    const all = await readAll(notifier)
    expect(asksOf(all)).toBeUndefined()
    const asked = await request(notifier, 'session.snapshot', { sections: ['asks'] })
    expect(asked.ok).toBe(false)
    expect(evts(notifier).filter((frame) => frame.name.startsWith('ask.'))).toEqual([])
  })

  it("[ADR-010] AskQueries.openAskOf answers the dwarf's open or answering ask and null once it closed", async () => {
    const store = seededAskDb()
    const h = await host(store)
    const front = permissionAsk(1, DWARF_A, { openedAt: ASK_T0 + 10 })
    const queued = questionAsk(2, DWARF_A, { openedAt: ASK_T0 + 20 })
    h.open(front)
    h.open(queued)

    expect(h.queries.openAskOf(DWARF_A)).toStrictEqual(front)
    store.runner.inTransaction(() =>
      h.repository.settle(front.id as AskId, { requestId: 'r-0130-open' })
    )
    expect(h.queries.openAskOf(DWARF_A)).toStrictEqual({ ...front, state: 'answering' })
    store.runner.inTransaction(() =>
      h.repository.save({ ...front, state: 'answered-in-app', closedAt: ASK_T0 + 30 })
    )
    expect(h.queries.openAskOf(DWARF_A)).toStrictEqual(queued)
    store.runner.inTransaction(() =>
      h.repository.save({ ...queued, state: 'cancelled', closedAt: ASK_T0 + 40 })
    )
    expect(h.queries.openAskOf(DWARF_A)).toBeNull()
    expect(h.queries.openAskOf(DWARF_B as DwarfId)).toBeNull()
    // After a restart, read from the stored rows.
    expect((await host(store)).queries.openAskOf(DWARF_A)).toBeNull()
  })

  it("[ADR-003] an ask opened between two snapshot pages arrives as a frame with a seq above the snapshot's", async () => {
    const store = seededAskDb()
    const h = await host(store, { bigTails: true })
    const ui = await h.attach('ui')
    const subscribed = await request(ui, 'events.subscribe', {})
    expect(subscribed.ok).toBe(true)
    // An earlier snapshot, then an ask opened before the one under test: its frame is at or
    // below that snapshot's seq, so a reader drops the frame and finds the ask in the chunk.
    await readAll(ui)
    const before = permissionAsk(1, DWARF_A, { openedAt: ASK_T0 + 10 })
    h.open(before)

    const first = await page(ui)
    expect(first.next).toEqual(expect.any(String))
    const seq = first.seq
    // An ask opened between two page reads.
    const between = questionAsk(2, DWARF_B, { openedAt: ASK_T0 + 20 })
    h.open(between)
    const rest = await readAll(ui, { snapshotId: first.snapshotId, cursor: first.next })
    await ui.settle()

    expect(rest.every((p) => p.seq === seq)).toBe(true)
    const chunk = asksOf([first, ...rest])
    expect(chunk?.asks.map((a) => a.id)).toEqual([before.id])
    const opened = evts(ui).filter((frame) => frame.name === ('ask.opened' satisfies HostFrameName))
    const openedBefore = opened.find(
      (frame) => HOST_FRAME_SCHEMAS['ask.opened'].parse(frame.data).ask.id === before.id
    )
    const openedBetween = opened.find(
      (frame) => HOST_FRAME_SCHEMAS['ask.opened'].parse(frame.data).ask.id === between.id
    )
    expect(openedBefore?.seq).toBeLessThanOrEqual(seq)
    expect(openedBetween?.seq).toBeGreaterThan(seq)

    // 14 §4.3 rule 1 (ADR-033): the chunk plus the frames above S, frames at or below S dropped,
    // is every open ask once.
    const live = new Map((chunk?.asks ?? []).map((a) => [a.id, a]))
    for (const frame of opened.filter((f) => f.seq > seq)) {
      const ask = HOST_FRAME_SCHEMAS['ask.opened'].parse(frame.data).ask
      live.set(ask.id, ask)
    }
    expect([...live.keys()]).toEqual(h.queries.openAsks().map((a) => a.id))
    expect([...live.keys()]).toEqual([before.id, between.id])
  })
})
