#!/usr/bin/env node
/**
 * Opt-in smoke test for MCP subtask delegation (#511 T4).
 *
 * NOT run by this project's CI, NOT run by any agent working this issue, and
 * NOT a vitest suite (it is `delegation.mjs`, not `delegation.test.mjs`, so
 * `vitest run` never picks it up) — it launches REAL agent CLIs, which is
 * exactly the thing every unit test in this repository refuses to do. Run it
 * yourself, by hand, when you actually want to know whether a real
 * installed CLI exposes the delegation tool to its model:
 *
 *     pnpm build   # out/main/jevMcpServer.mjs must exist and be current
 *     node scripts/smoke/delegation.mjs
 *
 * ## What it proves, and what it does not
 *
 * For each of `claude`, `opencode` and `codex` that is actually installed on
 * this machine, it launches ONE short, low-cost turn with the real
 * delegation server injected exactly the way `delegationInjection.ts` builds
 * it for a detached launch, pointed at a tiny fake `/delegate` endpoint this
 * script hosts on loopback instead of the real `DelegationService`. The
 * prompt asks the model to call `delegate_subtask` once and stop. PASS means
 * the fake endpoint actually received that POST — i.e. the CLI registered
 * the server AND exposed its tool to the model, which is the exact fact
 * `codex … mcp list` (the feature document's own 2026-09-23 measurement)
 * could not answer for Codex's `-c`-registered servers. FAIL means the
 * process ran but never called it (or the call malformed); SKIPPED means the
 * CLI itself is not on this machine's PATH.
 *
 * It proves nothing about `subtask_result`, about a real child launch
 * actually completing (the fake endpoint answers `done` immediately, never
 * routing to a real provider), or about the SDK-held Claude path
 * (`sdkHeldSession.ts`) — only the three detached, one-shot argv/env shapes
 * `launchInjection` below builds. Antigravity is not probed: it stays
 * excluded from delegation for a documented reason unrelated to this
 * measurement (`delegationGate.ts`'s own comment).
 *
 * Cheap on purpose: one short prompt per provider, the CLI's own cheapest
 * documented model/effort where this app already knows one exists (Claude's
 * `haiku` alias and `--effort low`; Codex's `model_reasoning_effort=low`).
 * OpenCode's own model ids are not verified anywhere in this codebase
 * (`launchTuning.ts`'s own comment), so this never guesses one — it runs on
 * whatever OpenCode's own default is.
 *
 * Every file this script writes lives under one `mkdtemp` directory, removed
 * in a `finally` block — never the mine/project convention this app's own
 * launches follow, and never anywhere outside the OS temp directory.
 *
 * ## Why the wire constants are duplicated here rather than imported
 *
 * No other `scripts/*.mjs` in this repository imports from `src/` — this one
 * doesn't either. Plain Node runs this file directly, with no TypeScript
 * loader wired up for scripts, so the handful of wire literals below are
 * copied from `src/main/mcp/delegationProtocol.ts` and
 * `src/main/mcp/delegationInjection.ts` by hand, on the same terms
 * `delegationServerProtocol.ts` already documents for its own duplicates.
 * `delegationInjection.test.ts` is what actually proves those two modules
 * agree with each other; this script only has to agree with the WIRE the
 * built `jevMcpServer.mjs` actually speaks, which is covered by
 * `delegationProtocol.test.ts` and this file's own `pnpm build` dependency.
 *
 * ## Windows fixes (#511 M2)
 *
 * An independent verifier found three bugs specific to this script, never
 * exercised by CI or by any agent working this issue because it never runs
 * automatically:
 *
 * 1. `claude`/`opencode`/`codex` install as `.cmd` shims on Windows, and a
 *    bare `spawn('claude', …)` cannot execute one — Windows' own
 *    `CreateProcess` needs a real `.exe`, so this ENOENTs even when the CLI
 *    IS installed. Fixed by checking each CLI's own existence on PATH
 *    (`commandExists`, PATH + PATHEXT on Windows) BEFORE ever spawning,
 *    rather than inferring "not installed" from a spawn failure — the same
 *    shim problem `src/main/platform/cliDetection.ts`'s `resolveProgram`
 *    solves for the real app, mirrored here only as an existence check
 *    (never that module's full shim-target resolution) since this script
 *    stays out of `src/` per this file's own top comment. `shell: true` on
 *    win32 then lets `cmd.exe` itself execute the resolved `.cmd`.
 * 2. Because SKIPPED used to be inferred from a spawn-level ENOENT, and that
 *    ENOENT fired for an INSTALLED CLI on Windows, this script always read
 *    "not installed" there and never actually measured anything — silently,
 *    since SKIPPED does not fail the exit code. Deciding SKIPPED up front
 *    means every spawn failure AFTER it is a genuine FAIL.
 * 3. `child.kill('SIGTERM')` does not kill a process TREE — OpenCode's own
 *    server detaches and keeps its port open past the CLI's own exit. Fixed
 *    by `killTree`: `taskkill /T /F` on Windows, a negative-pid process
 *    group signal (`detached: true` at spawn) on POSIX.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter as PATH_DELIMITER, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const SERVER_SCRIPT = join(PROJECT_ROOT, 'out', 'main', 'jevMcpServer.mjs')
const IS_WINDOWS = process.platform === 'win32'
/** Windows' own PATHEXT default — a locally installed CLI is one of these, never a bare extensionless file. */
const WINDOWS_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']

/* --- Wire literals, duplicated by hand — see this file's own top comment --- */
const DELEGATE_ROUTE = '/delegate'
const RESULT_ROUTE_PREFIX = '/result/'
const DELEGATION_TOKEN_HEADER = 'x-dwarfai-token'
const DELEGATION_ENDPOINT_ENV = 'DWARFAI_DELEGATION_ENDPOINT'
const DELEGATION_TOKEN_ENV = 'DWARFAI_DELEGATION_TOKEN'
const DELEGATE_SUBTASK_TOOL_NAME = 'delegate_subtask'
const SUBTASK_RESULT_TOOL_NAME = 'subtask_result'
const DELEGATION_SERVER_NAME = 'jev'
const ALLOWED_TOOLS = [
  `mcp__${DELEGATION_SERVER_NAME}__${DELEGATE_SUBTASK_TOOL_NAME}`,
  `mcp__${DELEGATION_SERVER_NAME}__${SUBTASK_RESULT_TOOL_NAME}`
]

/** How long one provider's whole turn may run before this script gives up on it. */
const PER_PROVIDER_TIMEOUT_MS = 45_000
/** The one instruction every provider is given, verbatim. */
const PROMPT =
  'Call the delegate_subtask tool right now with task set to "say hello" and ' +
  'nothing else in context. Do not do anything else, and do not explain ' +
  'yourself — just make the one tool call and stop.'

/**
 * A tiny stand-in for `DelegationService` (#511 T3), never the real one:
 * `POST /delegate` answers 202 with a ticket immediately, and `GET
 * /result/<ticket>` answers `done` immediately too, so a real provider is
 * never launched and this script's own cost stays one cheap turn per CLI.
 * The only thing this endpoint is FOR is recording whether the POST ever
 * arrived, and with what body.
 */
function startFakeDelegationEndpoint() {
  let received
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === DELEGATE_ROUTE) {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        received = { token: request.headers[DELEGATION_TOKEN_HEADER], body }
        response
          .writeHead(202, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ticket: 'smoke-ticket', routing: { provider: 'claude' } }))
      })
      return
    }
    if (request.method === 'GET' && (request.url ?? '').startsWith(RESULT_ROUTE_PREFIX)) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          status: 'done',
          outcome: { kind: 'concluded', text: 'smoke test delegation ok', endedAt: Date.now() }
        })
      )
      return
    }
    response.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        receivedDelegateCall: () => received,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

/** The delegation env every provider's own server entry carries — mirrors `delegationInjection.ts`'s `delegationEnv`. */
function delegationEnv(endpoint, token) {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    [DELEGATION_ENDPOINT_ENV]: endpoint,
    [DELEGATION_TOKEN_ENV]: token
  }
}

/** One provider's own launch: what to run, in what folder, on what stdin. */
async function buildLaunch(provider, workDir, endpoint, token) {
  const cwd = join(workDir, provider)
  await mkdir(cwd, { recursive: true })

  if (provider === 'claude') {
    const configPath = join(workDir, 'claude-mcp-config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [DELEGATION_SERVER_NAME]: {
            type: 'stdio',
            command: electronPath,
            args: [SERVER_SCRIPT],
            env: delegationEnv(endpoint, token)
          }
        }
      }),
      'utf8'
    )
    return {
      command: 'claude',
      args: [
        '-p',
        '--input-format',
        'text',
        '--model',
        'haiku',
        '--effort',
        'low',
        '--mcp-config',
        configPath,
        '--allowedTools',
        ...ALLOWED_TOOLS
      ],
      cwd
    }
  }

  if (provider === 'opencode') {
    return {
      command: 'opencode',
      args: ['run', '--format', 'json'],
      cwd,
      // #511 T4: no verified cheap OpenCode model id exists anywhere in this
      // codebase (`launchTuning.ts`'s own comment) — this never guesses one.
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            [DELEGATION_SERVER_NAME]: {
              type: 'local',
              command: [electronPath, SERVER_SCRIPT],
              environment: delegationEnv(endpoint, token),
              enabled: true
            }
          }
        })
      }
    }
  }

  // codex — the decisive measurement this script exists for: whether a
  // `-c`-registered server's TOOLS reach the model on `codex exec`, not
  // merely whether `codex … mcp list` shows it registered (already measured,
  // 2026-09-23, feature document).
  const env = delegationEnv(endpoint, token)
  const envToml = `{ ${Object.entries(env)
    .map(([key, value]) => `${key} = "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(', ')} }`
  const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return {
    command: 'codex',
    args: [
      'exec',
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.command=${quote(electronPath)}`,
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.args=[${quote(SERVER_SCRIPT)}]`,
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.env=${envToml}`,
      '-c',
      'model_reasoning_effort=low',
      '-'
    ],
    cwd
  }
}

/**
 * Whether `command` resolves to a real file on PATH (#511 M2) — checked
 * BEFORE spawning, so SKIPPED ("not installed") is decided by this app,
 * never inferred from a spawn-level `error` event. Windows needs the
 * PATHEXT search because a locally installed CLI is a `.cmd`/`.ps1` shim,
 * never a bare extensionless file — see this file's own top comment.
 */
async function commandExists(command) {
  const dirs = (process.env.PATH ?? '').split(PATH_DELIMITER).filter((dir) => dir !== '')
  const candidates = IS_WINDOWS ? WINDOWS_EXTENSIONS.map((ext) => command + ext) : [command]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      try {
        await access(join(dir, candidate), fsConstants.X_OK)
        return true
      } catch {
        // Not this directory/extension — keep looking.
      }
    }
  }
  return false
}

/**
 * Ends the WHOLE process tree a launch started, not just its own pid (#511
 * M2) — OpenCode's own server detaches and keeps its port open past the CLI
 * process's own exit, which a plain `child.kill()` never reaches. POSIX:
 * `spawnCli` below starts the child in its own process group (`detached:
 * true`), so a negative pid signals that whole group. Windows has no such
 * flag; `taskkill /T` walks the process tree itself.
 */
function killTree(child) {
  if (child.pid === undefined) return
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } catch {
      // Best-effort — nothing else to fall back to.
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone, or never got its own group.
  }
}

/**
 * `spawn`, resolved the way this app's own CLI detection has to resolve a
 * locally installed CLI on Windows (#511 M2) — `claude`/`opencode`/`codex`
 * install as `.cmd` shims there, and `CreateProcess` cannot execute one
 * directly; `shell: true` lets `cmd.exe` itself do that resolution. POSIX
 * needs neither: every one of these CLIs installs as a real executable
 * there, so this only changes Windows' own spawn shape.
 */
function spawnCli(command, args, options) {
  return spawn(command, args, {
    ...options,
    shell: IS_WINDOWS,
    ...(IS_WINDOWS ? {} : { detached: true })
  })
}

/** Runs one provider's launch and waits for either the fake endpoint's own POST or the timeout. */
function runProbe(launch) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (verdict, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      resolve({ verdict, detail })
    }

    let child
    try {
      child = spawnCli(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...(launch.env ?? {}) },
        stdio: ['pipe', 'ignore', 'pipe']
      })
    } catch (error) {
      finish('FAIL', `could not spawn: ${String(error)}`)
      return
    }

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    // #511 M2: SKIPPED is decided by `commandExists` in `main()`, BEFORE
    // this function is ever called — this CLI is already known installed,
    // so an `error` event reaching here is a genuine spawn failure, never
    // "not on PATH".
    child.once('error', (error) => {
      finish('FAIL', `spawn error: ${String(error)}`)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(PROMPT)

    const timer = setTimeout(() => {
      finish(
        'FAIL',
        `timed out after ${PER_PROVIDER_TIMEOUT_MS}ms; stderr tail: ${stderr.slice(-400)}`
      )
    }, PER_PROVIDER_TIMEOUT_MS)
    timer.unref?.()

    child.once('exit', () => {
      // The child ending is not itself the verdict — `main()` checks the
      // fake endpoint's own record after this promise settles, since the
      // POST can only be observed from outside the child's own process.
      finish('EXITED', `stderr tail: ${stderr.slice(-400)}`)
    })
  })
}

function printTable(rows) {
  const widest = Math.max(...rows.map((row) => row.provider.length))
  console.log('')
  console.log('Provider'.padEnd(widest + 2) + 'Result   Detail')
  console.log('-'.repeat(widest + 2 + 9 + 40))
  for (const row of rows) {
    console.log(`${row.provider.padEnd(widest + 2)}${row.verdict.padEnd(9)}${row.detail}`)
  }
  console.log('')
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'dwarfai-delegation-smoke-'))
  const endpoint = await startFakeDelegationEndpoint()
  const results = []
  try {
    for (const provider of ['claude', 'opencode', 'codex']) {
      // #511 M2: decided BEFORE spawning anything, never inferred from a
      // spawn-level error — see commandExists's own comment for why.
      if (!(await commandExists(provider))) {
        results.push({ provider, verdict: 'SKIPPED', detail: `${provider} is not on PATH` })
        continue
      }
      const token = `smoke-${provider}-${randomUUID()}`
      const launch = await buildLaunch(provider, workDir, endpoint.endpoint, token)
      const outcome = await runProbe(launch)
      const received = endpoint.receivedDelegateCall()

      if (received !== undefined && received.token === token) {
        results.push({
          provider,
          verdict: 'PASS',
          detail: `delegate_subtask reached the fake endpoint (body: ${received.body.slice(0, 80)})`
        })
        continue
      }
      results.push({
        provider,
        verdict: 'FAIL',
        detail: `no delegate_subtask call observed — ${outcome.detail}`
      })
    }
  } finally {
    await endpoint.close()
    await rm(workDir, { recursive: true, force: true })
  }

  printTable(results)
  process.exitCode = results.some((row) => row.verdict === 'FAIL') ? 1 : 0
}

main().catch((error) => {
  console.error('[smoke] delegation smoke test failed to run at all:', error)
  process.exitCode = 1
})
