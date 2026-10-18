/**
 * The interactive `StubCodexCli` of the step-3b L9 case (testing strategy `17` §1.9; ISSUE-002): the `codex` the Host's
 * `CodexAppServerDriver` (`15` §4.4) launches, sends to, asks through and stops. It holds no provider code and makes no
 * network call (ADR-008): it speaks `codex app-server`'s JSON-RPC over stdio the way the recorded fixtures of
 * `fixtures/codex/app-server-rpc/0.153.4/` and the hand-written C-06 case of `0.153.4-synthetic/` show it.
 *
 * Why a stub of its own: the kit's `fixtures/bin/codex` stub only replays a rollout file and reads no stdin, so it cannot
 * hold a thread over several turns nor raise an approval request. This one answers:
 *
 * - `--version` (detection) with the recorded version, and `--help` (the probe) with the recorded 0.153.4 help, whose
 *   `app-server` command line makes the probe offer the launch;
 * - `app-server`: one JSON-RPC server per process, one request or notification per stdin line. `initialize`,
 *   `thread/start` (a launch) or `thread/resume` (a resume), then each `turn/start` is one turn: `turn/started`, the
 *   person's `userMessage` item, the agent's reply, `thread/tokenUsage/updated`, `turn/completed`.
 * - A turn whose text names {@link ASK_MARKER} runs one command first and asks for it: the server request
 *   `item/commandExecution/requestApproval` (C-06). The person's answer (`accept` or `decline`) decides the reply
 *   ({@link REPLIES}); `serverRequest/resolved` acknowledges it. Nothing runs: the stub only reports.
 * - `turn/interrupt` ends the open turn interrupted, `thread/archive` answers; stdin's end ends the process.
 * - Each server run writes `runs/<pid>.json` (pid, kind, thread id, its argv and its environment's variable names, and
 *   whether a delegation token reached it) into its world folder, so a case can name the process the Host launched and
 *   check what it was handed (C-23) without asking the Host for it.
 *
 * The world folder is made by `codexAppServerWorld.ts`; its `codex.mjs` entry calls {@link runCodexAppServerStub} with
 * that folder. The provider child's environment is the Host's allowlist (`15` §4 `childEnv`), so the world is found by
 * the entry's own location, never by a variable.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** The recorded Codex version (S-015-1 run 3) and its help (`probe-help.jsonl` is the help's stdout as recorded). */
const VERSION = 'codex-cli 0.153.4'
const HELP_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/codex/app-server-rpc/0.153.4/probe-help.jsonl'
)

/** A turn whose text holds this asks to run a command first (C-06). */
export const ASK_MARKER = 'marker file'

/** The dwarf's replies, so a case can tell which turn the stub answered and how. */
export const REPLIES = Object.freeze({
  first: 'Hello from the Codex stub.',
  plain: 'Noted.',
  allowed: 'The marker file is written.',
  denied: 'The marker file was not written.'
})

/** The variable a delegation token would travel in, if anything ever handed one over (ADR-013: never). */
const TOKEN_VARIABLE = 'DWARFAI_DELEGATION_TOKEN'

const seconds = () => Math.floor(Date.now() / 1000)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One `codex app-server` process of the stub, until stdin ends. */
function runServer(worldDir, argv) {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const notify = (method, params) => write({ method, params })
  const pending = new Map()
  let nextServerRequest = 0
  let threadId = null
  let turns = 0
  /** The open turn, if any: its id and whether it was interrupted. */
  let open = null

  const record = (kind) => {
    const runs = path.join(worldDir, 'runs')
    mkdirSync(runs, { recursive: true })
    const env = Object.keys(process.env)
    writeFileSync(
      path.join(runs, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        kind,
        threadId,
        argv,
        envNames: env,
        tokenInEnv: env.includes(TOKEN_VARIABLE),
        tokenInArgv: argv.some((arg) => arg.includes(TOKEN_VARIABLE))
      })
    )
  }

  const thread = (cwd) => ({
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    model: 'stub-model',
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

  /** Sends a server request and waits for the person's answer. */
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextServerRequest++
      pending.set(id, (result) => resolve({ id, result }))
      write({ id, method, params })
    })

  async function runTurn(turnId, text, cwd) {
    open = { id: turnId, interrupted: false }
    notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
    notify('turn/started', { threadId, turn: turnOf(turnId, 'inProgress', false) })
    const userId = randomUUID()
    const user = {
      type: 'userMessage',
      id: userId,
      clientId: null,
      content: [{ type: 'text', text, text_elements: [] }]
    }
    item('item/started', turnId, user)
    item('item/completed', turnId, user)
    await pause(50)
    let reply = turns === 1 ? REPLIES.first : REPLIES.plain
    if (text.includes(ASK_MARKER)) {
      const commandId = randomUUID()
      const command = {
        type: 'commandExecution',
        id: commandId,
        command: 'touch marker.txt',
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
        itemId: commandId,
        approvalId: null,
        command: command.command,
        cwd,
        reason: null,
        startedAtMs: Date.now()
      })
      if (open?.interrupted) return
      notify('serverRequest/resolved', { threadId, requestId: answered.id })
      const accepted = answered.result?.decision === 'accept'
      item('item/completed', turnId, {
        ...command,
        status: accepted ? 'completed' : 'declined',
        exitCode: accepted ? 0 : null
      })
      reply = accepted ? REPLIES.allowed : REPLIES.denied
    }
    item('item/completed', turnId, {
      type: 'agentMessage',
      id: randomUUID(),
      text: reply,
      phase: 'final_answer',
      memoryCitation: null,
      delivery: null,
      questions: null
    })
    const usage = {
      totalTokens: 130,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 0
    }
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { total: usage, last: usage, modelContextWindow: 258400 }
    })
    notify('thread/status/changed', { threadId, status: { type: 'idle' } })
    notify('turn/completed', { threadId, turn: turnOf(turnId, 'completed', true) })
    open = null
  }

  function handle(message) {
    if (message.method === undefined) {
      // A reply to one of the stub's server requests.
      const answer = pending.get(message.id)
      pending.delete(message.id)
      answer?.(message.result)
      return
    }
    if (message.id === undefined) return // a notification (`initialized`)
    const reply = (result) => write({ id: message.id, result })
    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize':
        reply({
          userAgent: `${params.clientInfo?.name ?? 'client'}/0.153.4 (stub)`,
          codexHome: path.join(worldDir, 'home'),
          platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
          platformOs: process.platform
        })
        return
      case 'thread/start':
      case 'thread/resume': {
        const resuming = message.method === 'thread/resume'
        threadId = resuming ? String(params.threadId) : randomUUID()
        record(resuming ? 'resume' : 'launch')
        const cwd = String(params.cwd ?? process.cwd())
        reply({
          thread: thread(cwd),
          model: 'stub-model',
          modelProvider: 'openai',
          cwd,
          approvalPolicy: params.approvalPolicy ?? 'on-request',
          sandbox: { type: 'workspaceWrite', networkAccess: false },
          reasoningEffort: 'medium'
        })
        notify('thread/started', { thread: thread(cwd) })
        return
      }
      case 'turn/start': {
        turns += 1
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
      // A line that is not JSON-RPC is ignored, as a server would answer it with a parse error nobody reads.
    }
  })
  lines.on('close', () => process.exit(0))
}

/** Runs the stub for `argv` in `worldDir`: a server for `app-server`, the recorded answers for `--version`, `--help`. */
export function runCodexAppServerStub(worldDir, argv = process.argv.slice(2)) {
  if (argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (argv.includes('--help')) {
    process.stdout.write(readFileSync(HELP_FILE, 'utf8'))
    return
  }
  if (argv[0] === 'app-server') {
    runServer(worldDir, argv)
    return
  }
  process.stderr.write(`codex stub: unsupported arguments ${JSON.stringify(argv)}\n`)
  process.exitCode = 2
}
