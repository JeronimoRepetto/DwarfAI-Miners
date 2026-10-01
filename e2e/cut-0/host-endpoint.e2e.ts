import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { endpointFor } from '../../src/contracts/host-protocol/endpoint.ts'
import { encodeFrame, FrameDecoder } from '../../src/contracts/host-protocol/frameCodec.ts'
import { launchApp, type LaunchedApp } from '../_harness/launchApp.ts'

/**
 * L9, cut 0 (TC-051-05; ADR-002 D2, D4; ADR-003 items 3, 5, 12): the built app, launched on the `ui-main` entry under
 * the harness's isolated profile (before the cut-0 switch the new root is built but is not the app's entry yet,
 * review R8B-02), starts its Host for that profile and attaches to it.
 *
 * - The Host's run files appear in the profile's `hostDataDir` (`userData` + `/host`), and its endpoint is the one
 *   the ADR-002 D2 rule names for that folder, so a developer's own app (another `userData`) never meets it.
 * - The UI attaches: its log records `host.connection` connected (19 §9.1), and the Host it attached to answers on
 *   the profile's endpoint with the epoch of the profile's `run/host.identity`.
 * - The versioned copy goes into a temporary root (LOCALAPPDATA, HOME or XDG_DATA_HOME of the app), never into the
 *   developer's own.
 * - The case ends its Host itself, as the tray's Stop everything and quit would (a short-lived `ui` connection with
 *   the profile's uiToken sends `host.shutdown {stop-all}`; the harness teardown through the app's own Stop
 *   everything comes later: ISSUE-056), so nothing of it outlives the case.
 */

const WINDOWS = process.platform === 'win32'
const DARWIN = process.platform === 'darwin'
/** The versioned copy of the Electron runtime is made on the first start (ADR-002 D5): give it time. */
const HOST_START_MS = 90_000

test.describe.configure({ timeout: 180_000 })

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Every log line under `<userData>/logs/`. */
function logLines(userDataDir: string): string[] {
  const dir = path.join(userDataDir, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8').split('\n'))
}

/** What the running app names its Host endpoint from: its `hostDataDir`, home folder and XDG_RUNTIME_DIR. */
interface AppEndpointFacts {
  hostDataDir: string
  home: string
  xdgRuntimeDir: string | undefined
}

/**
 * The endpoint the profile's Host binds, by the ADR-002 D2 rule (contracts/host-protocol/endpoint.ts), from the facts
 * the app itself holds. They are read from the app, never rebuilt from the profile's paths: Chromium resolves
 * `--user-data-dir` to its real path, so on macOS a profile under `/var/folders/…` is `/private/var/folders/…` to the
 * app, and the endpoint's profile key is made from the app's spelling.
 */
function profileEndpoint({ hostDataDir, home, xdgRuntimeDir }: AppEndpointFacts): string {
  if (WINDOWS) {
    const out = execFileSync(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true }
    )
    const userSid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(out)?.[1]
    const named = endpointFor({ platform: 'win32', hostDataDir, userSid, sha256 })
    if (!named.ok) throw new Error(named.error.kind)
    return named.value.path
  }
  // On POSIX the socket file shows which case rule the volume took (macOS case probe): either name of the rule.
  const platform = DARWIN ? 'darwin' : 'linux'
  const tried: string[] = []
  for (const caseInsensitiveVolume of [false, true]) {
    const named = endpointFor({
      platform,
      hostDataDir,
      home,
      ...(xdgRuntimeDir === undefined ? {} : { xdgRuntimeDir }),
      caseInsensitiveVolume,
      sha256
    })
    if (!named.ok) {
      tried.push(named.error.kind)
      continue
    }
    if (existsSync(named.value.path)) return named.value.path
    tried.push(named.value.path)
  }
  throw new Error(`no socket of the profile was found (tried ${tried.join(', ')})`)
}

/** One `ui` connection: hello with the profile's token, then each request answered in order. */
async function uiConnection(endpoint: string, token: string) {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = connect(endpoint)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  const decoder = new FrameDecoder()
  const frames: unknown[] = []
  const waiting: Array<(frame: unknown) => void> = []
  socket.on('data', (chunk: Uint8Array) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if (next.kind !== 'frame') continue
      const frame = next.message as { type?: string }
      if (frame.type === 'hello.ok') decoder.helloOk()
      if (frame.type === 'evt') continue
      const resolve = waiting.shift()
      if (resolve === undefined) frames.push(frame)
      else resolve(frame)
    }
  })
  socket.on('error', () => {})
  const next = (): Promise<unknown> =>
    frames.length > 0
      ? Promise.resolve(frames.shift())
      : new Promise((resolve) => waiting.push(resolve))
  socket.write(
    encodeFrame({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: 1,
      role: 'ui',
      token,
      client: { appVersion: '0.0.0-e2e', buildId: 'e2e', pid: process.pid }
    })
  )
  const helloOk = (await next()) as { type: string; epoch: string }
  return {
    helloOk,
    async request(method: string, params: unknown): Promise<unknown> {
      socket.write(encodeFrame({ type: 'req', id: 'e2e-1', method, params }))
      return next()
    },
    close: () => socket.destroy()
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

test.describe('cut 0: the Host endpoint of the test profile (TC-051-05)', () => {
  let launched: LaunchedApp | undefined
  let away = ''
  let hostPid: number | null = null

  test.afterEach(async () => {
    // Whatever happened, the case's Host does not outlive it.
    if (hostPid !== null && isAlive(hostPid)) process.kill(hostPid)
    await launched?.teardown()
    launched = undefined
    if (away !== '') rmSync(away, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test("[ADR-002] the built app's Host binds an endpoint of the test profile only and the UI attaches to it", async () => {
    // On POSIX directly under /tmp, so the macOS socket path under this HOME fits sun_path.
    away = WINDOWS
      ? mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-051-'))
      : mkdtempSync('/tmp/dw051e-')
    const env: Record<string, string> = WINDOWS
      ? { LOCALAPPDATA: away }
      : DARWIN
        ? { HOME: away }
        : { XDG_DATA_HOME: away }
    launched = await launchApp({
      entry: 'ui-main',
      env,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { userDataDir } = launched.profile
    const hostDataDir = path.join(userDataDir, 'host')
    const identityFile = path.join(hostDataDir, 'run', 'host.identity')

    // The Host started for this profile: its run files are in the profile's hostDataDir.
    await expect
      .poll(() => existsSync(identityFile), { timeout: HOST_START_MS, intervals: [250] })
      .toBe(true)
    const identity = JSON.parse(readFileSync(identityFile, 'utf8')) as {
      pid: number
      epoch: string
    }
    hostPid = identity.pid
    expect(existsSync(path.join(hostDataDir, 'run', 'ui.token'))).toBe(true)

    // The UI attached: its HostClient reached `connected` on that Host (19 §9.1 `host.connection`).
    await expect
      .poll(
        () =>
          logLines(userDataDir).some(
            (line) => line.includes('"host.connection"') && line.includes('"connected"')
          ),
        { timeout: 30_000, intervals: [250] }
      )
      .toBe(true)

    // The endpoint the ADR-002 D2 rule names for this profile is the one that Host answers on, with this profile's
    // uiToken.
    const token = readFileSync(path.join(hostDataDir, 'run', 'ui.token'), 'utf8').trim()
    const facts = await launched.app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      home: process.getBuiltinModule('node:os').homedir(),
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR
    }))
    const ui = await uiConnection(
      profileEndpoint({
        hostDataDir: path.join(facts.userData, 'host'),
        home: facts.home,
        xdgRuntimeDir: facts.xdgRuntimeDir
      }),
      token
    )
    expect(ui.helloOk).toMatchObject({ type: 'hello.ok', epoch: identity.epoch })

    // Stop everything and quit: the Host ends with no owned session, closes with host.closing and exits; the UI
    // does not start another one.
    const shutdown = await ui.request('host.shutdown', { mode: 'stop-all', requestId: uuidv7() })
    expect(shutdown).toMatchObject({ type: 'res', ok: true, result: { mode: 'stop-all' } })
    ui.close()
    await expect.poll(() => isAlive(identity.pid), { timeout: 15_000 }).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(existsSync(identityFile), 'no Host was started again').toBe(false)
  })
})

/** A UUIDv7 (14 §1.6): the time prefix, then random bits. */
function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0')
  const rest = randomUUID().replaceAll('-', '')
  const v = `${hex}7${rest.slice(13, 16)}${((Number.parseInt(rest[16] ?? '8', 16) & 0x3) | 0x8).toString(16)}${rest.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}
