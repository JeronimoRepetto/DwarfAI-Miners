// layer: L6
// L6 (17 §1.6): B-M06 `host.upgrade.request` and B-M05 `host.shutdown {upgrade-drain}` over the real
// seam-B transport — frame codec, hello-first authentication, roles, the dispatcher with its
// requestId de-duplication, the connection registry, the lifecycle state, the upgrade drain and the
// clean exit — behind an in-process duplex, with every port faked except the file system the
// targetDir rule reads (14 §2.3 B-M05, B-M06, §1.7, §1.10, §3.4; ADR-002 D7, D8; 07 S12.13–S12.17;
// 13 FM-024, FM-035; AMENDMENT-2 SC-AR-03).
//
// TC-032-01 (Host half), TC-032-02 and TC-032-05.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  type DwarfId
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeDrainGate } from '../../kernel/fakes/FakeDrainGate'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { createCleanExit } from '../lifecycle/cleanExit'
import { createUpgradeDrain, DRAIN_RECHECK_MS } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerHostShutdown } from './hostShutdown'
import { createUpgradeTargetRule, registerHostUpgradeRequest } from './hostUpgradeRequest'
import { registerPing } from './ping'

const WINDOWS = process.platform === 'win32'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0032'
const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER_REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8059'
const SESSION_DWARF = '01890a5d-ac96-774b-bcce-b302099a8061' as DwarfId
const TARGET_VERSION = '0.21.0'

/** A fresh temporary folder, removed after the case. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A directory link at `link` to `target`: a junction on Windows (no privilege needed). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, WINDOWS ? 'junction' : 'dir')
  // Unlinked before the folders are removed, so a removal never follows it (runs first: LIFO).
  cleanups.push(() => unlinkSync(link))
}

/** Every path under `dir` with its mtime, to prove a refusal touched nothing on disk. */
function snapshotTree(dir: string): string[] {
  const out: string[] = []
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, name.name)
      out.push(`${relative(dir, full)}@${statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0}`)
      if (name.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out.sort()
}

/** One Host transport serving host.upgrade.request and host.shutdown: real connections, faked ports. */
async function host(options: { gate?: FakeDrainGate } = {}) {
  const root = tempDir('dwarfai-032-upgrade-')
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const copyRoot = join(root, 'DwarfAI', 'host')
  const targetDir = join(copyRoot, TARGET_VERSION)
  mkdirSync(targetDir, { recursive: true })
  const journal: string[] = []
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'n/a' })
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => state.current().state
  })
  const ids = new SequenceIdGenerator()
  const checkpoint = new RecordingShutdownCheckpoint(journal)
  const stopAll = new RecordingStopAll({ journal })
  const gate = options.gate ?? new FakeDrainGate()
  const exits: number[] = []
  const endpoint = {
    closed: false,
    close() {
      this.closed = true
      journal.push('endpoint.close')
      return Promise.resolve()
    }
  }
  const lifecycle = createCleanExit({
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
  const drain = createUpgradeDrain({
    gate,
    state,
    scheduler,
    lifecycle,
    log,
    checkpointSessions: () => {
      journal.push('sessions.checkpoint')
      return Promise.resolve()
    }
  })
  registerPing(dispatcher, clock)
  registerHostShutdown(dispatcher, { stopAll, lifecycle, log, drain })
  registerHostUpgradeRequest(dispatcher, {
    drain,
    target: createUpgradeTargetRule({
      platform: WINDOWS ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      root: copyRoot,
      realpath: realpathSync.native
    })
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
      connections,
      throttle: new HelloThrottle(clock)
    })
    const client = new FrameClient(pair.client)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION + 1,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'def5678', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    // Every frame a client receives is journaled as it arrives (the in-process pair delivers a
    // write at once): a `res` by its type, an `evt` by its name, and the close.
    const seen = { count: 1 }
    pair.client.on('data', () => {
      for (; seen.count < client.frames.length; seen.count += 1) {
        const frame = client.frames[seen.count] as { type?: string; name?: string }
        journal.push(`${role}:${frame.name ?? frame.type ?? 'frame'}`)
      }
    })
    pair.client.once('close', () => journal.push(`${role}:closed`))
    return client
  }

  /** Sends `method` with `params` and resolves with its `res` frame. */
  const call = async (
    client: FrameClient,
    method: string,
    params: unknown,
    id = 'r1'
  ): Promise<ReturnType<typeof resFrameSchema.parse>> => {
    client.send({ type: 'req', id, method, params })
    await client.until(() => resOf(client, id) !== undefined)
    await client.settle()
    const res = resOf(client, id)
    if (res === undefined) throw new Error(`no res for ${id}`)
    return res
  }

  /** Lets the deferred effects and the clean exit's later steps run. */
  const settle = async (client: FrameClient): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await client.settle()
  }

  return {
    root,
    copyRoot,
    targetDir,
    journal,
    clock,
    log,
    state,
    checkpoint,
    stopAll,
    gate,
    exits,
    endpoint,
    attach,
    call,
    settle
  }
}

function resOf(
  client: FrameClient,
  id: string
): ReturnType<typeof resFrameSchema.parse> | undefined {
  for (const frame of client.frames) {
    const res = resFrameSchema.safeParse(frame)
    if (res.success && res.data.id === id) return res.data
  }
  return undefined
}

/** The evt frames a client received after hello.ok, as `name` with their data. */
function evts(client: FrameClient): Array<{ name: string; data: unknown }> {
  return client.frames
    .slice(1)
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => {
      const { name, data } = frame as { name: string; data: unknown }
      return { name, data }
    })
}

const PENDING_FRAME = { name: 'host.state', data: { state: 'upgrade-pending', jobStatus: 'n/a' } }
const UPGRADE_CLOSING = { name: 'host.closing', data: { reason: 'upgrade', clean: true } }

describe('host.upgrade.request (14 B-M06; ADR-002 D8; 07 S12.13–S12.16)', () => {
  it('[ADR-002, S12.13] host.upgrade.request moves the Host to upgrade-pending and publishes host.state', async () => {
    const gate = new FakeDrainGate([{ kind: 'open-turn', dwarfId: SESSION_DWARF }])
    const h = await host({ gate })
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    const res = await h.call(ui, 'host.upgrade.request', {
      targetVersion: TARGET_VERSION,
      targetDir: h.targetDir,
      requestId: REQUEST_ID
    })

    expect(res).toEqual({ type: 'res', id: 'r1', ok: true, result: { state: 'upgrade-pending' } })
    expect(
      HOST_METHOD_SCHEMAS['host.upgrade.request'].result.safeParse(res.ok ? res.result : null)
        .success
    ).toBe(true)
    expect(h.state.current()).toEqual({ state: 'upgrade-pending', jobStatus: 'n/a' })
    // 14 §1.7: the frame the command caused precedes its `res`; the notifier never gets host.state.
    expect(h.journal.slice(0, 2)).toEqual(['ui:host.state', 'ui:res'])
    expect(evts(ui)).toEqual([PENDING_FRAME])
    expect(evts(notifier)).toEqual([])
    expect(h.log.byEvent('host.upgrade')).toContainEqual(
      expect.objectContaining({ level: 'info', subsystem: 'host', causeClass: 'upgrade-pending' })
    )
  })

  it('[ADR-002] a targetDir outside the versioned-copy root, with .. segments, relative or through a symlink out of it is refused INVALID_PARAMS before any file is touched', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    // Folders named like the target, outside the root, and links that lead out of it.
    const outside = tempDir('dwarfai-032-outside-')
    const linkedVersion = '0.22.0'
    mkdirSync(join(outside, TARGET_VERSION))
    mkdirSync(join(outside, linkedVersion))
    mkdirSync(join(h.copyRoot, '0.19.0'))
    // Named for its version and inside the root by name, but it leads out of the root.
    linkDir(join(outside, linkedVersion), join(h.copyRoot, linkedVersion))
    const before = [snapshotTree(h.root), snapshotTree(outside)]

    const refused: Array<[string, { targetVersion: string; targetDir: string }]> = [
      [
        'outside the root',
        { targetVersion: TARGET_VERSION, targetDir: join(outside, TARGET_VERSION) }
      ],
      [
        'with .. segments',
        {
          targetVersion: TARGET_VERSION,
          targetDir: `${h.copyRoot}${WINDOWS ? '\\' : '/'}0.19.0${WINDOWS ? '\\' : '/'}..${WINDOWS ? '\\' : '/'}${TARGET_VERSION}`
        }
      ],
      [
        'relative',
        { targetVersion: TARGET_VERSION, targetDir: join('DwarfAI', 'host', TARGET_VERSION) }
      ],
      [
        'a symlink out of the root',
        { targetVersion: linkedVersion, targetDir: join(h.copyRoot, linkedVersion) }
      ],
      [
        'not named for targetVersion',
        { targetVersion: TARGET_VERSION, targetDir: join(h.copyRoot, '0.19.0') }
      ],
      ['the root itself', { targetVersion: 'host', targetDir: h.copyRoot }],
      ['a missing folder', { targetVersion: '0.23.0', targetDir: join(h.copyRoot, '0.23.0') }]
    ]
    let id = 0
    for (const [label, params] of refused) {
      id += 1
      const res = await h.call(
        ui,
        'host.upgrade.request',
        { ...params, requestId: REQUEST_ID },
        `r${id}`
      )
      expect(res, label).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS', retryable: false }
      })
    }

    expect(h.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
    expect(evts(ui)).toEqual([])
    expect(h.exits).toEqual([])
    expect([snapshotTree(h.root), snapshotTree(outside)]).toEqual(before)
    expect(h.log.byEvent('host.upgrade')).toEqual([])
  })

  it('[ADR-002, S12.14, S12.16] with nothing open the Host drains at once, sends host.closing upgrade and exits', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    ui.send({
      type: 'req',
      id: 'r1',
      method: 'host.upgrade.request',
      params: { targetVersion: TARGET_VERSION, targetDir: h.targetDir, requestId: REQUEST_ID }
    })
    await ui.until(() => h.exits.length > 0)
    await h.settle(ui)

    expect(resOf(ui, 'r1')).toMatchObject({ ok: true, result: { state: 'upgrade-pending' } })
    // 14 §1.7: host.state, then the `res`, then the drain: the session references checkpointed,
    // the clean-shutdown marker `upgrade`, host.closing on ui and notifier, the close and exit 0.
    expect(h.journal).toEqual([
      'ui:host.state',
      'ui:res',
      'sessions.checkpoint',
      'checkpoint.flush',
      'checkpoint.markClean:upgrade',
      'ui:host.closing',
      'notifier:host.closing',
      'ui:closed',
      'notifier:closed',
      'endpoint.close',
      'exit:0'
    ])
    expect(evts(ui)).toEqual([PENDING_FRAME, UPGRADE_CLOSING])
    expect(evts(notifier)).toEqual([UPGRADE_CLOSING])
    // No owned session is ended by a drain: the StopAllPort is never asked (ADR-002 D8).
    expect(h.stopAll.calls).toEqual([])
    expect(h.log.byEvent('host.exit')).toEqual([expect.objectContaining({ causeClass: 'upgrade' })])
  })

  it('[ADR-002, S12.15, FM-024] with a DrainGate blocker the Host stays upgrade-pending until the blocker clears', async () => {
    const gate = new FakeDrainGate([{ kind: 'non-resumable-session', dwarfId: SESSION_DWARF }])
    const h = await host({ gate })
    const ui = await h.attach('ui')

    await h.call(ui, 'host.upgrade.request', {
      targetVersion: TARGET_VERSION,
      targetDir: h.targetDir,
      requestId: REQUEST_ID
    })
    await h.settle(ui)
    // Held: re-checked on each tick, nothing is ended, nothing closes, and the Host keeps serving.
    for (let tick = 0; tick < 3; tick += 1) {
      h.clock.advance(DRAIN_RECHECK_MS)
      await h.settle(ui)
    }
    const ping = await h.call(ui, 'ping', {}, 'p1')

    expect(ping).toMatchObject({ ok: true })
    expect(h.state.current()).toEqual({ state: 'upgrade-pending', jobStatus: 'n/a' })
    expect(h.gate.reads).toBeGreaterThanOrEqual(4)
    expect(h.stopAll.calls).toEqual([])
    expect(h.checkpoint.calls).toEqual([])
    expect(h.exits).toEqual([])
    expect(ui.closed).toBe(false)
    expect(evts(ui)).toEqual([PENDING_FRAME])
    expect(h.log.byEvent('host.upgrade')).toContainEqual(
      expect.objectContaining({ causeClass: 'drain-blocked', count: 1 })
    )

    // The non-resumable session ended by itself: the next check drains.
    gate.clear()
    h.clock.advance(DRAIN_RECHECK_MS)
    await h.settle(ui)

    expect(evts(ui)).toEqual([PENDING_FRAME, UPGRADE_CLOSING])
    expect(h.checkpoint.calls).toEqual([
      { kind: 'flush' },
      { kind: 'markClean', reason: 'upgrade' }
    ])
    expect(h.exits).toEqual([0])
    expect(h.stopAll.calls).toEqual([])
  })

  it('[ADR-002] host.shutdown upgrade-drain is answered accepted at acceptance, then the same drain follows', async () => {
    const gate = new FakeDrainGate([{ kind: 'open-ask', dwarfId: SESSION_DWARF }])
    const h = await host({ gate })
    const ui = await h.attach('ui')

    // Answered while the gate still holds the drain: at acceptance (14 §1.7).
    const res = await h.call(ui, 'host.shutdown', { mode: 'upgrade-drain', requestId: REQUEST_ID })
    // A second request, of either kind, joins the same drain.
    const again = await h.call(
      ui,
      'host.upgrade.request',
      { targetVersion: TARGET_VERSION, targetDir: h.targetDir, requestId: OTHER_REQUEST_ID },
      'r2'
    )

    expect(res).toEqual({
      type: 'res',
      id: 'r1',
      ok: true,
      result: { mode: 'upgrade-drain', accepted: true }
    })
    expect(again).toMatchObject({ ok: true, result: { state: 'upgrade-pending' } })
    expect(h.state.current()).toEqual({ state: 'upgrade-pending', jobStatus: 'n/a' })
    expect(evts(ui)).toEqual([PENDING_FRAME])
    expect(h.exits).toEqual([])

    gate.clear()
    h.clock.advance(DRAIN_RECHECK_MS)
    await h.settle(ui)

    expect(evts(ui)).toEqual([PENDING_FRAME, UPGRADE_CLOSING])
    expect(h.checkpoint.calls).toEqual([
      { kind: 'flush' },
      { kind: 'markClean', reason: 'upgrade' }
    ])
    expect(h.exits).toEqual([0])
    // upgrade-drain is never a stop-all: no owned session is ended (ADR-002 D8 item 4).
    expect(h.stopAll.calls).toEqual([])
  })

  it('[ADR-002] a notifier sending host.upgrade.request gets FORBIDDEN', async () => {
    const h = await host()
    const notifier = await h.attach('notifier')

    const res = await h.call(notifier, 'host.upgrade.request', {
      targetVersion: TARGET_VERSION,
      targetDir: h.targetDir,
      requestId: REQUEST_ID
    })

    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', retryable: false } })
    expect(h.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
    expect(evts(notifier)).toEqual([])
    expect(h.exits).toEqual([])
    expect(h.log.byEvent('channel.forbidden')).toEqual([
      expect.objectContaining({ level: 'error', method: 'host.upgrade.request', role: 'notifier' })
    ])
  })
})
