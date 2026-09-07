import { spawn, type SpawnOptions } from 'node:child_process'
import { toolActivityLine } from '../domain/permissionSummary'
import type { FeedActivity, FeedMessage } from '../domain/types'
import { antigravityToolSubject } from '../providers/antigravity/parse'
import type {
  HeldSessionHandle,
  HeldSessionPort,
  HeldSessionStartRequest,
  HeldSessionTelemetryUpdate
} from './heldSession'

/**
 * The Antigravity CLI's own bidirectional stream, behind the held-session port
 * (#237, step 5).
 *
 * The second implementation of `HeldSessionPort`, beside `sdkHeldSession.ts`,
 * and the reason that port stopped being the Agent SDK's shape and became a
 * protocol-neutral one. There is no SDK here and no library: the whole of it is
 * a child process, one NDJSON line per turn onto its stdin, and its stdout read
 * back as NDJSON events.
 *
 * ## The protocol, and where these facts come from
 *
 * Documented at https://antigravity.google/docs/cli/headless/ (read 2026-09-07)
 * and MEASURED against the installed Antigravity CLI **1.1.26** the same day,
 * by driving two turns through a scratch directory under the OS temp dir. The
 * captured stdout is committed, sanitized, as
 * `providers/__fixtures__/antigravity/held-stream.jsonl`, and every shape below
 * is read off it. Where the page and the build disagreed, the build wins and
 * the disagreement is written down.
 *
 * ### Starting it
 *
 * ```text
 * agy --input-format stream-json --output-format stream-json
 * ```
 *
 * **No `-p`, and this is the correction that cost the probe two runs.** The
 * page lists `-p, --print, --prompt` as the print-mode flag, which reads like a
 * boolean. It is not: it takes a VALUE. `agy -p --input-format stream-json`
 * exits 2 with `-p took "--input-format" as its prompt, so the intended prompt
 * was left as an argument and ignored`, and a trailing bare `-p` exits 2 with
 * `flag needs an argument: -p`. `--input-format stream-json` is what puts the
 * CLI in print mode, so the flag is simply not passed. The CLI's own
 * `--input-format` help also states the pairing this argv honours:
 * "stream-json reads one NDJSON message per line from stdin and runs a turn for
 * each; it requires --output-format stream-json".
 *
 * ### Speaking to it
 *
 * One line per turn, and the line IS the turn:
 *
 * ```json
 * { "event": "user", "message": { "content": "Reply with the single word pong." } }
 * ```
 *
 * The page also documents a `content` array of `{ type: 'text', text }` blocks
 * and says `text` is the only block type it accepts; the plain string is what
 * was measured, so it is what is sent.
 *
 * ### Listening to it
 *
 * Three event types were observed, and nothing else:
 *
 * - **`init`**, once — `conversation_id`, and an `init` object with `cwd`,
 *   `tools[]` and `permission_mode` (plus `model`/`agent`/`json_schema` when
 *   the launch named them). **Once per PROCESS, not once per turn**, which is
 *   the sharpest difference from the Agent SDK's `init` and the reason nothing
 *   on this wire marks a turn's START. The registry supplies that edge from the
 *   message it just sent.
 * - **`step_update`** — `conversation_id`, `step_index`, `state`
 *   (`ACTIVE`/`DONE`), `step_type` (`user_input`, `agent_response`, `tool`
 *   observed; the page also names `checkpoint`), and then per type: `text_delta`,
 *   `tool_name`, `tool_info` (`{ name, parameters, output? }`),
 *   `duration_seconds`, `usage`.
 * - **`result`**, once per turn — `conversation_id`, `status`, `response`,
 *   `duration_seconds`, `num_turns`, `usage`.
 *
 * Two measurements decide how those are read, and both were run precisely
 * because guessing either would have put a wrong conversation in the panel:
 *
 * **`text_delta` is a true delta.** A forty-word reply arrived as two `ACTIVE`
 * chunks and a `DONE` carrying only the final `"\n"`. So the deltas of one
 * `step_index` are accumulated and published ONCE, when that step reaches
 * `DONE` — publishing the `DONE` chunk alone shows one character, and
 * publishing each chunk writes the same reply into the panel several times
 * over. This is the same rule `sdkHeldSession.ts` follows by ignoring
 * `stream_event` and keeping only finished messages.
 *
 * **Only `result.usage` is cumulative.** A step's own `usage` is that step's
 * alone (turn 2's `input_tokens` was 4739 while its `result` said 21524), and
 * `HeldSessionTelemetryUpdate` is MERGED by the registry — a later value
 * replaces an earlier one. Reporting a step's usage would make a session's
 * totals go backwards. So usage is read off `result` and nowhere else, which
 * is also what the page means by "metadata counters track the cumulative
 * session".
 *
 * ### What the page said and this build did not
 *
 * `permission_mode` came back `always-proceed`, not the documented
 * `request-review` default. Read but not acted on: this app passes no
 * permission flag, so what it observed is this machine's own configuration and
 * not a fact about the protocol.
 *
 * ## What this session deliberately cannot do
 *
 * The acceptance gates of #237 in the type system rather than in prose. The
 * stream's INPUT side documents user text events and nothing else — no cancel
 * event, no question answer, no permission answer, no addressed child — so:
 *
 * - **No `interrupt`.** The handle leaves the method OFF, so the panel says
 *   "this protocol has no cancel" rather than "the interrupt was refused". See
 *   `HeldSessionHandle` on why absent and `false` are different claims.
 * - **No `contextUsage`.** There is no control channel to pull one over.
 * - **`onAsk` and `onPermission` are never called.** Antigravity's own
 *   `ask_question` and `ask_permission` tools exist — they are in the `init`
 *   tool list — and nothing in this stream hands one to a host, so no question
 *   from a held Antigravity session ever reaches the panel's answer buttons.
 *   Detection is not delivery, and a question this app cannot answer must not
 *   appear as one it can.
 * - **`onSubagent` is never called.** The page names `subagent_info` on
 *   `step_update` and the probe saw none across its turns.
 *   `HeldSessionSubagentSignal` needs a task id, a spawn depth and an ending,
 *   and a shape this app has never observed cannot honestly supply them — so a
 *   held Antigravity session reports no crew at all rather than a crew invented
 *   from the documented field names. Step 7's work, once a live sample exists.
 *
 * ## Why the process seam is here rather than nodeHostedProcess.ts
 *
 * That module is close, and one detail rules it out: it folds stdout and stderr
 * into ONE stream on purpose, because for a hosted process "which file
 * descriptor a program chose is its own business". Here stdout is a PARSED
 * format, and a stderr chunk landing mid-line would corrupt the JSON being
 * read. So stderr gets its own pipe and is logged, never ingested.
 *
 * Everything else follows the same division that module documents, and unlike
 * `sdkHeldSession.ts` this one is fully under test: the spawn is a VALUE
 * (`buildAntigravityHeldSpawn`), the stream is a pure reader over text
 * (`AntigravityStreamReader`), and the port itself is driven through an
 * injected fake child. No test here starts a process.
 */

/**
 * The format name, spelled once because the CLI requires it on BOTH halves —
 * "stream-json reads one NDJSON message per line from stdin and runs a turn for
 * each; it requires --output-format stream-json", per `agy --help` on 1.1.26.
 * Two spellings of one requirement is one chance to satisfy half of it.
 */
const STREAM_JSON = 'stream-json'

/**
 * The argv for one held Antigravity session.
 *
 * Both formats are named explicitly rather than left to the documented
 * defaults, for the reason `buildAntigravityLaunchArgs` gives: a default can
 * move under us. `--model` and `--effort` are the CLI's own flags, forwarded
 * only when the launch named one — the Add Panel's picker for them is #282's,
 * and this accepts what the request already carries rather than inventing a
 * value for it.
 *
 * See the module comment on why `-p` is absent. It is not an omission.
 */
export function antigravityHeldArgs(tuning: { model?: string; effort?: string } = {}): string[] {
  return [
    '--input-format',
    STREAM_JSON,
    '--output-format',
    STREAM_JSON,
    ...(tuning.model === undefined ? [] : ['--model', tuning.model]),
    ...(tuning.effort === undefined ? [] : ['--effort', tuning.effort])
  ]
}

/**
 * One turn, as it reaches the child's stdin.
 *
 * `JSON.stringify` is what keeps a multi-line prompt on ONE line, which is the
 * whole contract: the CLI reads one NDJSON message per line and runs a turn for
 * each, so a raw newline inside the text would split one turn into two and the
 * second half would not parse.
 */
export function antigravityUserEvent(text: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: text } })}\n`
}

/**
 * The exact spawn call, as a value.
 *
 * `detached: false` is the bargain rather than an oversight, exactly as
 * `buildHostedSpawn` documents it: libuv gives every non-detached child a
 * KILL_ON_JOB_CLOSE job, so a held session's process dies with the panel —
 * which is the lifetime `HeldSessionRegistry` already promises, because the
 * panel IS this process's stdin.
 *
 * `shell` is absent, which means false, and that is the posture: the argv is a
 * constant built above and the prompt goes on stdin, so nothing downstream
 * needs to interpret a metacharacter.
 */
export function buildAntigravityHeldSpawn(request: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}): { command: string; args: string[]; options: SpawnOptions } {
  return {
    command: request.program,
    args: [...request.args],
    options: {
      cwd: request.cwd,
      env: request.env,
      detached: false,
      // stderr on its OWN pipe, unlike a hosted process's folded stream — see
      // the module comment on why a parsed stdout cannot share one.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  }
}

/**
 * One thing a stream event said, translated but not acted on.
 *
 * A signal rather than a direct callback so the reading is pure and testable
 * against the captured fixture, with the port below doing nothing but handing
 * each one to the matching `HeldSessionStartRequest` callback. The same split
 * `subagentSignals` draws in `sdkHeldSession.ts`, and here it covers the whole
 * translation because there is no library to hide behind.
 *
 * `'crew'` is declared and never produced. It is here so a reader looking for
 * the subagent case finds the answer at the definition rather than concluding
 * it was forgotten — see the module comment.
 */
export type AntigravityHeldSignal =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'telemetry'; update: HeldSessionTelemetryUpdate }
  | {
      kind: 'message'
      role: FeedMessage['role']
      text: string
      activity?: FeedActivity
    }
  | { kind: 'crew'; never: never }

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * A `result`'s cumulative counters, in this app's own vocabulary.
 *
 * `cacheCreationInputTokens` is absent because Antigravity states no such
 * figure — see `HeldSessionUsage`, where both optional fields say which
 * protocol each belongs to. Nothing is defaulted to zero: a count this CLI
 * never gave is not a count of nothing.
 */
function usageOf(usage: unknown): HeldSessionTelemetryUpdate['usage'] | undefined {
  if (!isRecord(usage)) return undefined
  const inputTokens = numberOf(usage.input_tokens)
  const outputTokens = numberOf(usage.output_tokens)
  const cacheReadInputTokens = numberOf(usage.cache_read_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const thinkingTokens = numberOf(usage.thinking_tokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheReadInputTokens ?? 0,
    ...(thinkingTokens === undefined ? {} : { thinkingTokens })
  }
}

/**
 * Reads one held Antigravity session's stdout.
 *
 * Stateful for two reasons, both of them the pipe's and the protocol's rather
 * than this app's: a chunk can end mid-line, and a reply arrives as deltas
 * across several events of the same `step_index`. Both are held here so the
 * port below stays a wiring layer, and both are asserted against the captured
 * fixture in one pass.
 *
 * Every shape it has no reading for is a MISS, never a throw: this is a
 * documented format on a CLI that has already changed it once, read inside a
 * loop nothing else can rescue.
 */
export class AntigravityStreamReader {
  /** The tail of the last chunk, up to the newline that has not arrived. */
  private buffer = ''
  /** step_index -> the deltas of that agent_response so far, unpublished. */
  private readonly saying = new Map<number, string>()
  /** Tool step indexes already given a feed line — one line per call, not per report. */
  private readonly toolsDrawn = new Set<number>()

  /** Feed one chunk of stdout; returns every signal its COMPLETE lines carried. */
  receive(chunk: string): AntigravityHeldSignal[] {
    this.buffer += chunk
    const signals: AntigravityHeldSignal[] = []
    let cut = this.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 1)
      signals.push(...this.line(line))
      cut = this.buffer.indexOf('\n')
    }
    return signals
  }

  private line(line: string): AntigravityHeldSignal[] {
    if (line.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A half-written line, or something that is not this protocol at all.
      return []
    }
    if (!isRecord(parsed)) return []
    if (parsed.event === 'init') return this.init(parsed)
    if (parsed.event === 'step_update') return this.step(parsed.step_update)
    if (parsed.event === 'result') return this.result(parsed.result)
    // An event type this build has no reading for. Nothing, on purpose.
    return []
  }

  private init(event: Rec): AntigravityHeldSignal[] {
    const signals: AntigravityHeldSignal[] = []
    const conversationId = stringOf(event.conversation_id)
    if (conversationId !== undefined) signals.push({ kind: 'conversation', conversationId })
    // The model only when the CLI names one, which it does when the launch
    // passed `--model`. Never inferred from a slug this app sent: what is
    // reported is what the session said about itself.
    const model = isRecord(event.init) ? stringOf(event.init.model) : undefined
    if (model !== undefined) signals.push({ kind: 'telemetry', update: { model } })
    return signals
  }

  private step(step: unknown): AntigravityHeldSignal[] {
    if (!isRecord(step)) return []
    const index = numberOf(step.step_index)
    if (index === undefined) return []
    if (step.step_type === 'agent_response') return this.said(index, step)
    if (step.step_type === 'tool') return this.used(index, step)
    // `user_input` publishes nothing: the CLI's own user step carries no
    // content at all (measured), so the words are known only to whoever sent
    // them — the registry seeds the launch prompt and the handle below echoes
    // every follow-up it actually wrote.
    return []
  }

  /** One `agent_response` step: accumulate, and publish once at DONE. */
  private said(index: number, step: Rec): AntigravityHeldSignal[] {
    const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
    const said = (this.saying.get(index) ?? '') + delta
    if (step.state !== 'DONE') {
      this.saying.set(index, said)
      return []
    }
    this.saying.delete(index)
    const text = said.trim()
    // A step that said nothing is not an empty message: a reply is sometimes
    // only thinking, and a blank bubble would be this app inventing a silence
    // as speech. `retainHeldMessage` drops one anyway; not producing it is the
    // honest half.
    if (text === '') return []
    return [{ kind: 'message', role: 'assistant', text }]
  }

  /**
   * One `tool` step: at most one feed line, the first time this step is seen.
   *
   * Two shared rules and no local one, which is the point. `antigravityToolSubject`
   * (#280, in the provider that owns this CLI's format knowledge) maps the
   * arg NAMES this CLI writes onto the canonical fields, and `toolActivityLine`
   * (#240) turns those into the verb and the line — so a `run_command` reads
   * the same in a held session, in an observed session's feed and on a
   * permission card. A tool either table does not name, or whose parameters
   * name no subject, yields nothing: a deliberate miss, which is those
   * tables' own stated posture.
   *
   * The reader passed in is the one thing this side owns, and it is the ONE
   * way the two sources differ (#237, step 5): a transcript's `args` values
   * are JSON strings needing a second parse, and this stream's
   * `tool_info.parameters` carries plain ones. Measured, not assumed — the
   * fixtures sit side by side.
   */
  private used(index: number, step: Rec): AntigravityHeldSignal[] {
    if (this.toolsDrawn.has(index)) return []
    const toolName = stringOf(step.tool_name)
    if (toolName === undefined) return []
    const info = step.tool_info
    const parameters = isRecord(info) && isRecord(info.parameters) ? info.parameters : {}
    this.toolsDrawn.add(index)
    const subject = antigravityToolSubject(toolName, (key) => stringOf(parameters[key]))
    if (subject === undefined) return []
    const line = toolActivityLine(toolName, subject)
    if (line === undefined) return []
    return [{ kind: 'message', role: line.role, text: line.text, activity: line.activity }]
  }

  /**
   * One `result`: the turn's end, and the session's cumulative counters.
   *
   * `response` is deliberately NOT published. It repeats what the turn's last
   * `agent_response` step already said, and publishing both would write the
   * reply into the panel twice.
   *
   * An `ERROR` status is reported as a turn that ENDED and nothing more. The
   * `error` string is the CLI's own explanation of a failure, not something the
   * agent said, and putting it in an assistant bubble would be this app
   * speaking in the agent's voice. A fatal one takes the process with it and
   * arrives as `onEnd`, which is where a failure belongs.
   */
  private result(result: unknown): AntigravityHeldSignal[] {
    if (!isRecord(result)) return []
    const usage = usageOf(result.usage)
    return [
      {
        kind: 'telemetry',
        update: { ...(usage === undefined ? {} : { usage }), turn: 'ended' }
      }
    ]
  }
}

/** The slice of a spawned child this port touches, so its wiring stays typed. */
export interface AntigravityChild {
  readonly pid?: number
  once(event: 'spawn' | 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  stdin: {
    on(event: 'error', listener: () => void): unknown
    write(chunk: string): unknown
    end(): unknown
  } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  kill(): unknown
}

/** `spawn`'s shape as this port needs it; Node's own `spawn` satisfies it. */
export type SpawnAntigravity = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => AntigravityChild

/**
 * Build the real port.
 *
 * Composed in the runtime rather than in platformAdapters, for the reason
 * `createSdkHeldSession` is: starting a session is the same act on all three
 * platforms, so there is no per-OS branch here to own.
 *
 * Resolves once the process is running; rejects when it could not be started at
 * all, which the registry turns into a stated reason rather than a silent
 * no-op.
 */
export function createAntigravityHeldSession(
  spawnProcess: SpawnAntigravity = spawn
): HeldSessionPort {
  return (request: HeldSessionStartRequest): Promise<HeldSessionHandle> =>
    new Promise((resolve, reject) => {
      let settled = false
      let child: AntigravityChild
      const call = buildAntigravityHeldSpawn({
        program: request.executablePath,
        args: antigravityHeldArgs({
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort })
        }),
        cwd: request.cwd,
        env: process.env
      })
      try {
        child = spawnProcess(call.command, call.args, call.options)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }

      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })

      // Called exactly once, whichever way the session ends — the same latch
      // sdkHeldSession keeps, and for the same reason: the registry uses it to
      // dissolve whatever was still open, and a second call would dissolve
      // things already released.
      let ended = false
      const end = (reason: string): void => {
        if (ended) return
        ended = true
        request.onEnd(reason)
      }

      const write = (line: string): boolean => {
        if (child.stdin === null) return false
        try {
          child.stdin.write(line)
          return true
        } catch {
          // A closed or broken pipe reads as "it did not happen", never as a
          // delivered message — the exit-0-shaped lie this app refuses.
          return false
        }
      }

      child.once('spawn', () => {
        if (settled) return
        settled = true
        // An unhandled EPIPE on this stream would take the whole main process
        // down with it, and a child that exits before reading breaks the pipe.
        child.stdin?.on('error', () => {})

        const reader = new AntigravityStreamReader()
        child.stdout?.on('data', (chunk) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          for (const signal of reader.receive(text)) {
            if (signal.kind === 'conversation') request.onSessionId(signal.conversationId)
            else if (signal.kind === 'telemetry') request.onTelemetry(signal.update)
            else if (signal.kind === 'message') {
              request.onMessage(signal.role, signal.text, signal.activity)
            }
          }
        })
        // Read but never ingested: stderr is not this protocol, and a warning
        // the CLI prints is not something the agent said. Logged so a launch
        // that fails on the far side is diagnosable at all.
        child.stderr?.on('data', (chunk) => {
          const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trimEnd()
          if (text !== '') console.warn(`[held] agy said on stderr: ${text}`)
        })
        child.once('exit', (code) => end(code === null ? 'signalled' : `exit ${code}`))

        // The launch prompt IS the first turn. Not echoed to `onMessage`: the
        // registry seeds its own record with it, first-hand and exactly once.
        write(antigravityUserEvent(request.prompt))

        resolve({
          close: () => {
            child.stdin?.end()
            child.kill()
            end('the panel closed the session')
          },
          send: (text: string) => {
            const sent = write(antigravityUserEvent(text))
            // Echoed only when the write actually happened, and echoed HERE
            // because nothing else knows it was said: the CLI's own
            // `user_input` step carries no content, so a session spoken to
            // would otherwise show a reply with nothing in front of it. A
            // refused write is not a message, so it leaves no row.
            if (sent) request.onMessage('user', text)
            return sent
          }
          // No `interrupt` and no `contextUsage`: this protocol documents
          // neither. See the module comment, and HeldSessionHandle on why the
          // methods are absent rather than returning false.
        })
      })
    })
}
