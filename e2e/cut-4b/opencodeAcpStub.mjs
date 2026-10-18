// The step-4b stub `opencode` (ISSUE-238; `17` §1.9): a person's OpenCode CLI as the Host's generic `AcpDriver` starts
// it (`15` §4.7, `OPENCODE_ACP`: `opencode acp`, ACP over newline-delimited JSON-RPC on stdio). It answers the client's
// `initialize` and `session/new` with the shape of the recorded OpenCode 1.18.32 handshake
// (`fixtures/opencode/acp/1.18.32/sp12-session-new-mcp.jsonl`), and each `session/prompt` with the turns of the
// synthetic set `fixtures/opencode/acp/1.18.32-synthetic/`: the first turn asks to write a file
// (`session/request_permission` with `allow_always`, `allow_once` and `reject_once` options, C-06/C-07), waits for the
// client's answer, writes it down in `runs/`, and ends the turn with a reply naming the outcome; every later turn
// answers `Noted.`. It ends when stdin ends (the driver's close, ADR-014). `--help` prints the S-031-3 record's command
// lines the probe reads, `--version` the version the resolver reads. It writes down the argv and the environment names
// it was started with. Synthetic: no real OpenCode is run here; no credential is read.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

/** The stub's replies, as a case expects them. */
export const REPLIES = {
  allowed: 'Wrote notes.md.',
  denied: 'Left notes.md alone.',
  next: 'Noted.'
}

/** `opencode --help` lines of OpenCode 1.18.32 (spike-results/S-031-3/help/help-root.txt), as the probe reads them. */
const HELP = [
  'Commands:',
  '  opencode acp                 start ACP (Agent Client Protocol) server',
  '  opencode run [message..]     run opencode with a message',
  '  opencode serve               starts a headless opencode server',
  ''
].join('\n')

/** Each run's own session id, as OpenCode mints one per `session/new`: a dwarf is one session (ADR-015). */
const SESSION = randomUUID()
/** The id of the stub's own permission request (agent → client). */
const PERMISSION_REQUEST_ID = 900

/** Runs the stub with `dir` as its world. */
export function runOpenCodeAcpStub(dir) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(HELP)
    return
  }
  if (argv.includes('--version')) {
    process.stdout.write('1.18.32\n')
    return
  }
  const runs = path.join(dir, 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(
    path.join(runs, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      argv,
      envNames: Object.keys(process.env).sort(),
      tokenInEnv: Object.keys(process.env).some((name) =>
        /TOKEN|OPENCODE_CONFIG_CONTENT/i.test(name)
      )
    })
  )
  const answers = path.join(runs, `${process.pid}.answers.jsonl`)
  const write = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const update = (sessionUpdate) =>
    write({ method: 'session/update', params: { sessionId: SESSION, update: sessionUpdate } })
  let turn = 0
  /** The prompt waiting for the client's answer to the permission request, if any. */
  let waiting = null

  const endTurn = (promptId, text) => {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    write({ id: promptId, result: { stopReason: 'end_turn' } })
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    // The client's answer to the stub's permission request.
    if (message.id === PERMISSION_REQUEST_ID && message.method === undefined && waiting !== null) {
      const outcome = message.result?.outcome
      const optionId = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled'
      appendFileSync(answers, `${JSON.stringify({ turn, optionId })}\n`)
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_stub_write',
        status: 'completed'
      })
      const promptId = waiting
      waiting = null
      endTurn(promptId, optionId === 'allow' ? REPLIES.allowed : REPLIES.denied)
      return
    }
    switch (message.method) {
      case 'initialize':
        write({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: true, sse: true },
              promptCapabilities: { embeddedContext: true, image: true },
              sessionCapabilities: { close: {}, list: {}, resume: {} }
            },
            authMethods: [],
            agentInfo: { name: 'OpenCode', version: '1.18.32' }
          }
        })
        return
      case 'session/new':
        write({ id: message.id, result: { sessionId: SESSION } })
        return
      case 'session/prompt':
        turn += 1
        if (turn === 1) {
          waiting = message.id
          update({
            sessionUpdate: 'tool_call',
            toolCallId: 'toolu_stub_write',
            title: 'Write notes.md',
            kind: 'edit',
            status: 'pending'
          })
          write({
            id: PERMISSION_REQUEST_ID,
            method: 'session/request_permission',
            params: {
              sessionId: SESSION,
              toolCall: { toolCallId: 'toolu_stub_write', title: 'Write notes.md', kind: 'edit' },
              options: [
                { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
              ]
            }
          })
          return
        }
        endTurn(message.id, REPLIES.next)
        return
      case 'session/cancel':
        return
      default:
        // Any other request (`session/close`, `session/set_mode`, …) is answered with an empty result.
        if (message.id !== undefined) write({ id: message.id, result: {} })
    }
  })
  lines.on('close', () => process.exit(0))
}
