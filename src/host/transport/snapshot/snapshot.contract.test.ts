// layer: L6
// L6 (17 §1.6): `session.snapshot` (B-M04) over the real seam-B transport — frame codec, hello-first
// authentication, roles, the Host dispatcher main composes, the connection registry and its frame
// delivery — behind in-process duplexes, with a FakeClock / FakeScheduler and test section
// providers registered in the test (14 §2.3 B-M04, §3.7, §4.1, §4.2, §4.4, §6.5 "Snapshot";
// ADR-003 items 4, 7, frozen). Test frames are published through `publishFrame`; the frames whose
// payloads later issues type are this test's (TEST_FRAMES), every other one is validated against
// its contract schema (14 §1.4).
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  FRAME_CAP_AFTER_HELLO_OK,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  snapshotMetaSchema,
  type HostFrameName,
  type SnapshotSection
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { createUpgradeTargetRule } from '../methods/hostUpgradeRequest'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import type { SnapshotMetaSource } from './metaSection'
import { SectionRegistry } from './sectionRegistry'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0026'
const MiB = 1024 * 1024
const DWARF_A = '0190a6b0-0000-7000-8000-00000000000a'
const DWARF_B = '0190a6b0-0000-7000-8000-00000000000b'

/** Frames whose payload types later issues own: their names are the catalog's, their data is this test's. */
const TEST_FRAMES = new Set(['mine.changed'])

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema !== undefined) schema.parse(data)
  else if (!TEST_FRAMES.has(name)) throw new Error(`no contract schema for ${name}`)
}

/** The cut-0 boot values of the `meta` section (ISSUE-026 lead decision: a fresh DB, no mine row). */
const BOOT_META = { hostVersion: '0.20.0', resetEpoch: 0, snapshotTail: 20, minesEverKnown: false }

/** A page as this test reads it: the 14 §3.7 envelope; each chunk's data is the provider's. */
interface Page {
  snapshotId: string
  seq: number
  epoch: string
  chunks: Array<{ section: SnapshotSection; data: unknown }>
  next?: string
}

type Answer = { ok: true; page: Page; bytes: number } | { ok: false; code: string; bytes: number }

interface HostOptions {
  /** A second Host on the same machine: another boot epoch (14 §4.3 rule 3). */
  epoch?: string
}

/** One Host transport: real connections and dispatcher, faked ports. */
async function host(options: HostOptions = {}) {
  const epoch = options.epoch ?? EPOCH
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-026-snapshot-'))
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
  const snapshotMeta: SnapshotMetaSource = {
    hostVersion: () => BOOT_META.hostVersion,
    state: () => state.current().state,
    resetEpoch: () => BOOT_META.resetEpoch,
    snapshotTail: () => BOOT_META.snapshotTail,
    minesEverKnown: () => BOOT_META.minesEverKnown
  }
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
    epoch,
    ids,
    sections,
    snapshotMeta,
    // The upgrade handshake (ISSUE-032) is composed as production composes it at cut 0; no case
    // here calls it.
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const throttle = new HelloThrottle(clock)

  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({ methods: dispatcher.methods(), sections: sections.names() }),
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

  /** Publishes one frame by name: the cases use catalog names whose payloads later issues type. */
  const publish = (name: string, data: unknown): void =>
    connections.publishFrame(name as HostFrameName, data as never)

  return { clock, log, connections, dispatcher, sections, attach, publish }
}

let nextId = 0

/** Sends one `session.snapshot` request and returns its answer, with the encoded frame's size. */
async function snapshot(client: FrameClient, params: unknown = {}): Promise<Answer> {
  nextId += 1
  const id = `snap-${nextId}`
  client.send({ type: 'req', id, method: 'session.snapshot', params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id) || isOversize(frame)))
  // A frame over the 8 MiB cap (ADR-003 item 4) stops the client's decoder: nothing after it arrives.
  expect(client.frames.filter(isOversize)).toEqual([])
  const raw = client.frames.find((frame) => isRes(frame, id))
  const bytes = Buffer.byteLength(JSON.stringify(raw))
  const res = resFrameSchema.parse(raw)
  return res.ok
    ? { ok: true, page: res.result as Page, bytes }
    : { ok: false, code: res.error.code, bytes }
}

/** Reads every page of one snapshot, in order. */
async function readAll(client: FrameClient, params: unknown = {}): Promise<Page[]> {
  const pages: Page[] = []
  let answer = await snapshot(client, params)
  for (;;) {
    if (!answer.ok) throw new Error(`snapshot page refused: ${answer.code}`)
    expect(answer.bytes).toBeLessThanOrEqual(FRAME_CAP_AFTER_HELLO_OK)
    pages.push(answer.page)
    const next = answer.page.next
    if (next === undefined) return pages
    answer = await snapshot(client, { snapshotId: answer.page.snapshotId, cursor: next })
  }
}

function isOversize(frame: unknown): boolean {
  return (frame as { kind?: string }).kind === 'oversize'
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id: string }).id === id
  )
}

/** The evt frames a client received, in arrival order. */
function evts(client: FrameClient) {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => evtFrameSchema.parse(frame))
}

/** `count` test items of about `bytes` each, numbered in order. */
function bigItems(count: number, bytes: number): Array<{ n: number; pad: string }> {
  return Array.from({ length: count }, (_, n) => ({ n, pad: 'x'.repeat(bytes) }))
}

/** Registers a test provider for `name`: its data is this test's, typed by later issues. */
function register(
  sections: SectionRegistry,
  name: SnapshotSection,
  data: () => unknown,
  roles: ReadonlyArray<'ui' | 'notifier'> = ['ui']
): void {
  sections.registerSection(name, roles, data as never)
}

describe('session.snapshot (B-M04; ADR-003 items 4, 7; 14 §3.7, §4)', () => {
  it('[ADR-003] a ui snapshot returns the meta section with hostVersion, state, resetEpoch, snapshotTail and minesEverKnown', async () => {
    const h = await host()
    const ui = await h.attach('ui')

    const answer = await snapshot(ui)

    expect(answer).toMatchObject({ ok: true })
    if (!answer.ok) return
    // Cut 0: the meta section only, with the true boot values; one page, no cursor.
    expect(answer.page.chunks).toEqual([
      { section: 'meta', data: { ...BOOT_META, state: 'ready' } }
    ])
    expect(snapshotMetaSchema.parse(answer.page.chunks[0]?.data)).toEqual({
      ...BOOT_META,
      state: 'ready'
    })
    expect(answer.page).toMatchObject({ epoch: EPOCH, seq: 1 })
    expect(answer.page.next).toBeUndefined()
  })

  it('[ADR-003] every page of one snapshot carries the same snapshotId and seq, and the last page has no next cursor', async () => {
    const h = await host()
    register(h.sections, 'mines', () => bigItems(40, 512 * 1024))
    const ui = await h.attach('ui')

    const pages = await readAll(ui)

    expect(pages.length).toBeGreaterThan(1)
    const [first] = pages
    for (const page of pages) {
      expect(page.snapshotId).toBe(first?.snapshotId)
      expect(page.seq).toBe(first?.seq)
      expect(page.epoch).toBe(EPOCH)
    }
    expect(pages.slice(0, -1).every((page) => typeof page.next === 'string')).toBe(true)
    expect(pages.at(-1)?.next).toBeUndefined()
  })

  it('[ADR-003] a snapshot is built at seq S: frames published after the build have seq greater than S', async () => {
    const h = await host()
    // A board the test owns. Building `mines` lets another event source run as soon as the build
    // yields: it changes the board and publishes the change (a frame) in the next microtask.
    const board = { mines: ['m1'] }
    let changeQueued = false
    const change = (name: string): void => {
      board.mines.push(name)
      h.publish('mine.changed', { add: name })
    }
    register(h.sections, 'mines', () => {
      if (!changeQueued) {
        changeQueued = true
        queueMicrotask(() => change('m2'))
      }
      return [...board.mines]
    })
    register(h.sections, 'dwarfs', () => [{ minesSeen: board.mines.length }])
    // Enough tails to need more than one page.
    register(h.sections, 'tails', () =>
      bigItems(30, 512 * 1024).map(({ pad }) => ({ dwarfId: DWARF_A, pad }))
    )
    const ui = await h.attach('ui')
    await snapshotSubscribe(ui)
    h.publish('mine.changed', { add: 'm0' })
    board.mines.unshift('m0')

    const first = await snapshot(ui)
    if (!first.ok) throw new Error(first.code)
    const seq = first.page.seq
    // A frame published between two page reads.
    change('m3')
    const rest = await readAll(ui, { snapshotId: first.page.snapshotId, cursor: first.page.next })
    await ui.settle()

    // S is the seq of the last frame the connection was sent before the build (host.state = 1,
    // then the m0 change).
    expect(seq).toBe(2)
    expect(rest.every((page) => page.seq === seq)).toBe(true)
    const after = evts(ui).filter((frame) => frame.seq > seq)
    expect(after.map((frame) => frame.data)).toEqual([{ add: 'm2' }, { add: 'm3' }])
    // The snapshot at S plus the frames after S is the live board (14 §4.2, §4.3 rule 1).
    const chunk = (section: SnapshotSection) =>
      first.page.chunks.find((c) => c.section === section)?.data
    const mines = [...(chunk('mines') as string[])]
    for (const frame of after) mines.push((frame.data as { add: string }).add)
    expect(mines).toEqual(board.mines)
    // Every section reflects the same S: the dwarfs section saw the board the mines section saw.
    expect(chunk('dwarfs')).toEqual([{ minesSeen: (chunk('mines') as string[]).length }])
  })

  it('[ADR-003] a page request more than 30 s after the previous read gets SNAPSHOT_EXPIRED', async () => {
    const h = await host()
    register(h.sections, 'mines', () => bigItems(60, 512 * 1024))
    const ui = await h.attach('ui')

    const first = await snapshot(ui)
    if (!first.ok) throw new Error(first.code)
    await idle(h.clock, ui, 29_999)
    const second = await snapshot(ui, {
      snapshotId: first.page.snapshotId,
      cursor: first.page.next
    })
    if (!second.ok) throw new Error(second.code)
    // The 30 s run from the previous read, not from the build.
    await idle(h.clock, ui, 29_999)
    const third = await snapshot(ui, {
      snapshotId: second.page.snapshotId,
      cursor: second.page.next
    })
    if (!third.ok) throw new Error(third.code)
    expect(third.page.next).toEqual(expect.any(String))
    await idle(h.clock, ui, 30_000)

    const late = await snapshot(ui, { snapshotId: third.page.snapshotId, cursor: third.page.next })

    expect(late).toMatchObject({ ok: false, code: 'SNAPSHOT_EXPIRED' })
  })

  it('[ADR-003] no page exceeds 8 MiB: a test section of 20 MiB is split across pages in chunk order', async () => {
    const h = await host()
    // 20 MiB of mines in items of 64 KiB (the provider's items), plus a dwarfs section after it.
    const mines = bigItems((20 * MiB) / (64 * 1024), 64 * 1024 - 20)
    register(h.sections, 'mines', () => mines)
    register(h.sections, 'dwarfs', () => [{ d: 1 }])
    const ui = await h.attach('ui')

    const pages = await readAll(ui)

    expect(pages.length).toBeGreaterThanOrEqual(3)
    // readAll checked every encoded res frame against the 8 MiB cap; the client decoded every
    // frame (an oversize one would have stopped the decoder).
    expect(ui.frames.filter(isOversize)).toEqual([])
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8 * MiB)
    }
    const order = pages.flatMap((page) => page.chunks.map((chunk) => chunk.section))
    expect(order[0]).toBe('meta')
    expect(order.at(-1)).toBe('dwarfs')
    expect(new Set(order.slice(1, -1))).toEqual(new Set(['mines']))
    // Split by the provider's items: every item exactly once, in order.
    const read = pages.flatMap((page) =>
      page.chunks.filter((chunk) => chunk.section === 'mines').flatMap((chunk) => chunk.data)
    )
    expect(read).toEqual(mines)
  })

  it('[ADR-003] chunks come in the 14 §4.2 order: meta, preferences, mines, dwarfs, asks, launches, recovery, then tails and marks per dwarf', async () => {
    const h = await host()
    // Registered out of order on purpose.
    register(h.sections, 'marks', () => [
      { dwarfId: DWARF_B, mark: 'b1' },
      { dwarfId: DWARF_A, mark: 'a1' },
      { dwarfId: DWARF_A, mark: 'a2' }
    ])
    register(h.sections, 'recovery', () => null)
    register(h.sections, 'tails', () => [
      { dwarfId: DWARF_A, tail: 'a' },
      { dwarfId: DWARF_B, tail: 'b' }
    ])
    register(h.sections, 'launches', () => [])
    register(h.sections, 'asks', () => ({ asks: [], needsYou: [] }))
    register(h.sections, 'dwarfs', () => [])
    register(h.sections, 'mines', () => [])
    register(h.sections, 'preferences', () => ({ p: 1 }))
    const ui = await h.attach('ui')

    const pages = await readAll(ui)

    const chunks = pages.flatMap((page) => page.chunks)
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      'meta',
      'preferences',
      'mines',
      'dwarfs',
      'asks',
      'launches',
      'recovery',
      'tails',
      'marks',
      'tails',
      'marks'
    ])
    expect(chunks.slice(7).map((chunk) => chunk.data)).toEqual([
      [{ dwarfId: DWARF_A, tail: 'a' }],
      [
        { dwarfId: DWARF_A, mark: 'a1' },
        { dwarfId: DWARF_A, mark: 'a2' }
      ],
      [{ dwarfId: DWARF_B, tail: 'b' }],
      [{ dwarfId: DWARF_B, mark: 'b1' }]
    ])
  })

  it('[ADR-003] a request for an unknown or unadvertised section gets INVALID_PARAMS', async () => {
    const h = await host()
    const ui = await h.attach('ui')

    // `mines` is a 14 §3.7 name, but no provider is registered at cut 0: not advertised.
    expect(await snapshot(ui, { sections: ['mines'] })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS'
    })
    expect(await snapshot(ui, { sections: ['tails.v2'] })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS'
    })
    const metaOnly = await snapshot(ui, { sections: ['meta'] })
    expect(metaOnly).toMatchObject({ ok: true })
  })

  it('[ADR-003] a notifier may read only mine-names and dwarf-names; a viewer calling session.snapshot gets FORBIDDEN', async () => {
    const h = await host()
    register(h.sections, 'mines', () => [])
    register(h.sections, 'mine-names', () => [{ id: 'm', name: 'mine' }], ['notifier'])
    register(h.sections, 'dwarf-names', () => [{ id: 'd', displayName: 'dwarf' }], ['notifier'])
    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')

    const names = await readAll(notifier)
    expect(names.flatMap((page) => page.chunks.map((chunk) => chunk.section))).toEqual([
      'mine-names',
      'dwarf-names'
    ])
    expect(await snapshot(notifier, { sections: ['meta'] })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN'
    })
    expect(await snapshot(notifier, { sections: ['mines', 'mine-names'] })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN'
    })
    // A request outside the role scope is a client defect: logged `error` (FM-035), names only.
    expect(h.log.byEvent('channel.forbidden')).toEqual([
      expect.objectContaining({ level: 'error', method: 'session.snapshot', role: 'notifier' }),
      expect.objectContaining({ level: 'error', method: 'session.snapshot', role: 'notifier' })
    ])
    // The ui reads every ui section and never the notifier's names sections by default.
    const board = await readAll(ui)
    expect(board.flatMap((page) => page.chunks.map((chunk) => chunk.section))).toEqual([
      'meta',
      'mines'
    ])

    const viewer = await h.dispatcher.dispatch(
      { id: 'v1', method: 'session.snapshot', params: {} },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(viewer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[ADR-003] hello.ok capabilities list section:meta and every registered section name', async () => {
    const h = await host()
    register(h.sections, 'mines', () => [])
    register(h.sections, 'dwarf-names', () => [], ['notifier'])
    const ui = await h.attach('ui')

    const capabilities = (ui.frames[0] as { capabilities: string[] }).capabilities

    expect(capabilities).toEqual(
      expect.arrayContaining([
        'session.snapshot',
        'section:meta',
        'section:mines',
        'section:dwarf-names'
      ])
    )
    expect(capabilities.filter((name) => name.startsWith('section:'))).toHaveLength(3)
  })

  it('[NFR-SEC-12] the snapshot result is never logged: a canary value in a test section never reaches a log record', async () => {
    const h = await host()
    const canary = 'canary-0026-section-content'
    register(h.sections, 'mines', () => [{ name: canary }, ...bigItems(20, 512 * 1024)])
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    const pages = await readAll(ui)
    await snapshot(notifier, { sections: ['mines'] })
    await snapshot(ui, { snapshotId: pages[0]?.snapshotId, cursor: 'forged' })

    expect(JSON.stringify(pages)).toContain(canary)
    expect(h.log.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(h.log.entries)).not.toContain(canary)
    expect(JSON.stringify(h.log.entries)).not.toContain('xxxxxxxx')
  })

  it('[ADR-003] pages are neither skipped nor duplicated: only the cursor of the next page is accepted', async () => {
    const h = await host()
    const items = bigItems(60, 512 * 1024)
    register(h.sections, 'mines', () => items)
    const ui = await h.attach('ui')

    const first = await snapshot(ui)
    if (!first.ok) throw new Error(first.code)
    const second = await snapshot(ui, {
      snapshotId: first.page.snapshotId,
      cursor: first.page.next
    })
    if (!second.ok) throw new Error(second.code)

    // The cursor of a page already read (a duplicate) and a cursor never issued (a skip).
    expect(
      await snapshot(ui, { snapshotId: first.page.snapshotId, cursor: first.page.next })
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(
      await snapshot(ui, { snapshotId: first.page.snapshotId, cursor: `${second.page.next}9` })
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    // A cursor without its snapshotId, or a continuation that names sections.
    expect(await snapshot(ui, { cursor: second.page.next })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS'
    })
    expect(
      await snapshot(ui, {
        snapshotId: first.page.snapshotId,
        cursor: second.page.next,
        sections: ['mines']
      })
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })

    // The refusals did not move the snapshot: the next page follows the second one.
    const rest = await readAll(ui, { snapshotId: first.page.snapshotId, cursor: second.page.next })
    const pages = [first.page, second.page, ...rest]
    const read = pages.flatMap((page) =>
      page.chunks.filter((chunk) => chunk.section === 'mines').flatMap((chunk) => chunk.data)
    )
    expect(read).toEqual(items)
    // After the last page the snapshot is released: its cursors are gone.
    expect(
      await snapshot(ui, { snapshotId: first.page.snapshotId, cursor: rest.at(-2)?.next })
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_EXPIRED' })
  })

  it('[ADR-003] a snapshotId from another Host epoch or another connection gets SNAPSHOT_EXPIRED', async () => {
    const before = await host()
    register(before.sections, 'mines', () => bigItems(30, 512 * 1024))
    const old = await before.attach('ui')
    const page = await snapshot(old)
    if (!page.ok) throw new Error(page.code)
    expect(page.page.next).toEqual(expect.any(String))

    // The Host restarted: a new epoch never continues a snapshot of the old one (14 §4.3 rule 3).
    const after = await host({ epoch: 'epoch-0026-restarted' })
    register(after.sections, 'mines', () => bigItems(30, 512 * 1024))
    const fresh = await after.attach('ui')
    // The new Host holds a paged snapshot of its own, built by its first connection.
    const own = await snapshot(fresh)
    expect(own).toMatchObject({ ok: true })
    expect(
      await snapshot(fresh, { snapshotId: page.page.snapshotId, cursor: page.page.next })
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_EXPIRED' })

    // Same Host, another connection: the pages are held for the connection that built them.
    const other = await before.attach('ui')
    expect(
      await snapshot(other, { snapshotId: page.page.snapshotId, cursor: page.page.next })
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_EXPIRED' })
    // The builder still reads its next page.
    expect(
      await snapshot(old, { snapshotId: page.page.snapshotId, cursor: page.page.next })
    ).toMatchObject({ ok: true })
  })
})

/**
 * Lets `ms` pass on the Host's clock while the client stays attached: like the UI, it pings every
 * 5 s while idle (ADR-003 item 9), so the 15 s silence watch never ends the connection.
 */
async function idle(clock: FakeClock, client: FrameClient, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5_000) {
    nextId += 1
    const id = `ping-${nextId}`
    client.send({ type: 'req', id, method: 'ping', params: {} })
    await client.until(() => client.frames.some((frame) => isRes(frame, id)))
    clock.advance(Math.min(5_000, left))
  }
}

/** Subscribes first, as ADR-003 item 7 orders (subscribe, then snapshot). */
async function snapshotSubscribe(client: FrameClient): Promise<void> {
  nextId += 1
  const id = `sub-${nextId}`
  client.send({ type: 'req', id, method: 'events.subscribe', params: {} })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
}
