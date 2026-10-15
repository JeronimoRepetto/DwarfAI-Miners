// The `dwarfai-mcp` relay (ADR-013 items 2–3, frozen; 16 §5.2 items 2–4; 15 §4 "Delegation relay
// form"; UC-017 steps 1–3): the stdio MCP server a delegating provider session starts from the relay
// entry (relayEntry.ts), `{ command: <versioned-copy executable>, args: [<this script>], env: {
// ELECTRON_RUN_AS_NODE: '1', DWARFAI_MCP_CREDENTIAL_FILE: <path> } }`. electron.vite.host.config.ts
// emits it as `out/host/dwarfai-mcp.js`, beside the Host entry.
//
// 1. The relay learns only the credential FILE PATH. The path must be
//    `<hostDataDir>/run/mcp/<launchId>.cred` (RunDirCredentialFileStore's layout): the launchId is
//    the file's name and nothing else, and hostDataDir is the folder three levels up. Any other path
//    is refused before anything is read or connected.
// 2. It reads the credential (32 bytes as 64 lower-case hex) from the file, computes the MCP
//    endpoint's path from hostDataDir (ADR-013 item 3 through `mcpEndpointFor`, the ADR-002 D2 rule
//    of contracts/host-protocol/endpoint.ts), connects, and writes `McpHello {type:'hello',
//    endpointGeneration:1, protocolVersion, role:'mcp', launchId, credential}` as its first bytes.
//    Nothing from stdin is read before `hello.ok`.
// 3. After `hello.ok` it moves newline-delimited JSON-RPC between its stdio and the endpoint: one
//    stdin line → one ADR-003 item 4 frame, one frame → one stdout line. It parses nothing else of
//    the MCP messages (16 §5.2 item 4). A frame that is not a JSON-RPC message (the Host's one error
//    frame before it closes) never reaches stdout.
// 4. It exits when either side closes: 0 for a close, non-zero for a failure (FM-039: AUTH_FAILED, a
//    missing or unreadable file, an endpoint it cannot resolve or reach). A failure writes one
//    `shim-` segment line (19 §2: on error only, `proc: 'shim'`, subsystem `mcp-relay`) through
//    contracts/logging's pure rules, into `<hostDataDir>/../logs` (ADR-026 item 1); never the
//    credential, never a message (ADR-013 item 2, C-16; ADR-026 items 3–5). stdout carries MCP only.
//
// The credential lives in this process alone (ADR-013 item 2's one exception): it is never in an
// argv, an environment, stdout or a log. The relay starts no process (no `node:child_process`): on
// Windows the user SID of the endpoint's name is read natively (nativeUserSid.ts).
//
// Linux risk (lead decision 2026-10-15, spike item): a provider that does not pass XDG_RUNTIME_DIR
// to its stdio MCP servers makes the relay name the fallback socket while the Host bound the XDG
// one; the relay then fails closed with `endpoint-unreachable`.
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { McpHello } from '../../../../../../contracts/host-protocol/adr-003'
import { encodeFrame, FrameDecoder } from '../../../../../../contracts/host-protocol/frameCodec'
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
import { winPipePrebuildsDir } from '../../../../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { createNativeUserSid } from '../../../../../platform/endpoint/win-pipe/nativeUserSid'
import { createNodeEndpointFacts } from '../../../../../platform/endpoint/nodeEndpointEnv'
import type { ReadOutcome } from '../../../../../platform/process/probe/types'
import { mcpEndpointFor } from '../../../../../transport/mcpEndpoint/mcpEndpointPath'
import { RELAY_ENTRY_FILE } from './relayEntry'

/** The relay entry's own variable (15 §4): the credential file's path, never the credential. */
export const CREDENTIAL_FILE_VARIABLE = 'DWARFAI_MCP_CREDENTIAL_FILE'

const CREDENTIAL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cred$/
const CREDENTIAL = /^[0-9a-f]{64}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NEWLINE = 0x0a

export interface RelayDeps {
  env: Readonly<Record<string, string | undefined>>
  /** Reads the credential file as UTF-8 text. */
  readCredential(path: string): Promise<string>
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
}

/** Why a relay ended with a failure: a fixed class, never a message (ADR-026 item 3 `causeClass`). */
type FailureCause =
  | 'credential-path-missing'
  | 'credential-path-invalid'
  | 'credential-unreadable'
  | 'credential-invalid'
  | 'endpoint-unresolved'
  | 'endpoint-unreachable'
  | 'endpoint-closed'
  | 'hello-unexpected'
  | 'frame-oversize'
  | 'frame-malformed'
  | 'frame-unexpected'
  | 'stdio-malformed'
  | 'internal'
  /** A Host error frame's code: AUTH_FAILED, PROTOCOL_ERROR, RATE_LIMITED, … (ADR-003 item 12). */
  | string

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
  const raw = deps.env[CREDENTIAL_FILE_VARIABLE]
  if (raw === undefined || raw === '') return 1 // no path: no folder to log into either
  const file = parseCredentialPath(raw)
  if (file === null) return 1

  const fail = async (cause: FailureCause): Promise<number> => {
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
    credential = await deps.readCredential(file.path)
  } catch {
    return fail('credential-unreadable')
  }
  if (!CREDENTIAL.test(credential)) return fail('credential-invalid')

  const endpoint = await deps.resolveEndpoint(file.hostDataDir)
  if (!endpoint.ok) return fail('endpoint-unresolved')
  let socket: Duplex
  try {
    socket = await deps.connect(endpoint.value)
  } catch {
    return fail('endpoint-unreachable')
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
  const cause = await relay(socket, deps)
  socket.destroy()
  deps.stdin.pause()
  return cause === null ? 0 : fail(cause)
}

/** Relays until either side closes: null for a close, the cause of a failure otherwise. */
function relay(socket: Duplex, deps: RelayDeps): Promise<FailureCause | null> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder()
    let authenticated = false
    let settled = false
    let pending: Buffer = Buffer.alloc(0)

    const settle = (cause: FailureCause | null): void => {
      if (settled) return
      settled = true
      deps.stdin.off('data', onLine)
      deps.stdin.off('end', onStdinEnd)
      resolve(cause)
    }

    const onLine = (chunk: Buffer | string): void => {
      if (settled) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes])
      for (let at = pending.indexOf(NEWLINE); at !== -1; at = pending.indexOf(NEWLINE)) {
        const line = pending.subarray(0, at).toString('utf8').replace(/\r$/, '')
        pending = pending.subarray(at + 1)
        if (line.trim() === '') continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          settle('stdio-malformed')
          return
        }
        socket.write(encodeFrame(message))
      }
    }

    const onStdinEnd = (): void => {
      // The provider closed the server: end the connection and leave.
      socket.end()
      settle(null)
    }

    socket.on('data', (chunk: Uint8Array) => {
      if (settled) return
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if (next.kind === 'oversize') return settle('frame-oversize')
        if (next.kind === 'malformed') return settle('frame-malformed')
        const message = next.message as { type?: unknown; code?: unknown; jsonrpc?: unknown }
        if (!authenticated) {
          if (message?.type === 'hello.ok') {
            authenticated = true
            decoder.helloOk()
            deps.stdin.on('data', onLine)
            deps.stdin.once('end', onStdinEnd)
            deps.stdin.resume()
            continue
          }
          return settle(errorCode(message) ?? 'hello-unexpected')
        }
        if (message?.jsonrpc !== '2.0') return settle(errorCode(message) ?? 'frame-unexpected')
        deps.stdout.write(`${JSON.stringify(message)}\n`)
      }
    })
    socket.on('error', () => settle(authenticated ? null : 'endpoint-closed'))
    socket.on('close', () => settle(authenticated ? null : 'endpoint-closed'))
    socket.on('end', () => settle(authenticated ? null : 'endpoint-closed'))
  })
}

/** The code of a Host error frame (ADR-003 item 12), when it is one. */
function errorCode(message: { type?: unknown; code?: unknown } | null): string | null {
  return message?.type === 'error' &&
    typeof message.code === 'string' &&
    /^[A-Z_]+$/.test(message.code)
    ? message.code
    : null
}

// ---- the process ------------------------------------------------------------------------------

/** The app's version, stamped by electron.vite.host.config.ts from package.json. */
declare const __DWARFAI_APP_VERSION__: string | undefined

/** Runs this process as the relay, with the real stdio, files, endpoint and log folder. */
export async function startRelay(): Promise<void> {
  const entry = fileURLToPath(import.meta.url)
  // `out/host/dwarfai-mcp.js` → the app root (the repository in dev, `app.asar` when packaged).
  const appRoot = dirname(dirname(dirname(entry)))
  let code: number
  try {
    code = await runRelay({
      env: process.env,
      readCredential: (path) => readFile(path, 'utf8'),
      resolveEndpoint: (hostDataDir) => resolveEndpoint(hostDataDir, appRoot),
      connect: connectTo,
      stdin: process.stdin,
      stdout: process.stdout,
      writeLog: writeShimSegment,
      now: () => new Date(),
      pid: process.pid,
      appVersion: typeof __DWARFAI_APP_VERSION__ === 'string' ? __DWARFAI_APP_VERSION__ : 'unknown'
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
export async function writeShimSegment(dir: string, line: string): Promise<void> {
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
