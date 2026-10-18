import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { release } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../src/host/kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../../src/host/platform/clock/NodeScheduler'
import { bindEndpoint, type BoundEndpoint } from '../../src/host/transport/endpoint/server'
import { NodeRunFileWriter } from '../../src/host/transport/runFiles/nodeRunFileWriter'
import { decideBind } from '../../src/host/wiring/singleInstance'

/**
 * Spike SP-05, macOS and Linux leg, L8 (testing strategy `17` §4; ADR-003 items 1 and 3; spike register SP-05).
 *
 * Question: on macOS and Linux, can another local account open the Host's socket or read its run files? ADR-003 puts
 * the socket (`0600`) in an owner-only run directory (`0700`) and writes the run files `0600`. The modes alone are
 * `server.os.test.ts`'s; this harness asks the OS what a real second principal gets.
 *
 * The objects are the production ones: the Host's endpoint bound by `bindEndpoint` (a `unix-socket`) and a run file
 * written by `NodeRunFileWriter`, under a fresh root in `/tmp` opened to everyone (`0755`), so that only the run
 * directory and the files' own modes can refuse. The second principal is the `nobody` account, reached through
 * `sudo -n -u nobody` (the CI runners' passwordless sudo; `-n` never prompts, so without it the cases are skipped).
 * `nobody` reads with `/bin/cat`, lists with `/bin/ls` and connects with `python3`'s `socket` module; a control file
 * and a control socket opened to everyone prove each tool reaches what the modes allow.
 *
 * Set `SPIKE_REPORT_DIR=<dir>` (writes `<dir>/SP-05-<platform>-posix.json`) or `SP05_POSIX_REPORT=<file>` to write the
 * observations (the record's raw output). The report holds modes, exit codes and the first line of each error.
 */

interface Attempt {
  readonly what: string
  readonly exitCode: number | null
  readonly firstLine: string
}

const SUDO_TIMEOUT_MS = 20_000
const CONNECT =
  'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.settimeout(5)\ns.connect(sys.argv[1])\nprint("connected")'

function tool(name: string): string | null {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() || null : null
}

function sudoNobodyWorks(): boolean {
  if (process.platform === 'win32') return false
  return (
    spawnSync('sudo', ['-n', '-u', 'nobody', '/usr/bin/true'], { timeout: SUDO_TIMEOUT_MS })
      .status === 0
  )
}

const python = process.platform === 'win32' ? null : tool('python3')
const runnable = python !== null && sudoNobodyWorks()

const attempts: Attempt[] = []
const modes: Record<string, string> = {}
const cleanups: (() => Promise<void> | void)[] = []
let root = ''
let runDir = ''
let socketPath = ''
let runFile = ''
let controlFile = ''
let controlSocket = ''

function asNobody(what: string, args: readonly string[]): Attempt {
  const result = spawnSync('sudo', ['-n', '-u', 'nobody', ...args], {
    cwd: '/',
    encoding: 'utf8',
    timeout: SUDO_TIMEOUT_MS
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const attempt = {
    what,
    exitCode: result.status,
    firstLine: (text.split('\n').find((line) => line.trim() !== '') ?? '').slice(0, 200)
  }
  attempts.push(attempt)
  return attempt
}

const modeOf = (file: string): string => (lstatSync(file).mode & 0o777).toString(8)

function scrub(text: string): string {
  return root === '' ? text : text.split(root).join('<root>')
}

describe.runIf(runnable)(
  'SP-05 on POSIX: what another local account gets (ADR-003 items 1 and 3)',
  () => {
    let endpoint: BoundEndpoint
    let control: Server

    beforeAll(async () => {
      // Directly under /tmp, as server.os.test.ts: the socket path must fit `sun_path` (104 bytes on macOS).
      root = mkdtempSync('/tmp/dwsp05-')
      chmodSync(root, 0o755)
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      runDir = path.join(root, 'run')
      socketPath = path.join(runDir, 'host-0123456789ab.sock')

      const outcome = await bindEndpoint(
        { kind: 'unix-socket', dir: runDir, path: socketPath },
        {
          log: new RecordingDiagnosticsLog(),
          scheduler: new NodeScheduler({ onTaskError: () => {} }),
          decide: decideBind,
          probeExisting: () => Promise.resolve('no-hello')
        }
      )
      if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
      endpoint = outcome.endpoint
      cleanups.push(() => endpoint.close())

      runFile = path.join(runDir, 'host.identity')
      await new NodeRunFileWriter().writeAtomic(runFile, '{"probe":"sp05"}\n')

      // The controls: what the modes allow must be reachable, or a refusal proves nothing.
      controlFile = path.join(root, 'control.txt')
      writeFileSync(controlFile, 'control\n', { mode: 0o644 })
      chmodSync(controlFile, 0o644)
      controlSocket = path.join(root, 'control.sock')
      control = createServer((connection) => connection.end())
      await new Promise<void>((resolve) => control.listen(controlSocket, resolve))
      chmodSync(controlSocket, 0o777)
      cleanups.push(() => new Promise<void>((resolve) => control.close(() => resolve())))

      for (const [label, file] of [
        ['root', root],
        ['runDir', runDir],
        ['socket', socketPath],
        ['runFile', runFile],
        ['controlFile', controlFile],
        ['controlSocket', controlSocket]
      ] as const) {
        modes[label] = modeOf(file)
      }
    }, 60_000)

    afterAll(async () => {
      const file =
        process.env['SP05_POSIX_REPORT'] ??
        (process.env['SPIKE_REPORT_DIR']
          ? path.resolve(process.env['SPIKE_REPORT_DIR'], `SP-05-${process.platform}-posix.json`)
          : null)
      if (file) {
        mkdirSync(path.dirname(file), { recursive: true })
        const umask = execFileSync('/bin/sh', ['-c', 'umask'], { encoding: 'utf8' }).trim()
        const report = {
          spike: 'SP-05',
          platform: process.platform,
          osRelease: release(),
          principal: 'nobody (sudo -n -u nobody)',
          umask,
          modes,
          attempts
        }
        writeFileSync(file, `${scrub(JSON.stringify(report, null, 2))}\n`)
      }
      for (const cleanup of cleanups.reverse()) await cleanup()
    }, 60_000)

    it('[SP-05, ADR-003] the run directory is 0700, the socket and the run file 0600, as bound and written by the Host code', () => {
      expect(modes).toMatchObject({ runDir: '700', socket: '600', runFile: '600' })
    })

    it('[SP-05] the controls opened to everyone are reachable by nobody, so a refusal below is the modes', () => {
      expect(asNobody('control: cat a 0644 file', ['/bin/cat', controlFile]).exitCode).toBe(0)
      const connected = asNobody('control: connect a 0777 socket', [
        python ?? 'python3',
        '-c',
        CONNECT,
        controlSocket
      ])
      expect(connected.exitCode, connected.firstLine).toBe(0)
    })

    it('[SP-05, ADR-003, FM-036] another local account can neither connect to the Host socket nor read or list its run files', () => {
      const connect = asNobody('connect the Host socket', [
        python ?? 'python3',
        '-c',
        CONNECT,
        socketPath
      ])
      expect(connect.exitCode, `nobody connected: ${connect.firstLine}`).not.toBe(0)
      expect(connect.firstLine).not.toBe('connected')

      const read = asNobody('cat run/host.identity', ['/bin/cat', runFile])
      expect(read.exitCode, `nobody read the run file: ${read.firstLine}`).not.toBe(0)

      const list = asNobody('ls the run directory', ['/bin/ls', runDir])
      expect(list.exitCode, `nobody listed the run directory: ${list.firstLine}`).not.toBe(0)
    })
  }
)
