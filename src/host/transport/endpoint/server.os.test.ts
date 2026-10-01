// L8 OS lane (17 §1.8): the real modes of the Host's UI endpoint on this OS. Runs only in
// `pnpm test:os`.
//
// Windows: the ADR-003 security test, spike SP-05 turned into a test (17 §1.8; ADR-003
// Verification). The Host's real endpoint is bound through the native owner-only pipe helper (built
// by `pnpm build:native`); Windows' own access check then says what another local user, anonymous
// and remote clients would be granted on that pipe (SP-05's method: synthesized principals, so the
// runner needs no second account), and a real remote client is tried through the SMB loopback. The
// run with a real second account and a real second machine is the owner's manual step in
// spike-results/SP-05.md.
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { createNativeOwnerOnlyPipe } from '../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import {
  createPipeAccessProbe,
  WELL_KNOWN_SID,
  type PipeAccessProbe
} from '../../platform/endpoint/win-pipe/testing/pipeAccessProbe'
import { decideBind } from '../../wiring/singleInstance'
import { bindEndpoint } from './server'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe.runIf(process.platform !== 'win32')('the UI endpoint on POSIX', () => {
  it('[ADR-003] the socket is 0600 and its run directory 0700', async () => {
    // Directly under /tmp: the socket paths must fit `sun_path` (104 bytes on macOS), and the
    // macOS runner's os.tmpdir() (`/var/folders/<2>/<30>/T`) leaves too little room for them.
    const root = mkdtempSync('/tmp/dw022-')
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'run')
    // A run directory left wider by someone else is narrowed, not trusted.
    mkdirSync(dir, { mode: 0o755 })
    const path = join(dir, 'host-0123456789ab.sock')

    const outcome = await bindEndpoint(
      { kind: 'unix-socket', dir, path },
      {
        log: new RecordingDiagnosticsLog(),
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        decide: decideBind,
        probeExisting: () => Promise.resolve('no-hello')
      }
    )
    if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
    cleanups.push(() => outcome.endpoint.close())

    expect(lstatSync(path).isSocket()).toBe(true)
    expect((lstatSync(path).mode & 0o777).toString(8)).toBe('600')
    expect((lstatSync(dir).mode & 0o777).toString(8)).toBe('700')

    // A run directory the Host creates itself, with its missing parents, is 0700 too.
    const fresh = join(root, 'fresh', 'run')
    const second = await bindEndpoint(
      { kind: 'unix-socket', dir: fresh, path: join(fresh, 'host-0123456789ab.sock') },
      {
        log: new RecordingDiagnosticsLog(),
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        decide: decideBind,
        probeExisting: () => Promise.resolve('no-hello')
      }
    )
    if (second.kind !== 'bound') throw new Error(`expected a bind, got ${second.kind}`)
    cleanups.push(() => second.endpoint.close())
    expect((lstatSync(fresh).mode & 0o777).toString(8)).toBe('700')
  })
})

/** FILE_READ_DATA | FILE_WRITE_DATA: reading and writing the pipe. */
const READ_WRITE_DATA = 0x3
/** FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA (FILE_CREATE_PIPE_INSTANCE on a pipe). */
const DATA_RIGHTS = 0x7
/** READ_CONTROL | WRITE_DAC, which Windows grants an object's owner before it reads the DACL. */
const OWNER_IMPLICIT = 0x00060000
/** GENERIC_READ | GENERIC_WRITE, what a client asks for. */
const GENERIC_READ_WRITE = 0xc0000000
const ERROR_ACCESS_DENIED = 'error 5'
const hex = (mask: number): string => `0x${(mask >>> 0).toString(16).padStart(8, '0')}`

describe.runIf(process.platform === 'win32')('the UI endpoint on Windows', () => {
  let probe: PipeAccessProbe
  beforeAll(async () => {
    probe = await createPipeAccessProbe()
  }, 180_000)
  afterAll(() => probe?.dispose())

  it('[ADR-003, SP-05, FM-036] a second local user account cannot open the pipe and \\\\<machine>\\pipe\\… from another host is refused', async () => {
    const name = `dwarfai-test-022s-${randomBytes(8).toString('hex')}`
    const path = `\\\\.\\pipe\\${name}`
    const log = new RecordingDiagnosticsLog()
    const outcome = await bindEndpoint(
      { kind: 'named-pipe', path },
      {
        log,
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        decide: decideBind,
        probeExisting: () => Promise.resolve('no-hello'),
        ownerOnlyPipe: createNativeOwnerOnlyPipe({
          prebuildsDir: fileURLToPath(new URL('../../../../prebuilds', import.meta.url))
        })
      }
    )
    if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
    cleanups.push(() => outcome.endpoint.close())

    // The owner reaches it, and receives nothing before authentication.
    const owner = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(path)
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    cleanups.push(() => void owner.destroy())
    let received = 0
    owner.on('data', (chunk: Buffer) => (received += chunk.length))

    // The protected DACL of ADR-003 item 2: NETWORK denied, then only the owner and SYSTEM.
    const report = await probe.check(path)
    expect(report.protectedDacl, 'the DACL is protected (nothing inherited)').toBe(true)
    expect(report.aces.map(({ type, sid }) => `${type} ${sid}`)).toEqual([
      `D ${WELL_KNOWN_SID.network}`,
      `A ${probe.ownerSid}`,
      `A ${WELL_KNOWN_SID.system}`
    ])
    expect(hex(report.granted.owner & READ_WRITE_DATA), 'the owner reads and writes').toBe(
      hex(READ_WRITE_DATA)
    )
    expect(hex(report.granted.otherUser), 'another local user is granted nothing').toBe(hex(0))
    expect(hex(report.granted.anonymous), 'anonymous is granted nothing').toBe(hex(0))
    expect(hex(report.granted.remoteOtherUser), 'a remote client of another user').toBe(hex(0))
    // Windows grants an object's owner READ_CONTROL | WRITE_DAC before any entry is read, so the
    // deny-NETWORK entry leaves the owner's remote logon those two and no data right (SP-05).
    expect(hex(report.granted.remoteOwner & DATA_RIGHTS), 'a remote client of the owner').toBe(
      hex(0)
    )
    expect(hex(report.granted.remoteOwner & ~OWNER_IMPLICIT), 'nothing beyond owner rights').toBe(
      hex(0)
    )

    // PIPE_REJECT_REMOTE_CLIENTS: a real remote client, through the SMB loopback, is refused
    // before any access check, while a local open of the same pipe succeeds.
    for (const machine of ['127.0.0.1', 'localhost']) {
      expect(
        await probe.open(`\\\\${machine}\\pipe\\${name}`, GENERIC_READ_WRITE),
        `\\\\${machine}\\pipe\\…`
      ).toBe(ERROR_ACCESS_DENIED)
    }
    expect(await probe.open(path, GENERIC_READ_WRITE), 'a local open by the owner').toBe('ok')

    expect(received, 'no byte before authentication').toBe(0)
    expect(log.byEvent('host.endpoint.acl'), 'no degraded ACL record').toEqual([])
  }, 120_000)
})
