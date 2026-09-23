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
 *    (PATH + PATHEXT on Windows) BEFORE ever spawning, rather than inferring
 *    "not installed" from a spawn failure — the same shim problem
 *    `src/main/platform/cliDetection.ts`'s `resolveProgram` solves for the
 *    real app. AMENDED below (#511, Codex smoke measurement) for what that
 *    existence check did next.
 * 2. Because SKIPPED used to be inferred from a spawn-level ENOENT, and that
 *    ENOENT fired for an INSTALLED CLI on Windows, this script always read
 *    "not installed" there and never actually measured anything — silently,
 *    since SKIPPED does not fail the exit code. Deciding SKIPPED up front
 *    means every spawn failure AFTER it is a genuine FAIL.
 * 3. `child.kill('SIGTERM')` does not kill a process TREE — OpenCode's own
 *    server detaches and keeps its port open past the CLI's own exit. Fixed
 *    by `killTree`: `taskkill /T /F` on Windows, a negative-pid process
 *    group signal (`detached: true` at spawn) on POSIX.
 *
 * ## AMENDED: `shell: true` was itself a fourth bug (#511, 2026-09-23)
 *
 * The existence check above used to hand the resolved `.cmd` path straight
 * to `spawn` with `shell: true` on win32, trusting `cmd.exe` to execute the
 * shim. A real run measured that this breaks Codex specifically: Node
 * concatenates a `shell: true` spawn's `command` and `args` into ONE string
 * before handing it to `cmd.exe` (Node ≥ 20 prints `DEP0190` for exactly
 * this), and `cmd.exe` then re-parses that string itself — splitting a
 * quoted `-c mcp_servers.jev.command="..."` value on the `=` `cmd.exe` never
 * knew was inside a quoted argument. The observed failure was Codex's own
 * `error: unexpected argument '=' found`, before the CLI ever got to reject
 * or accept an MCP call. Claude and OpenCode passed only because neither
 * one's own argv contains a `-c key=value` pair for `cmd.exe` to mis-split.
 *
 * `shell` is therefore never passed to `spawn` any more (`spawnCli`) — never
 * `true` on any platform. In its place, `resolveCliProgram` reads a Windows
 * `.cmd`/`.bat` shim for the program it actually runs, exactly as
 * `src/main/platform/cliDetection.ts`'s own `resolveShimTarget` does for the
 * real app (`resolveShim` below is a hand-duplicated subset of it — see the
 * top-of-file comment on why nothing here imports from `src/`), and spawns
 * that program (or `node <entry.js>`) directly. `args` then reach the CLI
 * exactly as this script built them, on every platform, the same guarantee
 * `buildLaunchSpawn`'s own "No `shell`, ever" already holds for the real app.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
/**
 * The one instruction every provider is given, verbatim.
 *
 * It names the tool as an MCP tool on purpose. Measured on 2026-09-23 with
 * codex-cli 0.153.4: a direct run with this exact wording called the tool,
 * while "Call the delegate_subtask tool …" with everything else identical
 * made no tool call at all. So a FAIL here would otherwise measure the
 * prompt, not whether the tool reached the model.
 */
const PROMPT =
  'Call the MCP tool delegate_subtask right now with task set to "say hello" and ' +
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

/**
 * One provider's own launch: what to run, in what folder, on what stdin.
 *
 * `program` is this CLI's own resolved, directly spawnable command
 * (`resolveCliProgram`) — never a bare name handed to a shell any more (see
 * this file's own top comment on the #511 fix). Its `prefixArgs` (empty for
 * a real executable; `[<entry.js>]` for a Windows npm/pnpm node-entry shim)
 * lead every provider's own argv below, exactly the way `buildLaunchSpawn`'s
 * `CONSOLE_HOSTING_PROGRAM` leads the real app's argv for the same shim
 * shape.
 */
async function buildLaunch(provider, workDir, endpoint, token, program) {
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
      command: program.command,
      args: [
        ...program.prefixArgs,
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
      command: program.command,
      args: [...program.prefixArgs, 'run', '--format', 'json'],
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
  // merely whether `codex … mcp list` shows it registered. Measured
  // 2026-09-23 (feature document): registration alone reached the model's
  // tool list but the CALL itself needed the two `approval_mode="approve"`
  // overrides below — `mcp_servers.jev.tools.<tool>.approval_mode`, per
  // tool rather than server-wide, mirroring
  // `codexDelegationConfigArgs`'s own comment (delegationInjection.ts) for
  // the source citation. `--skip-git-repo-check` is added here, and ONLY
  // here — never in `buildCodexLaunchArgs` (launch.ts), which deliberately
  // leaves a real launch's own refusal to Codex — because this script's
  // `cwd` is a fresh `mkdtemp` directory, never a Git repository, and
  // without it Codex declines to run at all before it ever reaches the tool
  // call this script exists to observe.
  const env = delegationEnv(endpoint, token)
  const envToml = `{ ${Object.entries(env)
    .map(([key, value]) => `${key} = "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(', ')} }`
  const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const toolApproval = (tool) => [
    '-c',
    `mcp_servers.${DELEGATION_SERVER_NAME}.tools.${tool}.approval_mode=${quote('approve')}`
  ]
  return {
    command: program.command,
    args: [
      ...program.prefixArgs,
      'exec',
      '--skip-git-repo-check',
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.command=${quote(electronPath)}`,
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.args=[${quote(SERVER_SCRIPT)}]`,
      '-c',
      `mcp_servers.${DELEGATION_SERVER_NAME}.env=${envToml}`,
      ...toolApproval(DELEGATE_SUBTASK_TOOL_NAME),
      ...toolApproval(SUBTASK_RESULT_TOOL_NAME),
      '-c',
      'model_reasoning_effort=low',
      '-'
    ],
    cwd
  }
}

/** Whether `path` names a `.cmd`/`.bat` shim rather than a real executable — mirrors `src/main/sessionLaunch/launch.ts`'s `isShellShim`, duplicated here on the same terms this file's own top comment already gives for the wire literals. */
function isShellShim(path) {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

/** Whether a path exists at all, swallowing the one error that means it does not. */
async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a path exists AND is executable — the same `X_OK` check the
 * pre-#511 `commandExists` used for every PATH candidate, kept for the POSIX
 * walk below so a same-named, non-executable file on PATH still does not
 * masquerade as the CLI (`X_OK` is effectively `F_OK` on Windows, which has
 * no such permission bit to check, so the Windows walk uses `pathExists`
 * instead and reads shim CONTENT to tell a real binary from a wrapper).
 */
async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Reads a `.cmd`/`.bat` shim for the program it actually runs (#511, the
 * `shell: true` fix — see this file's own top comment) — a hand-duplicated
 * subset of `src/main/platform/cliDetection.ts`'s own `resolveShimTarget`,
 * never imported (this file's top comment covers why nothing here imports
 * from `src/`). Covers the same two dialects that resolver does: an npm/pnpm
 * shim quoting a `.js` entry, run with the `node.exe` beside the shim if one
 * exists else `node` from PATH, and a shim quoting a native `.exe`/`.com`
 * program directly (`src/main/platform/cliDetection.ts`'s own #544 case,
 * e.g. `opencode-ai`'s compiled binary). Answers `undefined` when the shim
 * names neither, or when its entry still carries an unexpanded `%variable%`
 * only `cmd.exe` could resolve — this script then treats that CLI the same
 * as not found, rather than guessing at a shell it no longer spawns through.
 */
async function resolveShim(shimPath) {
  const shimDir = dirname(shimPath)
  const text = await readFile(shimPath, 'utf8')
  const expand = (quoted) => quoted.replace(/%~dp0|%dp0%/gi, `${shimDir}\\`)

  const script = /"([^"]+\.js)"/i.exec(text)
  if (script) {
    const entry = expand(script[1])
    if (entry.includes('%')) return undefined
    const bundledNode = join(shimDir, 'node.exe')
    const command = (await pathExists(bundledNode)) ? bundledNode : 'node'
    return { command, prefixArgs: [entry] }
  }
  const native = /"([^"]+\.(?:exe|com))"/i.exec(text)
  if (native) {
    const program = expand(native[1])
    if (program.includes('%')) return undefined
    return { command: program, prefixArgs: [] }
  }
  return undefined
}

/**
 * Resolves `command` to a directly spawnable program — `{ command,
 * prefixArgs }`, or `undefined` for "not on PATH" (SKIPPED, unchanged from
 * before #511 M2). Checked BEFORE spawning, so SKIPPED is decided by this
 * script, never inferred from a spawn-level `error` event.
 *
 * POSIX installs every one of these CLIs as a real executable, so a bare
 * PATH walk is enough. Windows needs the PATHEXT search because a locally
 * installed CLI is commonly a `.cmd`/`.bat` shim rather than a bare
 * extensionless file, and — since the #511 fix — that shim is now READ and
 * resolved to what it actually runs (`resolveShim`) rather than handed to
 * `cmd.exe` via `shell: true`, which is the bug this file's own top comment
 * documents at length. A shim whose dialect `resolveShim` cannot read is
 * skipped and the walk continues, the same "skip and keep looking"
 * discipline `src/main/platform/cliDetection.ts`'s own detector holds for a
 * wrapper it cannot run either.
 */
async function resolveCliProgram(command) {
  const dirs = (process.env.PATH ?? '').split(PATH_DELIMITER).filter((dir) => dir !== '')
  if (!IS_WINDOWS) {
    for (const dir of dirs) {
      const candidate = join(dir, command)
      if (await isExecutable(candidate)) return { command: candidate, prefixArgs: [] }
    }
    return undefined
  }
  for (const dir of dirs) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const candidate = join(dir, command + ext)
      if (!(await pathExists(candidate))) continue
      if (!isShellShim(candidate)) return { command: candidate, prefixArgs: [] }
      const resolved = await resolveShim(candidate)
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
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
 * `spawn`, with `command`/`args` already resolved to a directly spawnable
 * program by `resolveCliProgram` (#511) — never a shell, on any platform.
 * See this file's own top comment for why `shell: true` used to sit here
 * and what it broke for Codex specifically. `detached: true` on POSIX is
 * unrelated to that fix and unchanged: it puts the child in its own process
 * group so `killTree` can signal the whole group, never only the CLI's own
 * pid.
 */
function spawnCli(command, args, options) {
  return spawn(command, args, {
    ...options,
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
    // #511 M2: SKIPPED is decided by `resolveCliProgram` in `main()`, BEFORE
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
      // spawn-level error — see resolveCliProgram's own comment for why.
      const program = await resolveCliProgram(provider)
      if (program === undefined) {
        results.push({ provider, verdict: 'SKIPPED', detail: `${provider} is not on PATH` })
        continue
      }
      const token = `smoke-${provider}-${randomUUID()}`
      const launch = await buildLaunch(provider, workDir, endpoint.endpoint, token, program)
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
