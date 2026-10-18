/**
 * The interactive `StubClaudeCli` of the step-3a L9 cases (testing strategy `17` §1.9; ISSUE-001): the `claude` the
 * Host's `ClaudeStreamJsonDriver` (`15` §4.2) launches, sends to, asks through and stops. It holds no provider code and
 * makes no network call (ADR-008): it speaks Claude Code's stream-json the way the recorded fixtures of
 * `fixtures/claude/stream-json/2.1.x` show it (S-020-1, SP-08, SP-15), one turn per stdin user line.
 *
 * Why a stub of its own: the kit's `fixtures/bin/claude` stub replays a fixture and reads no stdin, so it cannot hold a
 * session over several turns nor call the permission prompt tool. This one keeps the kit for everything that is not a
 * session (`--version`, the `--help` probe, through the kit's own engine `playStub`, so detection and the probe see
 * exactly the kit's answers) and adds the session:
 *
 * - `-p … --session-id <id>` (a launch) or `--resume <id>` (a resume): stdout carries stream-json, one record per line.
 *   `system/init` comes after the first stdin line only (S-020-1); then each user line is one turn ending in a
 *   `result` line (`success`).
 * - A turn whose text names {@link ASK_MARKER} uses one tool, Write: the assistant's `tool_use` line, then the
 *   permission prompt tool `mcp__dwarfai__permission` is called as Claude Code calls it (SP-08): the relay entry of the
 *   `--mcp-config` file is started as a stdio MCP server, and `tools/call` `permission` carries `tool_name`, `input` and
 *   `tool_use_id`. The person's answer decides the tool result and the reply ({@link REPLIES}). Nothing is written to
 *   disk for the tool: the stub only reports.
 * - stdin's end ends the session (the driver's `close('end-thread')`), as it ends Claude Code's.
 * - Each session run writes `runs/<pid>.json` (pid, kind, session id) into its world folder, so a case can name the
 *   process the Host launched without asking the Host for it. The world's `world.json` may refuse resumes
 *   (`{ "resume": "refuse" }`): a resume run then writes an error `result` before any `system/init` and exits 1, the
 *   recorded shape of a failing start (S-020-1), so a Host restart cannot bring the session back.
 *
 * The world folder is made by `claudeStreamWorld.ts`; its `claude.mjs` entry calls {@link runClaudeStreamStub} with
 * that folder. The provider child's environment is the Host's allowlist (`15` §4 `childEnv`), so the world is found by
 * the entry's own location, never by a variable.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { playStub } from '../../fixtures/bin/_kit/stubCli.mjs'

/** The kit script whose `--version` and `--help` answers this stub gives (Claude Code 2.1.301, SP-08's help). */
export const KIT_SCRIPT = 'claude-stream-json-simple-turn'

/** A turn whose text holds this asks for the Write tool, through the permission prompt tool. */
export const ASK_MARKER = 'marker file'

/** The dwarf's replies, so a case can tell which turn the stub answered and how. */
export const REPLIES = Object.freeze({
  first: 'Hello from the stub session.',
  plain: 'Noted.',
  allowed: 'The marker file is written.',
  denied: 'The marker file was not written.'
})

/** The MCP server name of the relay entry (`argv.ts` PERMISSION_SERVER) and the prompt tool it serves. */
const SERVER = 'dwarfai'
const PERMISSION_TOOL = 'permission'

function optionValue(argv, flag) {
  const at = argv.indexOf(flag)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}

function readWorld(worldDir) {
  const file = path.join(worldDir, 'world.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** The text of a stream-json user line's content: a string, or its text blocks. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/**
 * A stdio MCP client of the relay entry the `--mcp-config` file names (ADR-013 item 3): newline-delimited JSON-RPC, as
 * the relay moves it (`relayMain.ts` item 3). Started on the first prompt-tool call, as Claude Code starts its MCP
 * servers before it needs them.
 */
function relayClient(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const server = config?.mcpServers?.[SERVER]
  if (server === undefined || typeof server.command !== 'string') {
    throw new Error(`the --mcp-config file names no ${SERVER} server`)
  }
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  })
  const pending = new Map()
  let nextId = 1
  let buffered = ''
  const failAll = (message) => {
    for (const settle of pending.values()) settle({ error: { message } })
    pending.clear()
  }
  child.on('error', (error) => failAll(`the relay did not start: ${error.message}`))
  child.on('exit', () => failAll('the relay exited'))
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end).trim()
      buffered = buffered.slice(end + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const settle = message?.id === undefined ? undefined : pending.get(message.id)
      if (settle !== undefined) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      send({ id, method, params })
    })
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '2.1.301' }
  }).then(() => {
    send({ method: 'notifications/initialized' })
    return request('tools/list', {})
  })
  return {
    async call(name, args) {
      await ready
      return request('tools/call', { name, arguments: args })
    },
    dispose() {
      child.stdin.end()
      if (child.exitCode === null) child.kill()
    }
  }
}

/** The prompt tool's decision (`permissionPrompt.ts`: `{ behavior: 'allow' | 'deny', … }`); anything else denies. */
function decisionOf(answer) {
  const text = answer?.result?.content?.find?.((block) => block?.type === 'text')?.text
  if (typeof text !== 'string') return 'deny'
  try {
    return JSON.parse(text)?.behavior === 'allow' ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}

/** One stream-json session of the stub, until stdin ends. */
function runSession(worldDir, argv) {
  const resumed = optionValue(argv, '--resume')
  const sessionId = optionValue(argv, '--session-id') ?? resumed ?? randomUUID()
  const runs = path.join(worldDir, 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(
    path.join(runs, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, kind: resumed === null ? 'launch' : 'resume', sessionId })
  )
  const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
  const result = (subtype, isError, text) => ({
    type: 'result',
    subtype,
    is_error: isError,
    result: text,
    stop_reason: isError ? null : 'end_turn',
    session_id: sessionId,
    uuid: randomUUID()
  })

  if (resumed !== null && readWorld(worldDir).resume === 'refuse') {
    process.stdout.write(
      `${JSON.stringify(result('error_during_execution', true, 'No conversation found.'))}\n`,
      () => process.exit(1)
    )
    return
  }

  let messages = 0
  let turns = 0
  let relay = null
  const assistant = (content, stopReason) => {
    messages += 1
    return {
      type: 'assistant',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: `msg_stub_${String(messages).padStart(4, '0')}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-stub',
        content,
        stop_reason: stopReason,
        usage: { input_tokens: 3, output_tokens: 2 }
      }
    }
  }

  async function permission(call) {
    const configPath = optionValue(argv, '--mcp-config')
    if (configPath === null) return 'deny'
    try {
      relay ??= relayClient(configPath)
      return decisionOf(await relay.call(PERMISSION_TOOL, call))
    } catch {
      return 'deny'
    }
  }

  async function turn(text) {
    turns += 1
    if (!text.includes(ASK_MARKER)) {
      const reply = turns === 1 ? REPLIES.first : REPLIES.plain
      emit(assistant([{ type: 'text', text: reply }], 'end_turn'))
      emit(result('success', false, reply))
      return
    }
    const toolUseId = `toolu_stub_${String(turns).padStart(4, '0')}`
    const input = { file_path: 'marker.txt', content: 'marker' }
    emit(assistant([{ type: 'tool_use', id: toolUseId, name: 'Write', input }], 'tool_use'))
    const decision = await permission({ tool_name: 'Write', input, tool_use_id: toolUseId })
    emit({
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: decision === 'allow' ? 'File created successfully.' : 'Permission denied.',
            is_error: decision !== 'allow'
          }
        ]
      }
    })
    const reply = decision === 'allow' ? REPLIES.allowed : REPLIES.denied
    emit(assistant([{ type: 'text', text: reply }], 'end_turn'))
    emit(result('success', false, reply))
  }

  const queue = []
  let busy = false
  let closed = false
  let initSent = false
  const finish = () => {
    relay?.dispose()
    process.exit(0)
  }
  async function drain() {
    if (busy) return
    busy = true
    while (queue.length > 0) {
      const line = queue.shift()
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.type !== 'user') continue
      if (!initSent) {
        initSent = true
        emit({
          type: 'system',
          subtype: 'init',
          cwd: process.cwd(),
          session_id: sessionId,
          tools: ['Write'],
          mcp_servers: [{ name: SERVER, status: 'connected' }],
          model: 'claude-stub',
          permissionMode: optionValue(argv, '--permission-mode') ?? 'default',
          uuid: randomUUID()
        })
      }
      await turn(textOf(record.message?.content))
    }
    busy = false
    if (closed) finish()
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    queue.push(line)
    void drain()
  })
  lines.on('close', () => {
    closed = true
    if (!busy) finish()
  })
}

/**
 * Runs the stub for `argv` in `worldDir`: a session for a `-p` run, the kit's answers for anything else (`--version`,
 * the `--help` probe).
 */
export function runClaudeStreamStub(worldDir, argv = process.argv.slice(2)) {
  if (argv.includes('-p') && !argv.includes('--help')) {
    runSession(worldDir, argv)
    return
  }
  const run = playStub({
    name: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultScript: KIT_SCRIPT,
    argv,
    env: { ...process.env, DWARFAI_STUB_CLAUDE_SCRIPT: '' }
  })
  if (run.stdout !== '') process.stdout.write(run.stdout)
  if (run.stderr !== '') process.stderr.write(run.stderr)
  process.exitCode = run.exitCode
}
