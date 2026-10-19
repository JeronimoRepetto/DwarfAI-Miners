// L8 OS lane (17 §1.8): the tray notifier connection over this OS's real UI endpoint (ISSUE-022) —
// a named pipe on Windows, a Unix socket elsewhere. `TransportLevel3Sink` frames
// `attention.notify` and `attention.withdraw` to the `notifier` connection only, in order
// (ADR-003 item 12; ADR-018 items 4–5; 14 B-F22, B-F23). Runs only in `pnpm test:os`. Whether a
// windowless tray process can draw the notification (S-018-1) is the UI side's (ISSUE-113).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSocketPathLength, PROTOCOL_VERSION, type HostEndpoint } from '@dwarfai/contracts'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { createNativeOwnerOnlyPipe } from '../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { decideBind } from '../../wiring/singleInstance'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { bindEndpoint } from '../endpoint/server'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { TransportLevel3Sink } from './TransportLevel3Sink'

const WINDOWS = process.platform === 'win32'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-112-os-')) : mkdtempSync('/tmp/dw112-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function endpointUnder(root: string): HostEndpoint {
  if (WINDOWS) {
    const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-112-${suffix}` }
  }
  const dir = join(root, 'run')
  const path = join(dir, 'host-0123456789ab.sock')
  const fits = checkSocketPathLength(process.platform === 'darwin' ? 'darwin' : 'linux', path)
  if (!fits.ok) throw new Error(`test socket path too long for this OS: ${JSON.stringify(fits)}`)
  return { kind: 'unix-socket', dir, path }
}

const scheduler = (): NodeScheduler => new NodeScheduler({ onTaskError: () => {} })

/** Binds `endpoint` with the auth layer attaching each connection to `connections`. */
async function bind(endpoint: HostEndpoint, connections: ConnectionRegistry, runDir: string) {
  const clock = new FakeClock(1_000)
  const log = new RecordingDiagnosticsLog()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const token = new UiToken()
  const outcome = await bindEndpoint(endpoint, {
    log,
    scheduler: scheduler(),
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    // AMENDED for the ISSUE-022 Windows half (was: no helper): a named pipe is created only by
    // the native owner-only pipe helper (built by `pnpm build:native`); a Unix socket ignores it.
    ownerOnlyPipe: createNativeOwnerOnlyPipe({
      prebuildsDir: fileURLToPath(new URL('../../../../prebuilds', import.meta.url))
    }),
    accept: (connection) =>
      acceptConnection(connection, {
        token,
        ids: new SequenceIdGenerator(),
        identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
        epoch: 'epoch-112',
        state: () => state.current(),
        capabilities: () => [],
        scheduler: scheduler(),
        clock,
        log,
        dispatcher: new Dispatcher({
          log,
          clock,
          scheduler: new FakeScheduler(clock),
          state: () => state.current().state
        }),
        connections,
        throttle: new HelloThrottle(clock)
      })
  })
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  await token.issue(runDir)
  return { endpoint: outcome.endpoint, token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8') }
}

/** Connects with `role` over the real endpoint and waits for hello.ok. */
async function attach(path: string, token: string, role: 'ui' | 'notifier'): Promise<FrameClient> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  cleanups.push(() => void socket.destroy())
  const client = new FrameClient(socket)
  client.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role,
    token,
    client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
  })
  await client.until(() => client.frames.length > 0)
  expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
  return client
}

const MINE = '01890a5d-ac96-774b-bcce-b302099a8112' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad112' as DwarfId

function notification(askId: string) {
  return {
    key: `${DWARF}:question:${askId}`,
    kind: 'question' as const,
    title: 'Canary-Dwarf-7f3e question',
    body: 'Canary-Mine-b41c',
    mineId: MINE,
    dwarfId: DWARF,
    sensitive: true as const
  }
}

/** The `evt` frames a client received, as `[name, data]`. */
function events(client: FrameClient): Array<[string, unknown]> {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => {
      const evt = frame as { name: string; data: unknown }
      return [evt.name, evt.data]
    })
}

/** Two notifications and a withdrawal reach the notifier in order, and nothing reaches the ui. */
async function notifyAndWithdrawInOrder(): Promise<void> {
  const root = caseRoot()
  const endpoint = endpointUnder(root)
  const connections = new ConnectionRegistry()
  const bound = await bind(endpoint, connections, join(root, 'run'))
  cleanups.push(() => bound.endpoint.close())
  const ui = await attach(endpoint.path, bound.token, 'ui')
  const notifier = await attach(endpoint.path, bound.token, 'notifier')
  const sink = new TransportLevel3Sink(connections)

  expect(sink.notify(notification('ask-1'))).toBe('delivered')
  expect(sink.notify(notification('ask-2'))).toBe('delivered')
  sink.withdraw([notification('ask-1').key])
  await notifier.until(() => events(notifier).length === 3)

  expect(events(notifier)).toStrictEqual([
    ['attention.notify', notification('ask-1')],
    ['attention.notify', notification('ask-2')],
    ['attention.withdraw', { keys: [notification('ask-1').key] }]
  ])
  const seqs = notifier.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => (frame as { seq: number }).seq)
  expect(seqs).toStrictEqual([1, 2, 3])
  // Give the ui connection the same chance to receive anything: it receives nothing.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(events(ui)).toStrictEqual([])
}

describe.runIf(WINDOWS)('the notifier connection over a named pipe', () => {
  it(
    '[ADR-018] over the real pipe or socket a notifier client receives attention.notify and attention.withdraw in order',
    notifyAndWithdrawInOrder
  )
})

describe.runIf(!WINDOWS)('the notifier connection over a Unix socket', () => {
  it(
    '[ADR-018] over the real pipe or socket a notifier client receives attention.notify and attention.withdraw in order',
    notifyAndWithdrawInOrder
  )
})
