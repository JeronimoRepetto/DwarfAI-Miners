// `run/host.identity` (ADR-002 D3, D7, D9): the Host's process identity plus its epoch, written right
// after the endpoint bind and before any `hello` is answered, deleted at the clean exit. The real
// seam-B transport runs behind an in-process duplex; the file store and the process identity are
// faked (17 §2.2).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_IDENTITY_FILE, hostIdentityRecordSchema, PROTOCOL_VERSION } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { HelloThrottle } from '../auth/throttle'
import { UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { createCleanExit } from '../lifecycle/cleanExit'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { deferUntilPublished, HostIdentityFile, type RunFileWriter } from './hostIdentityFile'
import { NodeRunFileWriter } from './nodeRunFileWriter'

const RUN_DIR = '/home/j/.config/DwarfAI-Miners/host/run'
const IDENTITY_PATH = join(RUN_DIR, HOST_IDENTITY_FILE)
const SELF = { pid: 4242, processStartTimeMs: 1_727_740_800_123, bootId: 'boot-0001' }
const EPOCH = '01890a5d-ac96-774b-bcce-b302099a8057'

/** The run-file store double: files in memory, every write and removal journaled. */
class InMemoryRunFiles implements RunFileWriter {
  readonly files = new Map<string, string>()
  readonly journal: string[] = []
  onWrite: () => void = () => {}

  writeAtomic(path: string, text: string): Promise<void> {
    this.onWrite()
    this.files.set(path, text)
    this.journal.push(`write ${path}`)
    return Promise.resolve()
  }

  remove(path: string): Promise<void> {
    this.files.delete(path)
    this.journal.push(`remove ${path}`)
    return Promise.resolve()
  }
}

function identityFile(files: InMemoryRunFiles, processes = new FakeProcessControl()) {
  processes.script(SELF.pid, SELF)
  return new HostIdentityFile({
    runDir: RUN_DIR,
    writer: files,
    processes,
    pid: SELF.pid,
    epoch: EPOCH
  })
}

/** The Host's real transport for one connection, with faked modules. */
function transport() {
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  const deps = {
    token: new UiToken(),
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '1.4.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch: EPOCH,
    state: () => state.current(),
    capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
    scheduler,
    clock,
    log,
    dispatcher,
    connections,
    throttle: new HelloThrottle(clock)
  }
  return { deps, scheduler, log, connections }
}

const HELLO = {
  type: 'hello',
  endpointGeneration: 1,
  protocolVersion: PROTOCOL_VERSION,
  role: 'ui',
  token: 'f00d'.repeat(16),
  client: { appVersion: '1.4.0', buildId: 'abc1234', pid: 77 }
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('run/host.identity (ADR-002 D3)', () => {
  it('[ADR-002] host.identity is written after the bind and before any hello is answered, with pid, processStartTimeMs, bootId and epoch', async () => {
    const files = new InMemoryRunFiles()
    const file = identityFile(files)
    const { deps } = transport()
    // The endpoint is bound: connections are accepted from here on, held until the run files exist.
    let publish: () => void = () => {}
    const published = new Promise<void>((resolve) => (publish = resolve))
    const accept = deferUntilPublished(
      published,
      (stream: ReturnType<typeof inProcessDuplex>['host']) => acceptConnection(stream, deps)
    )
    const pair = inProcessDuplex()
    accept(pair.host)
    const client = new FrameClient(pair.client)
    client.send(HELLO)
    await client.settle()
    expect(client.frames, 'no hello is answered before host.identity exists').toEqual([])

    let framesWhenWritten = -1
    files.onWrite = () => (framesWhenWritten = client.frames.length)
    expect(await file.publish()).toBe('written')
    publish()
    await client.until(() => client.frames.length > 0)

    expect(framesWhenWritten, 'written before the first answer').toBe(0)
    const written = JSON.parse(files.files.get(IDENTITY_PATH) ?? 'null') as unknown
    expect(hostIdentityRecordSchema.parse(written)).toEqual({ ...SELF, epoch: EPOCH })
    expect(files.journal).toEqual([`write ${IDENTITY_PATH}`])
  })

  it('[ADR-002] a connection accepted while the run files cannot be written is closed unanswered', async () => {
    const { deps } = transport()
    let refuse: (error: Error) => void = () => {}
    const published = new Promise<void>((_resolve, reject) => (refuse = reject))
    const accept = deferUntilPublished(
      published,
      (stream: ReturnType<typeof inProcessDuplex>['host']) => acceptConnection(stream, deps)
    )
    const pair = inProcessDuplex()
    accept(pair.host)
    const client = new FrameClient(pair.client)
    client.send(HELLO)

    refuse(new Error('run folder unwritable'))
    await client.until(() => client.closed)
    expect(client.frames).toEqual([])
  })

  it('[ADR-002] a clean exit deletes host.identity', async () => {
    const files = new InMemoryRunFiles()
    const file = identityFile(files)
    await file.publish()
    const { scheduler, log, connections } = transport()
    const journal: string[] = []
    const exits: number[] = []
    const exit = createCleanExit({
      checkpoint: new RecordingShutdownCheckpoint(journal),
      connections,
      endpoint: {
        close: () => {
          journal.push('endpoint.close')
          return Promise.resolve()
        }
      },
      identityFile: {
        remove: async () => {
          await file.remove()
          journal.push('host.identity removed')
        }
      },
      scheduler,
      log,
      exit: (code) => {
        journal.push(`exit ${code}`)
        exits.push(code)
      }
    })

    await exit.closeCleanly('stop-all')

    expect(files.files.has(IDENTITY_PATH)).toBe(false)
    expect(journal.slice(-3)).toEqual(['endpoint.close', 'host.identity removed', 'exit 0'])
  })

  it('[ADR-002, INV-51] a Host that cannot read its own identity writes no host.identity, and a stale one is removed', async () => {
    const files = new InMemoryRunFiles()
    files.files.set(IDENTITY_PATH, '{"pid":1}')
    const processes = new FakeProcessControl()
    const file = identityFile(files, processes)
    processes.script(SELF.pid, 'unknown')

    expect(await file.publish()).toBe('identity-unreadable')

    expect(files.files.has(IDENTITY_PATH)).toBe(false)
    expect(files.journal).toEqual([`remove ${IDENTITY_PATH}`])
  })

  it('[ADR-002] the Node writer replaces the file in one step: complete content, the run folder created, no temporary file left', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-031-runfiles-'))
    dirs.push(root)
    const runDir = join(root, 'run')
    const target = join(runDir, HOST_IDENTITY_FILE)
    const writer = new NodeRunFileWriter()

    await writer.writeAtomic(target, '{"first":true}')
    writeFileSync(join(runDir, 'other'), 'kept')
    await writer.writeAtomic(target, '{"second":true}')

    expect(readFileSync(target, 'utf8')).toBe('{"second":true}')
    expect(readdirSync(runDir).sort()).toEqual([HOST_IDENTITY_FILE, 'other'])
    await writer.remove(target)
    await writer.remove(target)
    expect(readdirSync(runDir)).toEqual(['other'])
  })
})
