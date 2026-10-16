// The `dwarfai-mcp` relay (ADR-013 items 2–3, frozen; 16 §5.2 items 2–4; 15 §4 "Delegation relay
// form"; UC-017 steps 1–3): the stdio MCP server a delegating provider session starts from the relay
// entry (relayEntry.ts), `{ command: <versioned-copy executable>, args: [<this script>], env: {
// ELECTRON_RUN_AS_NODE: '1', DWARFAI_MCP_CREDENTIAL_FILE: <path> } }`. electron.vite.relay.config.ts
// emits it as `out/host/dwarfai-mcp.js`, beside the Host entry. This file is that process's entry:
// it starts itself when it runs as the built script, and nothing but its own tests imports it
// (.dependency-cruiser.cjs R6-relay-entry-not-imported); what the Host needs lives in relayEntry.ts.
//
// 1. The relay learns only the credential FILE PATH. The path must be
//    `<hostDataDir>/run/mcp/<launchId>.cred` (RunDirCredentialFileStore's layout): the launchId is
//    the file's name and nothing else, and hostDataDir is the folder three levels up. Any other path
//    is refused before anything is read or connected.
// 2. It reads at most MAX_CREDENTIAL_FILE_BYTES of the file, which must hold exactly the credential
//    (32 bytes as 64 lower-case hex), computes the MCP endpoint's path from hostDataDir (ADR-013
//    item 3 through `mcpEndpointFor`, the ADR-002 D2 rule of contracts/host-protocol/endpoint.ts),
//    connects, and writes `McpHello {type:'hello', endpointGeneration:1, protocolVersion,
//    role:'mcp', launchId, credential}` as its first bytes. It waits HELLO_OK_WAIT_MS for
//    `hello.ok`; nothing from stdin is read before it.
// 3. After `hello.ok` it moves newline-delimited JSON-RPC between its stdio and the endpoint: one
//    stdin line → one ADR-003 item 4 frame, one frame → one stdout line, the message's bytes
//    unchanged (an id above 2^53, `1.0`, spacing). It parses a message only to check that it is one
//    JSON-RPC object or batch array, and nothing else of it (16 §5.2 item 4). A frame that is not one
//    (the Host's one error frame before it closes) never reaches stdout. Each side's `write()`
//    answer is respected: a full side pauses the other until it drains. A stdin line or a frame
//    over the 8 MiB frame cap (ADR-003 item 4) ends the relay.
// 4. It exits when either side closes: 0 for a close (stdin's end first flushes the connection),
//    non-zero for a failure (FM-039: AUTH_FAILED, a missing or unreadable file, an endpoint it cannot
//    resolve or reach or that fails, no `hello.ok` in time, a malformed or oversize message, a
//    stdout that fails). A failure writes one `shim-` segment line (19 §2: on error only,
//    `proc: 'shim'`, subsystem `mcp-relay`) through contracts/logging's pure rules, into
//    `<hostDataDir>/../logs` (ADR-026 item 1); never the credential, never a message (ADR-013
//    item 2, C-16; ADR-026 items 3–5). stdout carries MCP only; nothing is written to stderr.
//
// The credential lives in this process alone (ADR-013 item 2's one exception): it is never in an
// argv, an environment, stdout or a log. The relay starts no process (no `node:child_process`): on
// Windows the user SID of the endpoint's name is read natively (nativeUserSid.ts).
//
// The frames are read and written here as bytes (uint32 LE length + the UTF-8 JSON, ADR-003 item 4,
// with the contracts caps), because the contracts codec turns a frame into a parsed value and back,
// which would change a message's bytes.
//
// Linux risk (lead decision 2026-10-15, spike item): a provider that does not pass XDG_RUNTIME_DIR
// to its stdio MCP servers makes the relay name the fallback socket while the Host bound the XDG
// one; the relay then fails closed with `endpoint-unreachable`.
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { McpHello } from '../../../../../../contracts/host-protocol/adr-003'
import {
  encodeFrame,
  FRAME_CAP_AFTER_HELLO_OK,
  FRAME_CAP_BEFORE_HELLO_OK
} from '../../../../../../contracts/host-protocol/frameCodec'
import { PROTOCOL_VERSION } from '../../../../../../contracts/host-protocol/protocolVersion'
import {
  LOG_CAP_BYTES,
  LOG_SEGMENT_BYTES,
  nextSeq,
  parseSegmentName,
  planPrune,
  segmentName,
  toLogLine,
  type LogRecord,
  type SegmentInfo
} from '../../../../../../contracts/logging'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { NodeScheduler } from '../../../../../platform/clock/NodeScheduler'
import { winPipePrebuildsDir } from '../../../../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { createNativeUserSid } from '../../../../../platform/endpoint/win-pipe/nativeUserSid'
import { createNodeEndpointFacts } from '../../../../../platform/endpoint/nodeEndpointEnv'
import type { ReadOutcome } from '../../../../../platform/process/probe/types'
import { mcpEndpointFor } from '../../../../../transport/mcpEndpoint/mcpEndpointPath'
import { CREDENTIAL_FILE_VARIABLE, RELAY_ENTRY_FILE } from './relayEntry'

/**
 * How long the relay waits for `hello.ok` after its McpHello: the ADR-003 item 5 hello budget (5 s,
 * the Host's own HELLO_TIMEOUT_MS). A Host that does not answer in it ends the relay.
 */
export const HELLO_OK_WAIT_MS = 5_000
/** The most of the credential file the relay reads: a credential is 64 bytes, nothing else fits. */
export const MAX_CREDENTIAL_FILE_BYTES = 256

const CREDENTIAL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cred$/
const CREDENTIAL = /^[0-9a-f]{64}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ERRNO = /^E[A-Z0-9_]+$/
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d
const LINE_END = Buffer.from([NEWLINE])
const PREFIX_BYTES = 4

export interface RelayDeps {
  env: Readonly<Record<string, string | undefined>>
  /** Reads at most `maxBytes` (plus one, to tell a longer file) of the credential file as UTF-8. */
  readCredential(path: string, maxBytes: number): Promise<string>
  /** The MCP endpoint's path for a Host data dir (ADR-013 item 3). */
  resolveEndpoint(hostDataDir: string): Promise<ReadOutcome<string>>
  /** Connects to the endpoint; rejects when it cannot be reached. */
  connect(path: string): Promise<Duplex>
  stdin: Readable
  stdout: Writable
  /** Appends one log line to a new `shim-` segment of `dir`; never throws. */
  writeLog(dir: string, line: string): Promise<void>
  now(): Date
  pid: number
  appVersion: string
  /** Runs the hello.ok wait (16 §2.6: every timeout is a task on it). */
  scheduler: Scheduler
}

/** How a relay ended: null for a close, else a fixed cause class (ADR-026 item 3) and an errno. */
type Ending = { cause: string; errCode?: string } | null

interface CredentialPath {
  path: string
  launchId: string
  hostDataDir: string
}

/** The launchId and the Host data dir of `<hostDataDir>/run/mcp/<launchId>.cred`, or null. */
function parseCredentialPath(path: string | undefined): CredentialPath | null {
  if (path === undefined || path === '' || !isAbsolute(path)) return null
  const name = CREDENTIAL_FILE.exec(basename(path))
  const mcpDir = dirname(path)
  const runDir = dirname(mcpDir)
  if (name === null || basename(mcpDir) !== 'mcp' || basename(runDir) !== 'run') return null
  return { path, launchId: name[1] as string, hostDataDir: dirname(runDir) }
}

/** Runs one relay to its end and answers its exit code. */
export async function runRelay(deps: RelayDeps): Promise<number> {
  // No valid path: no folder to log into either, and nothing is read or connected.
  const file = parseCredentialPath(deps.env[CREDENTIAL_FILE_VARIABLE])
  if (file === null) return 1

  const fail = async (cause: string, errCode?: string): Promise<number> => {
    const record: LogRecord = {
      ts: deps.now().toISOString(),
      level: 'error',
      proc: 'shim',
      pid: deps.pid,
      appVersion: deps.appVersion,
      event: 'mcp.relay.failed',
      subsystem: 'mcp-relay',
      outcome: 'failed',
      causeClass: cause,
      ...(UUID_V7.test(file.launchId) ? { launchId: file.launchId } : {}),
      ...(errCode === undefined ? {} : { errCode }),
      role: 'mcp'
    }
    const line = toLogLine(record)
    if (typeof line === 'string') {
      await deps.writeLog(join(dirname(file.hostDataDir), 'logs'), line)
    }
    return 1
  }

  let credential: string
  try {
    credential = await deps.readCredential(file.path, MAX_CREDENTIAL_FILE_BYTES)
  } catch {
    return fail('credential-unreadable')
  }
  if (credential.length > MAX_CREDENTIAL_FILE_BYTES || !CREDENTIAL.test(credential)) {
    return fail('credential-invalid')
  }

  const endpoint = await deps.resolveEndpoint(file.hostDataDir)
  if (!endpoint.ok) return fail('endpoint-unresolved')
  let socket: Duplex
  try {
    socket = await deps.connect(endpoint.value)
  } catch (error) {
    return fail('endpoint-unreachable', errnoOf(error))
  }

  const hello: McpHello = {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'mcp',
    launchId: file.launchId,
    credential
  }
  socket.write(encodeFrame(hello))
  const ending = await relay(socket, deps)
  socket.destroy()
  deps.stdin.pause()
  return ending === null ? 0 : fail(ending.cause, ending.errCode)
}

/** Relays until either side closes or fails. */
function relay(socket: Duplex, deps: RelayDeps): Promise<Ending> {
  return new Promise((resolve) => {
    const frames = new FrameReader(FRAME_CAP_BEFORE_HELLO_OK)
    const lines = new LineReader(FRAME_CAP_AFTER_HELLO_OK)
    let authenticated = false
    let settled = false
    let stdinWaits = false
    let socketWaits = false

    const settle = (ending: Ending): void => {
      if (settled) return
      settled = true
      timer.cancel()
      deps.stdin.off('data', onStdinData)
      deps.stdin.off('end', onStdinEnd)
      resolve(ending)
    }
    const timer = deps.scheduler.after(HELLO_OK_WAIT_MS, () => settle({ cause: 'hello-timeout' }))

    const onStdinData = (chunk: Buffer | string): void => {
      if (settled) return
      const read = lines.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
      if (read === 'oversize') return settle({ cause: 'frame-oversize' })
      for (const line of read) {
        if (settled) return
        if (!isMessage(line)) return settle({ cause: 'stdio-malformed' })
        if (!socket.write(frameOf(line)) && !stdinWaits) {
          stdinWaits = true
          deps.stdin.pause()
          socket.once('drain', () => {
            stdinWaits = false
            if (!settled) deps.stdin.resume()
          })
        }
      }
    }

    const onStdinEnd = (): void => {
      // The provider closed the server: flush the connection, then leave.
      socket.end()
      if (socket.writableFinished) settle(null)
      else socket.once('finish', () => settle(null))
    }

    const onFrame = (body: Buffer): void => {
      if (!authenticated) {
        const message = parse(body) as { type?: unknown } | undefined
        if (message === undefined) return settle({ cause: 'frame-malformed' })
        if (message?.type !== 'hello.ok') {
          return settle({ cause: errorCode(message) ?? 'hello-unexpected' })
        }
        authenticated = true
        timer.cancel()
        frames.helloOk()
        deps.stdin.on('data', onStdinData)
        deps.stdin.once('end', onStdinEnd)
        deps.stdin.resume()
        return
      }
      // One message per line: a body holding a line break cannot cross unchanged.
      if (body.includes(NEWLINE) || body.includes(CARRIAGE_RETURN)) {
        return settle({ cause: 'frame-malformed' })
      }
      const message = parse(body)
      if (message === undefined) return settle({ cause: 'frame-malformed' })
      if (!isJsonRpc(message)) return settle({ cause: errorCode(message) ?? 'frame-unexpected' })
      if (!deps.stdout.write(Buffer.concat([body, LINE_END])) && !socketWaits) {
        socketWaits = true
        socket.pause()
        deps.stdout.once('drain', () => {
          socketWaits = false
          if (!settled) socket.resume()
        })
      }
    }

    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      frames.push(chunk)
      for (let next = frames.next(); next !== null && !settled; next = frames.next()) {
        if (next === 'oversize') return settle({ cause: 'frame-oversize' })
        onFrame(next)
      }
    })
    const closed = (): void => settle(authenticated ? null : { cause: 'endpoint-closed' })
    socket.on('end', closed)
    socket.on('close', closed)
    socket.on('error', (error: unknown) =>
      settle(withErrno(authenticated ? 'endpoint-error' : 'endpoint-closed', error))
    )
    // A provider that went away (EPIPE) or a broken stdin ends the relay; never a crash on stderr.
    deps.stdout.on('error', (error: unknown) => settle(withErrno('stdout-closed', error)))
    deps.stdin.on('error', (error: unknown) => settle(withErrno('stdin-error', error)))
  })
}

/** One frame of `body`: its UTF-8 length as uint32 LE, then the bytes (ADR-003 item 4). */
function frameOf(body: Buffer): Buffer {
  const prefix = Buffer.alloc(PREFIX_BYTES)
  prefix.writeUInt32LE(body.length, 0)
  return Buffer.concat([prefix, body], PREFIX_BYTES + body.length)
}

/** The JSON value of UTF-8 bytes, or undefined when they are not one. */
function parse(body: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
  } catch {
    return undefined
  }
}

/** A stdin line that is one JSON-RPC message: a JSON object or a batch array. */
function isMessage(line: Buffer): boolean {
  const value = parse(line)
  return typeof value === 'object' && value !== null
}

/** A frame that is a JSON-RPC 2.0 message object or a batch array. */
function isJsonRpc(value: unknown): boolean {
  if (Array.isArray(value)) return true
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
  )
}

/** The code of a Host error frame (ADR-003 item 12), when it is one. */
function errorCode(message: unknown): string | null {
  const frame = message as { type?: unknown; code?: unknown } | null | undefined
  return frame?.type === 'error' && typeof frame.code === 'string' && /^[A-Z_]+$/.test(frame.code)
    ? frame.code
    : null
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ERRNO.test(code) ? code : undefined
}

function withErrno(cause: string, error: unknown): Ending {
  const errCode = errnoOf(error)
  return errCode === undefined ? { cause } : { cause, errCode }
}

/** Splits a byte stream on `\n`, each byte copied once; a line longer than `cap` is refused. */
class LineReader {
  private parts: Buffer[] = []
  private size = 0

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): Buffer[] | 'oversize' {
    const lines: Buffer[] = []
    let start = 0
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, at)
      const whole =
        this.parts.length === 0
          ? piece
          : Buffer.concat([...this.parts, piece], this.size + piece.length)
      this.parts = []
      this.size = 0
      start = at + 1
      const line = whole.at(-1) === CARRIAGE_RETURN ? whole.subarray(0, -1) : whole
      if (line.length > this.cap) return 'oversize'
      if (line.toString('utf8').trim() !== '') lines.push(line)
    }
    const rest = chunk.subarray(start)
    if (rest.length > 0) {
      this.parts.push(rest)
      this.size += rest.length
    }
    return this.size > this.cap ? 'oversize' : lines
  }
}

/** Frames as raw bodies (ADR-003 item 4), each byte copied once; the cap is checked on the prefix. */
class FrameReader {
  private parts: Buffer[] = []
  private size = 0

  constructor(private cap: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.parts.push(chunk)
    this.size += chunk.length
  }

  /** Raises the cap to 8 MiB for every frame after `hello.ok`. */
  helloOk(): void {
    this.cap = FRAME_CAP_AFTER_HELLO_OK
  }

  /** The next whole body, an oversize refusal, or null when more bytes are needed. */
  next(): Buffer | 'oversize' | null {
    if (this.size < PREFIX_BYTES) return null
    const length = this.take(PREFIX_BYTES, false).readUInt32LE(0)
    if (length > this.cap) return 'oversize'
    if (this.size < PREFIX_BYTES + length) return null
    this.take(PREFIX_BYTES, true)
    return this.take(length, true)
  }

  private take(count: number, consume: boolean): Buffer {
    const first = this.parts[0] as Buffer
    let out: Buffer
    if (first.length >= count) {
      out = first.subarray(0, count)
      if (consume) {
        if (first.length === count) this.parts.shift()
        else this.parts[0] = first.subarray(count)
      }
    } else {
      out = Buffer.alloc(count)
      let written = 0
      let index = 0
      while (written < count) {
        const part = this.parts[index] as Buffer
        const used = Math.min(part.length, count - written)
        part.copy(out, written, 0, used)
        written += used
        if (!consume) index += 1
        else if (used === part.length) this.parts.shift()
        else this.parts[0] = part.subarray(used)
      }
    }
    if (consume) this.size -= count
    return out
  }
}

// ---- the process ------------------------------------------------------------------------------

/** The app's version, stamped by electron.vite.host.config.ts from package.json. */
declare const __DWARFAI_APP_VERSION__: string | undefined

/** Runs this process as the relay, with the real stdio, files, endpoint and log folder. */
async function startRelay(): Promise<void> {
  const entry = fileURLToPath(import.meta.url)
  // `out/host/dwarfai-mcp.js` → the app root (the repository in dev, `app.asar` when packaged).
  const appRoot = dirname(dirname(dirname(entry)))
  // An error after the relay ended (a provider gone mid-exit) is not printed: stderr stays empty.
  process.stdout.on('error', () => undefined)
  process.stdin.on('error', () => undefined)
  let code: number
  try {
    code = await runRelay({
      env: process.env,
      readCredential: readHead,
      resolveEndpoint: (hostDataDir) => resolveEndpoint(hostDataDir, appRoot),
      connect: connectTo,
      stdin: process.stdin,
      stdout: process.stdout,
      writeLog: writeShimSegment,
      now: () => new Date(),
      pid: process.pid,
      appVersion: typeof __DWARFAI_APP_VERSION__ === 'string' ? __DWARFAI_APP_VERSION__ : 'unknown',
      scheduler: new NodeScheduler({ onTaskError: () => undefined })
    })
  } catch {
    code = 1
  }
  process.exitCode = code
  process.stdin.destroy()
  // Leave once stdout has drained; never hang on a handle the provider still holds.
  process.stdout.write('', () => process.exit(code))
  setTimeout(() => process.exit(code), 2_000).unref()
}

/** The first `maxBytes + 1` bytes of the file, as UTF-8: a longer file reads as too long. */
async function readHead(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

async function resolveEndpoint(hostDataDir: string, appRoot: string): Promise<ReadOutcome<string>> {
  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  let input: Parameters<typeof mcpEndpointFor>[0]
  if (platform === 'win32') {
    const sid = createNativeUserSid({ prebuildsDir: winPipePrebuildsDir(appRoot) })()
    if (!sid.ok) return sid
    input = { platform, hostDataDir, userSid: sid.value, sha256 }
  } else {
    const facts = await createNodeEndpointFacts({ hostDataDir, platform })()
    if (!facts.ok) return facts
    input = facts.value
  }
  const endpoint = mcpEndpointFor(input)
  return endpoint.ok
    ? { ok: true, value: endpoint.value.path }
    : { ok: false, cause: endpoint.error.kind }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function connectTo(path: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

const FIRST_TS = /"ts":"([^"]+)"/

/**
 * The shim's SegmentWriter for one line (ADR-026 items 1–2; 19 §2, §4): recreate `logs/`, run the
 * prune plan every writer runs, then create the next `shim-` segment exclusively and write the
 * line. Every failure drops the line (16 §3 `DiagnosticsLog`: nothing is thrown).
 */
async function writeShimSegment(dir: string, line: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    const names = await readdir(dir)
    const segments: SegmentInfo[] = []
    for (const name of names) {
      if (parseSegmentName(name) === null) continue
      const info = await segmentInfo(join(dir, name)).catch(() => null)
      if (info !== null) segments.push({ name, ...info })
    }
    for (const name of planPrune(segments, LOG_CAP_BYTES, LOG_SEGMENT_BYTES)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
    let seq = nextSeq(names, 'shim-')
    // Another shim may take the same seq at the same moment: the exclusive create decides.
    for (let attempt = 0; attempt < 5; attempt += 1, seq += 1) {
      try {
        const file = await open(join(dir, segmentName('shim-', seq)), 'wx', 0o600)
        try {
          await file.writeFile(line, 'utf8')
        } finally {
          await file.close()
        }
        return
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EEXIST') return
      }
    }
  } catch {
    // dropped (16 §3)
  }
}

async function segmentInfo(path: string): Promise<{ bytes: number; firstTs: string }> {
  const { size } = await stat(path)
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(256)
    const { bytesRead } = await file.read(head, 0, head.length, 0)
    return {
      bytes: size,
      firstTs: FIRST_TS.exec(head.subarray(0, bytesRead).toString('utf8'))?.[1] ?? ''
    }
  } finally {
    await file.close()
  }
}

// Started only as the built relay script (`out/host/dwarfai-mcp.js`), never when imported.
if (basename(fileURLToPath(import.meta.url)) === RELAY_ENTRY_FILE) void startRelay()
