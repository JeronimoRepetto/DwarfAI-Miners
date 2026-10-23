/**
 * The demo's `claude`: a stub CLI that speaks Claude Code's stream-json the way the E2E lane's interactive stub does
 * (`e2e/cut-3a/claudeStreamStub.mjs`, which this one follows line for line where they overlap), but plays a scripted
 * turn per prompt (`scenario.mjs` BEHAVIORS, read from `script.json` in its world folder): one reported tool step every
 * `stepMs`, then the scripted ask, then the reply, each assistant message with its usage so the mine earns ore. It holds
 * no provider code, reads no credential and opens no network connection (ADR-008): it only writes stream-json lines.
 *
 * - `--version` and the `--help` probe are the stub kit's answers (`fixtures/bin/_kit`), so detection and the probe see
 *   exactly what the E2E lane's stub shows them.
 * - `-p … --session-id <id>` (a launch) or `--resume <id>`: one record per stdout line; `system/init` after the first
 *   stdin line; each user line one turn ending in a `result` line.
 * - A permission ask is the permission prompt tool `mcp__dwarfai__permission` called on the relay entry of the
 *   `--mcp-config` file (SP-08), as Claude Code calls it; the person's answer picks the reply.
 * - stdin's end ends the stub at once, mid-turn included: Stop dwarf never waits for a scripted turn to finish.
 *
 * The world folder is made by `install.mjs`; its `claude.mjs` entry calls {@link runClaudeDemoStub} with that folder.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { playStub } from '../../../fixtures/bin/_kit/stubCli.mjs'
import { behaviorFor } from './behavior.mjs'

/** The kit script whose `--version` and `--help` answers this stub gives. */
const KIT_SCRIPT = 'claude-stream-json-simple-turn'

/** The MCP server name of the relay entry (`argv.ts` PERMISSION_SERVER) and the prompt tool it serves. */
const SERVER = 'dwarfai'
const PERMISSION_TOOL = 'permission'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function optionValue(argv, flag) {
  const at = argv.indexOf(flag)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}

/** The scripted turns of this world (`script.json`), or null. */
export function readScript(worldDir) {
  const file = path.join(worldDir, 'script.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
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

/** The tool input Claude Code would send for one scripted step. */
function toolInput(step) {
  switch (step.tool) {
    case 'Read':
      return { file_path: step.target }
    case 'Grep':
      return { pattern: step.target, output_mode: 'files_with_matches' }
    case 'Edit':
      return { file_path: step.target, old_string: '…', new_string: '…' }
    case 'Write':
      return { file_path: step.target, content: '// fictional demo content\n' }
    default:
      return { command: step.target, description: `Run ${step.target}` }
  }
}

/** A short, fictional tool result for one scripted step. */
function toolResult(step) {
  switch (step.tool) {
    case 'Read':
      return `     1\t// ${step.target}\n     2\texport {}\n`
    case 'Grep':
      return `Found 2 files\nsrc/${step.target}.ts\nsrc/index.ts`
    case 'Bash':
      return '✓ done (fictional demo output)'
    default:
      return `The file ${step.target} has been updated.`
  }
}

/** A stdio MCP client of the relay entry the `--mcp-config` file names (ADR-013 item 3), as the E2E stub's. */
function relayClient(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const server = config?.mcpServers?.[SERVER]
  if (server === undefined || typeof server.command !== 'string') {
    throw new Error(`the --mcp-config file names no ${SERVER} server`)
  }
  const inherited = { ...process.env }
  delete inherited.XDG_RUNTIME_DIR
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    env: { ...inherited, ...(server.env ?? {}) },
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

/** The prompt tool's decision (`permissionPrompt.ts`); anything else denies. */
function decisionOf(answer) {
  const text = answer?.result?.content?.find?.((block) => block?.type === 'text')?.text
  if (typeof text !== 'string') return 'deny'
  try {
    return JSON.parse(text)?.behavior === 'allow' ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}

/**
 * The session's transcript, as Claude Code keeps one: `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<sessionId>.jsonl`,
 * one record per line in the shape of `fixtures/claude/observer/2.1.x`. The Host credits a launched dwarf's ore from its
 * transcript (`crew/domain/dwarf.ts` usagePath), so the stub writes one; only under `CLAUDE_CONFIG_DIR`, which the Host
 * hands the child (`providerEnvVars`) and which the demo points inside its profile. Without it nothing is written.
 */
function transcriptWriter(sessionId) {
  const home = process.env.CLAUDE_CONFIG_DIR
  if (home === undefined || home === '') return () => {}
  const cwd = process.cwd()
  const folder = path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const file = path.join(folder, `${sessionId}.jsonl`)
  let parentUuid = null
  return (record) => {
    const line = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: '2.1.301',
      gitBranch: 'main',
      type: record.type,
      message: record.message,
      uuid: record.uuid ?? randomUUID(),
      timestamp: new Date().toISOString()
    }
    parentUuid = line.uuid
    try {
      mkdirSync(folder, { recursive: true })
      appendFileSync(file, `${JSON.stringify(line)}\n`)
    } catch {
      // A transcript that cannot be written only costs the mine its ore.
    }
  }
}

/** One stream-json session, until stdin ends. */
function runSession(worldDir, argv) {
  const resumed = optionValue(argv, '--resume')
  const sessionId = optionValue(argv, '--session-id') ?? resumed ?? randomUUID()
  const script = readScript(worldDir)
  const transcribe = transcriptWriter(sessionId)
  const emit = (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`)
    if (record.type === 'assistant' || record.type === 'user') transcribe(record)
  }
  let messages = 0
  let turns = 0
  let relay = null

  const assistant = (content, stopReason, tokens) => {
    messages += 1
    return {
      type: 'assistant',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: `msg_demo_${String(messages).padStart(4, '0')}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-demo',
        content,
        stop_reason: stopReason,
        usage: { input_tokens: tokens, output_tokens: Math.round(tokens / 8) }
      }
    }
  }
  const toolResultLine = (toolUseId, content, isError) => ({
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
    }
  })

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

  async function turn(record) {
    const text = textOf(record.message?.content)
    turns += 1
    // The person's line under the uuid the driver sent, as Claude Code keeps it: the Host matches the two.
    transcribe({ type: 'user', uuid: record.uuid, message: record.message })
    const behavior = behaviorFor(script, text)
    // Each assistant message is one usage unit the Host credits on its own (ADR-006 item 4).
    const share = Math.max(1, behavior.tokens)
    for (const [index, step] of behavior.steps.entries()) {
      await pause(behavior.stepMs)
      const id = `toolu_demo_${turns}_${index}`
      emit(
        assistant(
          [{ type: 'tool_use', id, name: step.tool, input: toolInput(step) }],
          'tool_use',
          share
        )
      )
      emit(toolResultLine(id, toolResult(step), false))
    }
    let reply = behavior.reply
    if (behavior.ask?.kind === 'permission') {
      await pause(Math.min(behavior.stepMs, 2_000))
      const id = `toolu_demo_${turns}_ask`
      const input = toolInput({ tool: behavior.ask.tool, target: behavior.ask.target })
      emit(assistant([{ type: 'tool_use', id, name: behavior.ask.tool, input }], 'tool_use', share))
      const decision = await permission({ tool_name: behavior.ask.tool, input, tool_use_id: id })
      emit(
        toolResultLine(
          id,
          decision === 'allow' ? 'File created successfully.' : 'Permission denied.',
          decision !== 'allow'
        )
      )
      if (decision !== 'allow') reply = behavior.replyDenied ?? reply
    }
    await pause(Math.min(behavior.stepMs, 1_500))
    emit(assistant([{ type: 'text', text: reply }], 'end_turn', share))
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reply,
      stop_reason: 'end_turn',
      session_id: sessionId,
      uuid: randomUUID()
    })
  }

  const queue = []
  let busy = false
  let initSent = false
  const finish = () => {
    relay?.dispose()
    process.exit(0)
  }
  async function drain() {
    if (busy) return
    busy = true
    while (queue.length > 0) {
      let record
      try {
        record = JSON.parse(queue.shift())
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
          tools: ['Read', 'Grep', 'Edit', 'Write', 'Bash'],
          mcp_servers: [{ name: SERVER, status: 'connected' }],
          model: 'claude-demo',
          permissionMode: optionValue(argv, '--permission-mode') ?? 'default',
          uuid: randomUUID()
        })
      }
      await turn(record)
    }
    busy = false
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    queue.push(line)
    void drain()
  })
  lines.on('close', finish)
}

/** Runs the stub for `argv` in `worldDir`: a session for a `-p` run, the kit's answers for anything else. */
export function runClaudeDemoStub(worldDir, argv = process.argv.slice(2)) {
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
