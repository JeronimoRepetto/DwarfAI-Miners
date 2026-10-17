// The console viewer (ADR-031 item 2; ADR-003 item 12, frozen; 16 §8.1 "Console viewer"; UC-036;
// 13 FM-040): the read-only live view of one dwarf's conversation that UI main opens in an OS terminal
// for the `log` console. electron.vite.viewer.config.ts emits it as `out/host/dwarfai-viewer.js`,
// beside the Host entry; UI main runs it on the versioned-copy executable with ELECTRON_RUN_AS_NODE=1
// and the token file's PATH as its one argument (TerminalConsoleRaiser). This file is that process's
// entry: it starts itself when it runs as the built script, and nothing but its own tests imports it
// (.dependency-cruiser.cjs R6-viewer-entry-not-imported); what the Host needs lives in viewerEntry.ts.
//
// 1. The viewer learns only the token file's path. It must be `<hostDataDir>/run/viewers/<viewId>.token`
//    (RunDirViewerTokenFiles' layout): the viewId is the file's name, and hostDataDir is the folder
//    three levels up. Any other path is refused before anything is read or connected.
// 2. It reads at most VIEWER_TOKEN_FILE_MAX_BYTES of the file and deletes it at once, whatever it
//    holds (single use, ADR-003 item 12), before its `hello`. The file holds the token and the dwarf
//    it is bound to (viewerTokenFile.ts).
// 3. It computes the UI endpoint from hostDataDir (the ADR-002 D2 rule, contracts endpoint.ts),
//    connects and writes `hello {role:'viewer', viewId, token}` as its first bytes. It waits
//    HELLO_OK_WAIT_MS for `hello.ok`; an error frame (AUTH_FAILED for a token used twice or after
//    60 s) ends it (FM-040).
// 4. After `hello.ok` it sends `events.subscribe {}`, then `conversation.feed {dwarfId}`, and it
//    sends nothing else but a `ping` every PING_EVERY_MS (ADR-003 item 9). It renders the page oldest
//    first, then each `conversation.appended` and `activity.changed` frame of its dwarf: the person's
//    messages, the dwarf's replies and one line per tool step. A `resync-required` frame pages again;
//    `dwarf.departed` ends it.
// 5. It accepts no input (OQ-39 A: the person types in the chat). Nothing read from stdin ever
//    reaches the Host: on a TTY, stdin is put in raw mode so typed keys are not even echoed, and only
//    Ctrl+C or Ctrl+D closes the view.
// 6. Rendering is text only and never copy: a person's line starts with `›`, a tool step with `·`.
//    Every control character a provider text could hold (ESC, CSI, C1) is dropped, so no text can
//    move the cursor, retitle the window or write to the clipboard (R19 spirit: provider text stays
//    data). No status words are shown: a failure closes the view with nothing printed
//    (⟦COPY NEEDED: ADR-031 viewer failure⟧).
// 7. It exits 0 when the dwarf departs or the Host closes the connection after `hello.ok`, non-zero
//    for a failure, which writes one `shim-` segment line (19 §2: on error only, `proc: 'shim'`,
//    subsystem `console-viewer`) into `<hostDataDir>/../logs` (ADR-026 item 1): never the token,
//    never a message text.
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { endpointFor } from '../../../../../../contracts/host-protocol/endpoint'
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
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import { NodeScheduler } from '../../../../../platform/clock/NodeScheduler'
import { createNodeEndpointFacts } from '../../../../../platform/endpoint/nodeEndpointEnv'
import { winPipePrebuildsDir } from '../../../../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { createNativeUserSid } from '../../../../../platform/endpoint/win-pipe/nativeUserSid'
import type { ReadOutcome } from '../../../../../platform/process/probe/types'
import { VIEWER_ENTRY_FILE } from './viewerEntry'
import { parseViewerTokenFile, VIEWER_TOKEN_FILE_MAX_BYTES } from './viewerTokenFile'

/** The ADR-003 item 5 hello budget (5 s): a Host that does not answer in it ends the viewer. */
export const HELLO_OK_WAIT_MS = 5_000
/** ADR-003 item 9: a client pings every 5 s while idle; the Host detaches a client silent 15 s. */
export const PING_EVERY_MS = 5_000

const TOKEN_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.token$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ERRNO = /^E[A-Z0-9_]+$/
const ERROR_CODE = /^[A-Z_]+$/
/** C0 controls but tab and line feed, DEL, and C1 controls: what can steer a terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const CTRL_C = 0x03
const CTRL_D = 0x04

export interface ViewerDeps {
  /** The viewer's arguments after its own script: exactly the token file's path. */
  args: readonly string[]
  /** Reads at most `maxBytes` (plus one, to tell a longer file) of the token file as UTF-8. */
  readTokenFile(path: string, maxBytes: number): Promise<string>
  /** Deletes the token file; never throws. */
  removeTokenFile(path: string): Promise<void>
  /** The UI endpoint's path for a Host data dir (ADR-002 D2). */
  resolveEndpoint(hostDataDir: string): Promise<ReadOutcome<string>>
  /** Connects to the endpoint; rejects when it cannot be reached. */
  connect(path: string): Promise<Duplex>
  /** The terminal's input: never forwarded anywhere (item 5). */
  stdin: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
  stdout: Writable
  /** Appends one log line to a new `shim-` segment of `dir`; never throws. */
  writeLog(dir: string, line: string): Promise<void>
  now(): Date
  pid: number
  appVersion: string
  buildId: string
  /** Runs the hello.ok wait and the pings (16 §2.6: every timeout is a task on it). */
  scheduler: Scheduler
}

interface TokenPath {
  path: string
  viewId: string
  hostDataDir: string
}

/** The viewId and the Host data dir of `<hostDataDir>/run/viewers/<viewId>.token`, or null. */
function parseTokenPath(path: string | undefined): TokenPath | null {
  if (path === undefined || path === '' || !isAbsolute(path)) return null
  const name = TOKEN_FILE.exec(basename(path))
  const viewersDir = dirname(path)
  const runDir = dirname(viewersDir)
  if (name === null || basename(viewersDir) !== 'viewers' || basename(runDir) !== 'run') return null
  return { path, viewId: name[1] as string, hostDataDir: dirname(runDir) }
}

/** How a view ended: null for a clean end, else a fixed cause class (ADR-026 item 3) and an errno. */
type Ending = { cause: string; errCode?: string } | null

/** Runs one view to its end and answers its exit code. */
export async function runViewer(deps: ViewerDeps): Promise<number> {
  // Exactly one argument, the token file's path; no valid path, no folder to log into either.
  const file = deps.args.length === 1 ? parseTokenPath(deps.args[0]) : null
  if (file === null) return 1

  const fail = async (cause: string, errCode?: string, dwarfId?: string): Promise<number> => {
    const record: LogRecord = {
      ts: deps.now().toISOString(),
      level: 'error',
      proc: 'shim',
      pid: deps.pid,
      appVersion: deps.appVersion,
      event: 'viewer.attach.failed',
      subsystem: 'console-viewer',
      outcome: 'failed',
      causeClass: cause,
      ...(dwarfId !== undefined && UUID_V7.test(dwarfId) ? { dwarfId } : {}),
      ...(errCode === undefined ? {} : { errCode }),
      role: 'viewer'
    }
    const line = toLogLine(record)
    if (typeof line === 'string') await deps.writeLog(join(dirname(file.hostDataDir), 'logs'), line)
    return 1
  }

  let text: string | null = null
  try {
    text = await deps.readTokenFile(file.path, VIEWER_TOKEN_FILE_MAX_BYTES)
  } catch {
    text = null
  }
  // Single use: the file goes before anything else happens, whatever it held.
  await deps.removeTokenFile(file.path)
  if (text === null) return fail('token-unreadable')
  const credential = text.length > VIEWER_TOKEN_FILE_MAX_BYTES ? null : parseViewerTokenFile(text)
  if (credential === null) return fail('token-invalid')

  const endpoint = await deps.resolveEndpoint(file.hostDataDir)
  if (!endpoint.ok) return fail('endpoint-unresolved', undefined, credential.dwarfId)
  let socket: Duplex
  try {
    socket = await deps.connect(endpoint.value)
  } catch (error) {
    return fail('endpoint-unreachable', errnoOf(error), credential.dwarfId)
  }

  holdInput(deps.stdin, () => socket.destroy())
  socket.write(
    encodeFrame({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'viewer',
      token: credential.token,
      viewId: file.viewId,
      client: { appVersion: deps.appVersion, buildId: deps.buildId, pid: deps.pid }
    })
  )
  const ending = await view(socket, credential.dwarfId, deps)
  socket.destroy()
  releaseInput(deps.stdin)
  return ending === null ? 0 : fail(ending.cause, ending.errCode, credential.dwarfId)
}

/**
 * Item 5: typed keys go nowhere. On a TTY raw mode keeps them from being echoed, and Ctrl+C or
 * Ctrl+D (which raw mode no longer turns into a signal) closes the view; every other byte is dropped.
 */
function holdInput(stdin: ViewerDeps['stdin'], close: () => void): void {
  if (stdin.isTTY !== true || stdin.setRawMode === undefined) return
  stdin.setRawMode(true)
  stdin.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (bytes.includes(CTRL_C) || bytes.includes(CTRL_D)) close()
  })
  stdin.resume()
}

function releaseInput(stdin: ViewerDeps['stdin']): void {
  if (stdin.isTTY === true && stdin.setRawMode !== undefined) stdin.setRawMode(false)
  stdin.pause()
}

/** Subscribes, pages and renders until the dwarf departs, the Host closes or something fails. */
function view(socket: Duplex, dwarfId: string, deps: ViewerDeps): Promise<Ending> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder()
    const shown = new Set<string>()
    const stepsShown = new Map<string, number>()
    let authenticated = false
    let settled = false
    let nextId = 0
    let feedRequest: string | null = null
    let pinging: { cancel(): void } | null = null

    const settle = (ending: Ending): void => {
      if (settled) return
      settled = true
      helloTimer.cancel()
      pinging?.cancel()
      resolve(ending)
    }
    const helloTimer = deps.scheduler.after(HELLO_OK_WAIT_MS, () =>
      settle({ cause: 'hello-timeout' })
    )
    const request = (method: string, params: unknown): string => {
      nextId += 1
      const id = `v-${nextId}`
      socket.write(encodeFrame({ type: 'req', id, method, params }))
      return id
    }
    const page = (): void => {
      feedRequest = request('conversation.feed', { dwarfId })
    }
    const ping = (): void => {
      pinging = deps.scheduler.after(PING_EVERY_MS, () => {
        if (settled) return
        request('ping', {})
        ping()
      })
    }
    const write = (text: string): void => {
      deps.stdout.write(text)
    }

    const onMessage = (message: unknown): void => {
      const frame = message as { type?: unknown; code?: unknown }
      if (!authenticated) {
        if (frame.type !== 'hello.ok') {
          return settle({ cause: errorCodeOf(frame) ?? 'hello-unexpected' })
        }
        authenticated = true
        helloTimer.cancel()
        decoder.helloOk()
        request('events.subscribe', {})
        page()
        ping()
        return
      }
      if (frame.type === 'res') {
        const res = message as { id?: unknown; ok?: unknown; result?: unknown }
        if (res.id !== feedRequest) return
        feedRequest = null
        if (res.ok !== true) return settle({ cause: 'feed-refused' })
        const messages = (res.result as { messages?: unknown } | null)?.messages
        // A page is newest first; the view reads top to bottom, oldest first.
        if (Array.isArray(messages)) for (const m of [...messages].reverse()) show(m)
        return
      }
      if (frame.type === 'error') return settle({ cause: errorCodeOf(frame) ?? 'host-error' })
      if (frame.type !== 'evt') return
      const evt = message as { name?: unknown; data?: unknown }
      const data = evt.data as { dwarfId?: unknown } | null
      // The Host sends a viewer its own dwarf's frames only; anything else is not shown either way.
      if (evt.name === 'resync-required') return page()
      if (data?.dwarfId !== dwarfId) return
      if (evt.name === 'dwarf.departed') return settle(null)
      if (evt.name === 'conversation.appended') {
        const messages = (data as { messages?: unknown }).messages
        if (Array.isArray(messages)) for (const m of messages) show(m)
      } else if (evt.name === 'activity.changed') {
        const run = data as { disclosureId?: unknown; summaries?: unknown }
        if (typeof run.disclosureId === 'string' && Array.isArray(run.summaries)) {
          const before = stepsShown.get(run.disclosureId) ?? 0
          for (const summary of run.summaries.slice(before)) write(stepLine(summary))
          stepsShown.set(run.disclosureId, Math.max(before, run.summaries.length))
        }
      }
    }

    const show = (raw: unknown): void => {
      const m = raw as { id?: unknown; role?: unknown; text?: unknown; activity?: unknown }
      if (typeof m.id !== 'string' || shown.has(m.id)) return
      shown.add(m.id)
      write(renderMessage(m.role, m.text))
      const summaries = (m.activity as { summaries?: unknown } | undefined)?.summaries
      if (Array.isArray(summaries)) for (const summary of summaries) write(stepLine(summary))
    }

    socket.on('data', (chunk: Uint8Array) => {
      if (settled) return
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null && !settled; next = decoder.next()) {
        if (next.kind !== 'frame') return settle({ cause: `frame-${next.kind}` })
        onMessage(next.message)
      }
    })
    const closed = (): void => settle(authenticated ? null : { cause: 'endpoint-closed' })
    socket.on('end', closed)
    socket.on('close', closed)
    socket.on('error', (error: unknown) =>
      settle(withErrno(authenticated ? 'endpoint-error' : 'endpoint-closed', error))
    )
    deps.stdout.on('error', (error: unknown) => settle(withErrno('stdout-closed', error)))
  })
}

/** Provider text as plain data: every control character but tab and line feed dropped (item 6). */
export function plainText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(CONTROL, '') : ''
}

/** One message as the view prints it: a person's line starts with `›`, a reply is plain. */
export function renderMessage(role: unknown, text: unknown): string {
  const body = plainText(text)
  const prefix = role === 'person' || role === 'answers-record' ? '› ' : ''
  return `${prefix}${body}\n\n`
}

/** One tool step: its one-line summary (never a tool's output, ADR-007 item 4). */
export function stepLine(summary: unknown): string {
  return `  · ${plainText(summary).replace(/\n/g, ' ')}\n`
}

function errorCodeOf(frame: { type?: unknown; code?: unknown }): string | null {
  return frame.type === 'error' && typeof frame.code === 'string' && ERROR_CODE.test(frame.code)
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

// ---- the process ------------------------------------------------------------------------------

/** The app's version and build, stamped by electron.vite.viewer.config.ts. */
declare const __DWARFAI_APP_VERSION__: string | undefined
declare const __DWARFAI_BUILD_ID__: string | undefined

/** Runs this process as the viewer, with the real terminal, files, endpoint and log folder. */
async function startViewer(): Promise<void> {
  const entry = fileURLToPath(import.meta.url)
  // `out/host/dwarfai-viewer.js` → the app root (the repository in dev, `app.asar` when packaged).
  const appRoot = dirname(dirname(dirname(entry)))
  process.stdout.on('error', () => undefined)
  let code: number
  try {
    code = await runViewer({
      args: process.argv.slice(2),
      readTokenFile: readHead,
      removeTokenFile: (path) => rm(path, { force: true }).catch(() => undefined),
      resolveEndpoint: (hostDataDir) => resolveEndpoint(hostDataDir, appRoot),
      connect: connectTo,
      stdin: process.stdin,
      stdout: process.stdout,
      writeLog: writeShimSegment,
      now: () => new Date(),
      pid: process.pid,
      appVersion: typeof __DWARFAI_APP_VERSION__ === 'string' ? __DWARFAI_APP_VERSION__ : 'unknown',
      buildId: typeof __DWARFAI_BUILD_ID__ === 'string' ? __DWARFAI_BUILD_ID__ : 'unknown',
      scheduler: new NodeScheduler({ onTaskError: () => undefined })
    })
  } catch {
    code = 1
  }
  process.exitCode = code
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
  let input: Parameters<typeof endpointFor>[0]
  if (platform === 'win32') {
    const sid = createNativeUserSid({ prebuildsDir: winPipePrebuildsDir(appRoot) })()
    if (!sid.ok) return sid
    input = { platform, hostDataDir, userSid: sid.value, sha256 }
  } else {
    const facts = await createNodeEndpointFacts({ hostDataDir, platform })()
    if (!facts.ok) return facts
    input = facts.value
  }
  const endpoint = endpointFor(input)
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
 * The shim's SegmentWriter for one line (ADR-026 items 1–2; 19 §2, §4), as the delegation relay
 * writes its own: recreate `logs/`, run the prune plan every writer runs, then create the next
 * `shim-` segment exclusively and write the line. Every failure drops the line.
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

// The built script starts itself; its tests import it without starting it.
if (basename(fileURLToPath(import.meta.url)) === VIEWER_ENTRY_FILE) void startViewer()
