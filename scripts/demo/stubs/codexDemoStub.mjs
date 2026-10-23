/**
 * The demo's `codex`: a stub CLI that speaks `codex app-server`'s JSON-RPC over stdio the way the E2E lane's stub does
 * (`e2e/cut-3b/codexAppServerStub.mjs`, followed where they overlap), but plays a scripted turn per prompt
 * (`scenario.mjs` BEHAVIORS, read from `script.json` in its world folder): one `commandExecution` item every `stepMs`,
 * then the scripted ask, then the reply, with the thread's token usage so the mine earns ore. It holds no provider
 * code, reads no credential and opens no network connection (ADR-008).
 *
 * - `--version` and `--help`: the recorded 0.153.4 answers, so detection and the probe offer the app-server launch.
 * - A question is the server request `item/tool/requestUserInput` (the driver's `question: 'form'`, its shape in
 *   `codex-app-server/permissionMapping.ts`); the reply names the first answer the person chose.
 * - A permission is `item/commandExecution/requestApproval`; `accept` or `decline` picks the reply.
 * - `turn/interrupt` ends the open turn interrupted; stdin's end ends the process at once.
 *
 * The world folder is made by `install.mjs`; its `codex.mjs` entry calls {@link runCodexDemoStub} with that folder.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { behaviorFor } from './behavior.mjs'
import { readScript } from './claudeDemoStub.mjs'
import { codexRolloutFile, codexSubthreadMeta, threadIdOf } from './subagents.mjs'

const VERSION = 'codex-cli 0.153.4'
const HELP_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/codex/app-server-rpc/0.153.4/probe-help.jsonl'
)

const seconds = () => Math.floor(Date.now() / 1000)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The shell command a Codex dwarf would run for one scripted step. */
function commandOf(step) {
  switch (step.tool) {
    case 'Read':
      return `cat ${step.target}`
    case 'Grep':
      return `rg ${step.target}`
    case 'Edit':
    case 'Write':
      return `apply_patch ${step.target}`
    default:
      return step.target
  }
}

/** The first answer of a `requestUserInput` reply, or null. */
function firstAnswer(result) {
  for (const entry of Object.values(result?.answers ?? {})) {
    const given = entry?.answers?.[0]
    if (typeof given === 'string' && given !== '') return given
  }
  return null
}

/**
 * The thread's rollout, as Codex keeps one: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, in the
 * shape of `fixtures/codex/observer/0.153.x`. The Host marks a dwarf working and credits its ore from what it observes
 * there (`observation/adapters/codex/parse.ts`), so the stub writes one; only under `CODEX_HOME`, which the Host hands
 * the child (`providerEnvVars`) and which the demo points inside its profile. Without it nothing is written.
 */
function rolloutWriter(threadId, cwd) {
  const home = process.env.CODEX_HOME
  if (home === undefined || home === '') return () => {}
  const now = new Date()
  const day = now.toISOString().slice(0, 10).split('-')
  const folder = path.join(home, 'sessions', ...day)
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-')
  const file = path.join(folder, `rollout-${stamp}-${threadId}.jsonl`)
  const write = (type, payload) => {
    try {
      mkdirSync(folder, { recursive: true })
      appendFileSync(
        file,
        `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
      )
    } catch {
      // A rollout that cannot be written only costs the dwarf its working state and ore.
    }
  }
  write('session_meta', {
    id: threadId,
    session_id: threadId,
    timestamp: now.toISOString(),
    cwd,
    originator: 'codex_vscode',
    cli_version: '0.153.4',
    source: 'vscode'
  })
  return write
}

/**
 * The foreman's sub-threads, as Codex spawns them: each, `startMs` after the foreman's first turn began, is a rollout
 * of its own under `CODEX_HOME` whose head names the thread that spawned it (`stubs/subagents.mjs`). One turn: the
 * task, one command step every `stepMs` with the thread's usage, then its reply. `loop` keeps the turn open and
 * working; `complete` and `stay` close the turn (the Host closes a quiet thread after 300 s). Nothing is started.
 */
function startSubthreads(parentThreadId, cwd, spawns) {
  const home = process.env.CODEX_HOME
  if (home === undefined || home === '' || parentThreadId === null) return
  const idOf = (key) => threadIdOf(`${parentThreadId}:${key}`)
  for (const spawn of spawns) {
    setTimeout(() => {
      void runSubthread(spawn)
    }, spawn.startMs)
  }
  async function runSubthread(spawn) {
    const threadId = idOf(spawn.key)
    const parent = spawn.parent === null ? parentThreadId : idOf(spawn.parent)
    const file = codexRolloutFile(home, threadId, Date.now())
    const write = (type, payload) => {
      try {
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(
          file,
          `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
        )
      } catch {
        // A sub-thread that cannot be written is only not seen.
      }
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(
        file,
        `${JSON.stringify(codexSubthreadMeta(threadId, parent, cwd, Date.now()))}\n`
      )
    } catch {
      return
    }
    const turnId = randomUUID()
    let input = 0
    let output = 0
    write('event_msg', { type: 'task_started', turn_id: turnId })
    write('response_item', {
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'input_text', text: spawn.prompt }]
    })
    const spend = () => {
      input += spawn.tokens
      output += Math.round(spawn.tokens / 8)
      write('event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output
          },
          model_context_window: 258400
        },
        rate_limits: null
      })
    }
    for (;;) {
      for (let step = 0; step < spawn.steps.length; step++) {
        await pause(spawn.stepMs)
        spend()
      }
      await pause(Math.min(spawn.stepMs, 1_500))
      write('response_item', {
        type: 'message',
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'output_text', text: spawn.reply }],
        phase: spawn.end === 'loop' ? 'commentary' : 'final_answer'
      })
      if (spawn.end !== 'loop') break
    }
    write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: spawn.reply })
  }
}

function runServer(worldDir) {
  const script = readScript(worldDir)
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const notify = (method, params) => write({ method, params })
  const pending = new Map()
  let nextServerRequest = 0
  let threadId = null
  let open = null
  let rollout = () => {}
  let spawned = false
  const total = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  }

  const thread = (cwd) => ({
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    model: 'demo-model',
    createdAt: seconds(),
    updatedAt: seconds(),
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.153.4',
    source: 'vscode',
    threadSource: null,
    turns: []
  })
  const turnOf = (id, status, completed) => ({
    id,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: seconds(),
    completedAt: completed ? seconds() : null,
    durationMs: completed ? 0 : null
  })
  const item = (event, turnId, value) =>
    notify(event, {
      item: value,
      threadId,
      turnId,
      ...(event === 'item/started' ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() })
    })
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextServerRequest++
      pending.set(id, (result) => resolve({ id, result }))
      write({ id, method, params })
    })
  const spend = (turnId, tokens) => {
    const output = Math.round(tokens / 8)
    const last = {
      totalTokens: tokens + output,
      inputTokens: tokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0
    }
    for (const key of Object.keys(total)) total[key] += last[key]
    rollout('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total.inputTokens,
          cached_input_tokens: 0,
          output_tokens: total.outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: total.totalTokens
        },
        model_context_window: 258400
      },
      rate_limits: null
    })
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { total: { ...total }, last, modelContextWindow: 258400 }
    })
  }

  async function runTurn(turnId, text, cwd) {
    open = { id: turnId, interrupted: false }
    const mine = open
    const behavior = behaviorFor(script, text)
    if (!spawned && (behavior.spawns ?? []).length > 0) {
      spawned = true
      startSubthreads(threadId, cwd, behavior.spawns)
    }
    // Each usage update is one model call the Host credits on its own.
    const share = Math.max(1, behavior.tokens)
    notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
    notify('turn/started', { threadId, turn: turnOf(turnId, 'inProgress', false) })
    rollout('event_msg', { type: 'task_started', turn_id: turnId })
    rollout('response_item', {
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'input_text', text }]
    })
    const user = {
      type: 'userMessage',
      id: randomUUID(),
      clientId: null,
      content: [{ type: 'text', text, text_elements: [] }]
    }
    item('item/started', turnId, user)
    item('item/completed', turnId, user)
    for (const step of behavior.steps) {
      await pause(behavior.stepMs)
      if (mine.interrupted) return
      const command = {
        type: 'commandExecution',
        id: randomUUID(),
        command: commandOf(step),
        cwd,
        processId: null,
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
      item('item/started', turnId, command)
      item('item/completed', turnId, {
        ...command,
        status: 'completed',
        aggregatedOutput: 'ok (fictional demo output)\n',
        exitCode: 0,
        durationMs: 120
      })
      spend(turnId, share)
    }
    let reply = behavior.reply
    if (behavior.ask?.kind === 'question') {
      const itemId = randomUUID()
      const answered = await ask('item/tool/requestUserInput', {
        threadId,
        turnId,
        itemId,
        questions: behavior.ask.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: true,
          isSecret: false,
          options: question.options.map((label) => ({ label, description: '' }))
        }))
      })
      if (mine.interrupted) return
      notify('serverRequest/resolved', { threadId, requestId: answered.id })
      const chosen = firstAnswer(answered.result)
      reply =
        chosen === null
          ? 'No answer, so I left the migration as a draft.'
          : reply.replace('{answer}', chosen)
    } else if (behavior.ask?.kind === 'permission') {
      const command = {
        type: 'commandExecution',
        id: randomUUID(),
        command: commandOf({ tool: behavior.ask.tool, target: behavior.ask.target }),
        cwd,
        processId: null,
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
      item('item/started', turnId, command)
      const answered = await ask('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: command.id,
        approvalId: null,
        command: command.command,
        cwd,
        reason: null,
        startedAtMs: Date.now()
      })
      if (mine.interrupted) return
      notify('serverRequest/resolved', { threadId, requestId: answered.id })
      const accepted = answered.result?.decision === 'accept'
      item('item/completed', turnId, {
        ...command,
        status: accepted ? 'completed' : 'declined',
        exitCode: accepted ? 0 : null
      })
      if (!accepted) reply = behavior.replyDenied ?? reply
    }
    await pause(Math.min(behavior.stepMs, 1_500))
    if (mine.interrupted) return
    item('item/completed', turnId, {
      type: 'agentMessage',
      id: randomUUID(),
      text: reply,
      phase: 'final_answer',
      memoryCitation: null,
      delivery: null,
      questions: null
    })
    spend(turnId, share)
    notify('thread/status/changed', { threadId, status: { type: 'idle' } })
    rollout('response_item', {
      type: 'message',
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'output_text', text: reply }],
      phase: 'final_answer'
    })
    rollout('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: reply })
    notify('turn/completed', { threadId, turn: turnOf(turnId, 'completed', true) })
    open = null
  }

  function handle(message) {
    if (message.method === undefined) {
      const answer = pending.get(message.id)
      pending.delete(message.id)
      answer?.(message.result)
      return
    }
    if (message.id === undefined) return
    const reply = (result) => write({ id: message.id, result })
    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize':
        reply({
          userAgent: `${params.clientInfo?.name ?? 'client'}/0.153.4 (demo stub)`,
          codexHome: path.join(worldDir, 'home'),
          platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
          platformOs: process.platform
        })
        return
      case 'thread/start':
      case 'thread/resume': {
        threadId = message.method === 'thread/resume' ? String(params.threadId) : randomUUID()
        const cwd = String(params.cwd ?? process.cwd())
        reply({
          thread: thread(cwd),
          model: 'demo-model',
          modelProvider: 'openai',
          cwd,
          approvalPolicy: params.approvalPolicy ?? 'on-request',
          sandbox: { type: 'workspaceWrite', networkAccess: false },
          reasoningEffort: 'medium'
        })
        rollout = rolloutWriter(threadId, cwd)
        notify('thread/started', { thread: thread(cwd) })
        return
      }
      case 'turn/start': {
        const turnId = randomUUID()
        reply({ turn: turnOf(turnId, 'inProgress', false) })
        const text = (params.input ?? [])
          .filter((part) => part?.type === 'text')
          .map((part) => String(part.text ?? ''))
          .join('\n')
        void runTurn(turnId, text, process.cwd())
        return
      }
      case 'turn/interrupt':
        reply({})
        if (open !== null) {
          open.interrupted = true
          for (const [id, answer] of pending) {
            pending.delete(id)
            answer({})
          }
          notify('turn/completed', { threadId, turn: turnOf(open.id, 'interrupted', true) })
          open = null
        }
        return
      default:
        reply({})
    }
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (line.trim() === '') return
    try {
      handle(JSON.parse(line))
    } catch {
      // Not JSON-RPC: ignored, as a server would answer it with a parse error nobody reads.
    }
  })
  lines.on('close', () => process.exit(0))
}

/** Runs the stub for `argv` in `worldDir`: a server for `app-server`, the recorded answers for `--version`, `--help`. */
export function runCodexDemoStub(worldDir, argv = process.argv.slice(2)) {
  if (argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (argv.includes('--help')) {
    process.stdout.write(readFileSync(HELP_FILE, 'utf8'))
    return
  }
  if (argv[0] === 'app-server') {
    runServer(worldDir)
    return
  }
  process.stderr.write(`codex demo stub: unsupported arguments ${JSON.stringify(argv)}\n`)
  process.exitCode = 2
}
