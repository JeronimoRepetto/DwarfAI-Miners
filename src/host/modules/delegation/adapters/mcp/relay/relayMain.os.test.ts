// L8 OS lane (17 §1.8): the built `dwarfai-mcp` relay (`out/host/dwarfai-mcp.js`, built here with
// electron.vite.relay.config.ts, beside the Host built with electron.vite.host.config.ts, as
// `pnpm build` builds them) started as a provider starts it: the command and argv of the relay entry, and an environment that is the provider's plus the entry's own
// two variables (15 §4). The endpoint is the Host's real MCP endpoint (ISSUE-199) with the real
// delegation MCP server, bound at the path the relay computes on its own (ADR-013 item 3; the Windows
// SID natively, nativeUserSid.ts). The command line is read back as the OS lists it (the listing of
// `ProcessControl.listProcesses`). Runs only in `pnpm test:os`; Windows needs `pnpm build:native`.
// TC-200-04: the credential is absent from the process command line (C-15, ADR-013).
// TC-200-03 (real I/O): a missing credential file makes the relay exit non-zero, with one `shim-`
// segment and nothing on stdout (FM-039).
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-vite'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LaunchId } from '../../../../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import type { SpawnedProcess } from '../../../../../kernel/ports/processControl'
import { NodeScheduler } from '../../../../../platform/clock/NodeScheduler'
import { createNodeEndpointFacts } from '../../../../../platform/endpoint/nodeEndpointEnv'
import { createNativeOwnerOnlyPipe } from '../../../../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { createNativeUserSid } from '../../../../../platform/endpoint/win-pipe/nativeUserSid'
import {
  createQueryRunner,
  NodeProcessControl
} from '../../../../../platform/process/NodeProcessControl'
import {
  createDarwinListing,
  createLinuxListing,
  createWin32Listing,
  type RawListing
} from '../../../../../platform/process/list/listing'
import { HelloThrottle } from '../../../../../transport/auth/throttle'
import { createMcpEndpoint } from '../../../../../transport/mcpEndpoint/mcpEndpoint'
import { mcpEndpointFor } from '../../../../../transport/mcpEndpoint/mcpEndpointPath'
import type { DelegationEndpoint } from '../../../ports/delegationServer'
import { hashOf } from '../../../testing/drawCredential'
import { RunDirCredentialFileStore } from '../../fs/RunDirCredentialFileStore'
import { McpDelegationServer } from '../McpDelegationServer'
import { relayEntryArgs, relayServerEntry } from './relayEntry'

const REPO = fileURLToPath(new URL('../../../../../../../', import.meta.url))
const PREBUILDS = join(REPO, 'prebuilds')
const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const PLATFORM =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
/** Real time is the L8 lane's (17 §5.3); a relay that hangs fails the case instead of the lane. */
const STEP_MS = 20_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let hostEntry: string
beforeAll(async () => {
  for (const config of ['electron.vite.host.config.ts', 'electron.vite.relay.config.ts']) {
    await build({ root: REPO, configFile: join(REPO, config), logLevel: 'warn' })
  }
  hostEntry = join(REPO, 'out', 'host', 'main.js')
}, 180_000)

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** A fresh Host data dir (directly under /tmp on POSIX: the socket path must fit `sun_path`). */
function freshRoot(): { root: string; hostDataDir: string; providerEnv: Record<string, string> } {
  const root =
    PLATFORM === 'win32'
      ? mkdtempSync(join(process.env['TEMP'] ?? '.', 'dw200-'))
      : mkdtempSync('/tmp/dw200-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  // The provider's environment: this one, with its own home and runtime folder on POSIX, so the
  // endpoint lands in the test's folder.
  const providerEnv: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('DWARFAI_')) providerEnv[name] = value
  }
  if (PLATFORM === 'darwin') providerEnv['HOME'] = root
  if (PLATFORM === 'linux') providerEnv['XDG_RUNTIME_DIR'] = root
  return { root, hostDataDir: join(root, 'DwarfAI-test', 'host'), providerEnv }
}

/** The MCP endpoint path for `hostDataDir`, from this OS's facts, as the Host names it. */
async function endpointPath(hostDataDir: string, root: string): Promise<string> {
  let input: Parameters<typeof mcpEndpointFor>[0]
  if (PLATFORM === 'win32') {
    const sid = createNativeUserSid({ prebuildsDir: PREBUILDS })()
    if (!sid.ok) throw new Error(`no SID: ${sid.cause}`)
    input = { platform: PLATFORM, hostDataDir, userSid: sid.value, sha256 }
  } else {
    const facts = await createNodeEndpointFacts({
      hostDataDir,
      platform: PLATFORM,
      home: root,
      env: { XDG_RUNTIME_DIR: root }
    })()
    if (!facts.ok) throw new Error(`no facts: ${facts.cause}`)
    input = facts.value
  }
  const endpoint = mcpEndpointFor(input)
  if (!endpoint.ok) throw new Error(`no MCP endpoint: ${JSON.stringify(endpoint.error)}`)
  return endpoint.value.path
}

/** The Host's MCP endpoint with the delegation MCP server, accepting `credential` for LAUNCH. */
async function serveEndpoint(path: string, credential: string): Promise<void> {
  const log = new RecordingDiagnosticsLog()
  const endpoint = createMcpEndpoint({
    endpoint:
      PLATFORM === 'win32'
        ? { kind: 'named-pipe', path }
        : { kind: 'unix-socket', path, dir: join(path, '..') },
    tokens: {
      byLaunch: (id) =>
        id === LAUNCH
          ? {
              launchId: LAUNCH,
              parentDwarfId: null,
              mechanism: 'ticket-file',
              credentialHash: hashOf(credential),
              issuedAt: 1_000
            }
          : null
    },
    scheduler: new NodeScheduler({ onTaskError: () => {} }),
    log,
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: 1 },
    epoch: 'epoch-0001',
    state: () => ({ state: 'ready', jobStatus: 'none' }),
    throttle: new HelloThrottle(new FakeClock(1_000)),
    ...(PLATFORM === 'win32'
      ? { ownerOnlyPipe: createNativeOwnerOnlyPipe({ prebuildsDir: PREBUILDS }) }
      : {})
  })
  const server = new McpDelegationServer(endpoint, log)
  await server.listen({} as DelegationEndpoint)
  cleanups.push(() => server.close())
}

/** Starts the relay as a provider starts its MCP server entry. */
function startRelay(credentialFilePath: string, providerEnv: Record<string, string>, cwd: string) {
  const entry = relayServerEntry({
    appPaths: { execPath: process.execPath },
    relayEntryArgs: relayEntryArgs(hostEntry),
    credentialFilePath
  })
  const child = new NodeProcessControl().spawn({
    executable: entry.command,
    args: entry.args,
    cwd,
    env: { ...providerEnv, ...entry.env },
    processGroup: 'inherit',
    stdio: 'pipe'
  })
  cleanups.push(async () => {
    child.stdin?.destroy()
    await Promise.race([
      child.exited.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
  })
  let out = ''
  const waiters: Array<() => void> = []
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
    for (const wake of waiters.splice(0)) wake()
  })
  child.stderr?.resume()
  /** The stdout line answering request `id`. */
  const answer = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + STEP_MS
    for (;;) {
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue
        const message = JSON.parse(line) as Record<string, unknown>
        if (message['id'] === id) return message
      }
      if (Date.now() > deadline) throw new Error(`no answer to ${id}; stdout: ${out}`)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 200)
      })
    }
  }
  return { child, answer, stdout: () => out }
}

function send(child: SpawnedProcess, message: unknown): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`)
}

function osListing(): RawListing {
  const runQuery = createQueryRunner()
  if (PLATFORM === 'win32') return createWin32Listing({ runQuery, env: process.env })
  const currentUid = process.getuid?.() ?? null
  if (PLATFORM === 'darwin') return createDarwinListing({ runQuery, currentUid })
  return createLinuxListing({
    currentUid,
    readText: (path) => readFile(path, 'utf8'),
    listDir: (path) => readdir(path),
    readLink: (path) => readlink(path)
  })
}

describe('the dwarfai-mcp relay process (ADR-013 item 3)', () => {
  it("[ADR-013, C-15] a relay process started with the entry's env completes tools/list against a real MCP endpoint, and the credential never appears in its command line as listed by the OS", async () => {
    const { root, hostDataDir, providerEnv } = freshRoot()
    const credential = randomBytes(32).toString('hex')
    const written = await new RunDirCredentialFileStore({ hostDataDir }).write(LAUNCH, credential)
    if (!written.ok) throw new Error(`no credential file: ${String(written.error)}`)
    await serveEndpoint(await endpointPath(hostDataDir, root), credential)

    const relay = startRelay(written.value.path, providerEnv, root)
    send(relay.child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'provider', version: '1.0.0' }
      }
    })
    const initialized = await relay.answer(1)
    expect(initialized['result']).toMatchObject({
      serverInfo: { name: 'dwarfai-miners-jev-delegation' }
    })
    send(relay.child, { jsonrpc: '2.0', method: 'notifications/initialized' })
    send(relay.child, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (await relay.answer(2))['result'] as { tools: Array<{ name: string }> }
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'delegate_subtask',
      'subtask_result'
    ])

    // The relay is running: its command line as the OS lists it holds no credential.
    const listed = await osListing()(['dwarfai-mcp'])
    if (!listed.ok) throw new Error(`no listing: ${listed.cause}`)
    const relayRows = listed.value.filter((row) =>
      row.argv.some((arg) => arg.endsWith('dwarfai-mcp.js'))
    )
    expect(relayRows.length, 'the relay is listed with its argv').toBeGreaterThan(0)
    for (const row of relayRows) {
      expect(row.argv.join(' ')).not.toContain(credential)
      expect(row.executable ?? '').not.toContain(credential)
    }
    expect(relay.stdout()).not.toContain(credential)

    relay.child.stdin?.end()
    expect((await relay.child.exited).code).toBe(0)
  }, 120_000)

  it('[FM-039] a relay started from a missing credential file exits non-zero, writes nothing to stdout and one shim- segment without the credential', async () => {
    const { root, hostDataDir, providerEnv } = freshRoot()
    const credential = randomBytes(32).toString('hex')
    const store = new RunDirCredentialFileStore({ hostDataDir })
    const written = await store.write(LAUNCH, credential)
    if (!written.ok) throw new Error(`no credential file: ${String(written.error)}`)
    // The session ended: its file was deleted (ADR-013 item 3), the provider restarts the relay.
    await store.remove(LAUNCH)
    expect(existsSync(written.value.path)).toBe(false)

    const relay = startRelay(written.value.path, providerEnv, root)
    const exited = await relay.child.exited
    expect(exited.code).not.toBe(0)
    expect(relay.stdout()).toBe('')

    const logs = join(root, 'DwarfAI-test', 'logs')
    const segments = readdirSync(logs)
    expect(segments).toEqual(['shim-000001.jsonl'])
    const line = readFileSync(join(logs, 'shim-000001.jsonl'), 'utf8')
    expect(line).not.toContain(credential)
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      proc: 'shim',
      event: 'mcp.relay.failed',
      subsystem: 'mcp-relay',
      causeClass: 'credential-unreadable',
      launchId: LAUNCH
    })
  }, 120_000)
})
