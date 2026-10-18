// The step-3e stub `agy` (ISSUE-188; `17` §1.9): a person's Antigravity CLI as `AntigravityNdjsonDriver` starts it
// (`15` §4.8): `--input-format stream-json --output-format stream-json`, one `{"event":"user",...}` line per turn on
// stdin. It answers each turn with the agy 1.1.26 held-stream lines the driver reads (the shape of the synthetic fixture
// set `fixtures/antigravity/ndjson/1.1.26-synthetic`): the `init` line naming the conversation on the first turn, then
// the user step, one agent response and the turn's `result`. It ends when stdin ends (the driver's close, ADR-014).
// `--help` prints the option lines the probe reads and `--version` the version the resolver reads. It writes down the
// argv and the environment names it was started with in `runs/`. Synthetic: no real agy is run here (owner waiver 2026-10-18); no credential is read.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

/** The stub's replies, as a case expects them. */
export const REPLIES = { first: 'Hello from the Antigravity stub.', next: 'Noted.' }

const HELP = [
  'Usage of agy:',
  '  --conversation                  Resume a previous conversation by ID',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  ''
].join('\n')

const CONVERSATION = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e'

/** Runs the stub with `dir` as its world. */
export function runAgyStreamStub(dir) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(HELP)
    return
  }
  if (argv.includes('--version')) {
    // The install resolver's version read (ADR-009 D5).
    process.stdout.write('agy 1.1.26\n')
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
      tokenInEnv: Object.keys(process.env).some((name) => /TOKEN/i.test(name))
    })
  )
  const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
  let turn = 0
  let step = 0
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.event !== 'user') return
    if (turn === 0) {
      write({ event: 'init', conversation_id: CONVERSATION, init: { cwd: process.cwd() } })
    }
    turn += 1
    const reply = turn === 1 ? REPLIES.first : REPLIES.next
    write({
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION,
        step_index: step++,
        state: 'DONE',
        step_type: 'user_input'
      }
    })
    write({
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION,
        step_index: step++,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: reply
      }
    })
    write({
      event: 'result',
      result: { conversation_id: CONVERSATION, status: 'SUCCESS', response: reply, num_turns: turn }
    })
  })
  lines.on('close', () => process.exit(0))
}
