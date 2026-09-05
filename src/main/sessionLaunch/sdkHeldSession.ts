import {
  query,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { HeldSessionSubagentSignal } from './heldCrew'
import {
  heldMessageText,
  type HeldSessionHandle,
  type HeldSessionPort,
  type HeldSessionStartRequest
} from './heldSession'

/**
 * The Agent SDK, behind the held-session port.
 *
 * This is the ONE module in the app that imports `@anthropic-ai/claude-agent-sdk`
 * — the project's first runtime dependency past dotenv and vue, and a
 * deliberate one: it is the only measured route from an agent's
 * `AskUserQuestion` to a button in this panel. No unit test comes through here;
 * the registry above it is driven by an injected fake, exactly as the relay and
 * the process probe are.
 *
 * ## Two things learned the hard way, both load-bearing
 *
 * **The binary must be named.** `pathToClaudeCodeExecutable` is optional and
 * the SDK falls back to the executable it ships. That fallback failed to launch
 * from pnpm's deep store path on Windows (measured 2026-09-02), so the path
 * detection found (#91) is always passed. It also keeps the CLI the app drives
 * the same one the user has installed and logged in, rather than a second copy
 * with its own version.
 *
 * **The answer is keyed by the question's TEXT.** `AskUserQuestionInput.answers`
 * is `Record<string, string>` — the SDK's own types document the sibling
 * `annotations` field as "Keyed by question text", and three schema-validation
 * errors confirmed it is not the header. The value is the chosen option's
 * label. Both halves are built by the registry from the ask itself, so nothing
 * this app invents is ever sent.
 *
 * ## The permission posture, now a real prompt (#203)
 *
 * `canUseTool` is where a session's permission prompts arrive — the SDK wires it
 * up as the prompt handler, which is also what makes the model raise
 * `AskUserQuestion` at all: without a client able to answer, the same request
 * comes out as prose and the turn simply ends (measured against bare
 * `claude -p --output-format stream-json`).
 *
 * So every prompt an interactive session would have shown its user arrives
 * here, and every one of them but `AskUserQuestion` now reaches the panel too
 * (#203, closing the gap #96 left): the tool call is parked exactly as an ask
 * is, through `request.onPermission`, and stays blocked until the panel
 * allows or denies it. Before this, `otherTools` defaulted every one of them
 * to an immediate refusal — a session launched from the panel could read and
 * write nothing at all — and that posture and its `SdkHeldSessionOptions`
 * knob are gone along with it.
 *
 * `permissionMode` stays `'default'` regardless — the same posture an
 * interactive session has, where the CLI auto-allows what it considers safe
 * and only prompts for the rest, so this module still only decides what
 * happens to a prompt that reaches it, never which tools reach it at all.
 * The alternative was `'bypassPermissions'`, and that would have made "start a
 * session in this mine" quietly mean "and let it do anything, unattended,
 * because nobody is watching" — the more surprising of the two surprises by
 * some distance, and the one that cannot be undone after the fact.
 *
 * Deliberately absent from this slice: "always allow". The SDK's own
 * `PermissionResult` carries an `updatedPermissions` a caller may return
 * alongside `'allow'` to have the CLI remember the rule for later calls
 * (`extras.suggestions` is where it would come from) — and that is a rule
 * that OUTLIVES this one prompt, written into the session's own permission
 * state rather than answering the question in front of it. Offering it here
 * would be a second, quieter kind of approval riding on the first, so this
 * slice hands back only 'allow' or 'deny' for the prompt actually asked.
 */

/** The tool this whole mode exists for. */
const ASK_USER_QUESTION = 'AskUserQuestion'

/** What a malformed or unanswerable ask is told. */
const ASK_NOT_SHOWN = 'The panel could not put that question to the user.'

/**
 * Statuses a task reaches by being over. `task_updated` and `task_notification`
 * both report the ending — the first as a patch, the second as its own message
 * — and the crew takes the same ending twice without complaint, so both are
 * forwarded rather than one being picked as the authority.
 *
 * 'paused' and 'running' are deliberately absent: a paused agent has not
 * finished, and reading it as one would be the false departure #28 exists to
 * prevent.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'stopped'
])

/**
 * Every signal one stream message carries about this session's crew (#157).
 *
 * A pure translation, and it is pure on purpose: this module is the one place
 * in the app with no unit test coming through it, so it may recognise message
 * shapes and must not decide anything about them. What a task type means, what
 * a depth means, who launched whom, whether an ending sticks — all of that is
 * heldCrew.ts's, under test.
 *
 * The three shapes, as the SDK's own types define them:
 *
 * - `task_started` carries the task id, its description, the tool call it came
 *   from and `spawn_depth` ("1 for a top-level spawn, N+1 when spawned from
 *   inside a depth-N agent"). That last field is the maintainer's taxonomy in
 *   the CLI's own words, which is why nothing here has to infer a depth.
 * - `task_updated` patches a status; `task_notification` reports one outright.
 * - An assistant message with a `parent_tool_use_id` is a turn taken INSIDE a
 *   task, so every tool call it writes was made from within that task. That is
 *   the only thing in the stream connecting a nested agent to its parent, and
 *   it arrives BEFORE the `task_started` that needs it (measured 2026-09-03).
 */
function subagentSignals(message: SDKMessage): HeldSessionSubagentSignal[] {
  if (message.type === 'assistant' && message.parent_tool_use_id !== null) {
    const insideToolUseId = message.parent_tool_use_id
    const content = message.message.content
    if (!Array.isArray(content)) return []
    return content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ kind: 'tool-call', toolUseId: block.id, insideToolUseId }))
  }
  if (message.type !== 'system') return []
  if (message.subtype === 'task_started') {
    return [
      {
        kind: 'task-started',
        taskId: message.task_id,
        ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
        ...(message.description === undefined ? {} : { description: message.description }),
        ...(message.spawn_depth === undefined ? {} : { spawnDepth: message.spawn_depth }),
        ...(message.task_type === undefined ? {} : { taskType: message.task_type }),
        // Either flag marks work the CLI says hosts should not surface; the
        // crew reads one field, so they are collapsed here rather than there.
        ...(message.ambient === true || message.skip_transcript === true ? { ambient: true } : {})
      }
    ]
  }
  if (message.subtype === 'task_updated') {
    const status = message.patch.status
    return status !== undefined && TERMINAL_TASK_STATUSES.has(status)
      ? [{ kind: 'task-ended', taskId: message.task_id }]
      : []
  }
  if (message.subtype === 'task_notification') {
    return TERMINAL_TASK_STATUSES.has(message.status)
      ? [{ kind: 'task-ended', taskId: message.task_id }]
      : []
  }
  return []
}

/**
 * A user message the streaming input can carry. `parent_tool_use_id` is null
 * because these come from the panel, not from inside a tool call.
 */
function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null
  }
}

/**
 * The held session's input stream.
 *
 * A held session is one the panel can keep talking to, so the prompt is an
 * async iterable rather than a string: a string prompt is one turn and then the
 * process is gone, which is the detached mode's bargain, not this one's.
 */
class InputStream {
  private readonly queued: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(text: string): boolean {
    if (this.closed) return false
    this.queued.push(userMessage(text))
    this.wake?.()
    return true
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queued.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null
          resolve()
        }
      })
    }
  }
}

/**
 * Build the real port.
 *
 * Composed in the runtime rather than in platformAdapters, for the reason the
 * relay is: starting a session is the same act on all three platforms, so there
 * is no per-OS branch here to own.
 */
export function createSdkHeldSession(): HeldSessionPort {
  return async (request: HeldSessionStartRequest): Promise<HeldSessionHandle> => {
    const input = new InputStream()
    input.push(request.prompt)

    const session = query({
      prompt: input.messages(),
      options: {
        cwd: request.cwd,
        // Never the SDK's bundled executable — see the module comment.
        pathToClaudeCodeExecutable: request.executablePath,
        permissionMode: 'default',
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
        canUseTool: async (toolName, toolInput, extras): Promise<PermissionResult> => {
          if (toolName !== ASK_USER_QUESTION) {
            const verdict = await request.onPermission({
              toolUseId: extras.toolUseID,
              toolName,
              input: toolInput,
              ...(extras.title === undefined ? {} : { title: extras.title }),
              ...(extras.description === undefined ? {} : { description: extras.description })
            })
            return verdict.decision === 'allow'
              ? { behavior: 'allow', updatedInput: toolInput }
              : { behavior: 'deny', message: verdict.reason }
          }
          const answer = await request.onAsk(extras.toolUseID, toolInput)
          // The answers record is MERGED into the input the model wrote, never
          // substituted for it: the tool still needs its own questions to
          // render the result it writes back.
          return answer.answered
            ? { behavior: 'allow', updatedInput: { ...toolInput, answers: answer.answers } }
            : { behavior: 'deny', message: `${ASK_NOT_SHOWN} ${answer.reason}` }
        }
      }
    })

    // Called exactly once, whichever way the stream ends: the registry uses it
    // to dissolve whatever was still open, and a second call would try to
    // dissolve asks that have already been released.
    let ended = false
    const end = (reason: string): void => {
      if (ended) return
      ended = true
      request.onEnd(reason)
    }

    // Deliberately not awaited: the launch verdict is "the session started",
    // and everything after it is the session running. Errors are reported
    // through onEnd rather than thrown at a caller that has long since
    // returned.
    void (async () => {
      try {
        for await (const message of session) {
          // Every subagent this session launches, live (#157). First, because
          // it is the only thing here that has to see EVERY message: a launch
          // is announced once and a dropped one is a dwarf that never appears.
          for (const signal of subagentSignals(message)) request.onSubagent(signal)
          // The CLI names its own session, and this is where it says so. It is
          // the same id the poll will find on disk, so it is the one link
          // between this stream and the dwarf drawn from it.
          if (message.type === 'system' && message.subtype === 'init') {
            request.onSessionId(message.session_id)
            // Everything else this message says about the session right now
            // (issue #96) — the model in force, every configured MCP server
            // and its connection state, the effort level (absent when the
            // active model takes none), and the exact CLI build driving this
            // session. `init` is re-emitted on every turn ("the newest frame
            // wins", the SDK's own words), which is what makes a model
            // switched mid-session visible here without polling for it.
            request.onTelemetry({
              model: message.model,
              mcpServers: message.mcp_servers,
              ...(message.effort === undefined || message.effort === null
                ? {}
                : { effort: message.effort }),
              claudeCodeVersion: message.claude_code_version
            })
          }
          /*
           * The words themselves (#159). The loop was already reading every
           * one of these and throwing them away, which is why the panel had
           * no conversation to draw for the one session type it holds live.
           *
           * Only `assistant` and `user`, and only their text: a
           * `stream_event` is a partial of an assistant message still being
           * written, so retaining those alongside the finished one would
           * write the same reply into the panel several times over. What
           * counts as text at all is heldMessageText's decision, on the far
           * side of the seam, so this stays a shape check with no parsing in
           * it and the rule can be unit-tested without the SDK.
           */
          if (message.type === 'assistant' || message.type === 'user') {
            const text = heldMessageText(message.message.content)
            if (text !== '') request.onMessage(message.type, text)
          }
          // Once per turn, after every assistant/user/stream_event message of
          // that turn — true of the success subtype and every error subtype
          // alike, since both carry the same total_cost_usd/usage fields.
          // Both are the RUNNING TOTAL for the whole query() call, not this
          // turn's own spend (see HeldSessionTelemetryUpdate's own doc
          // comment for why a later update REPLACES these rather than
          // summing with what came before).
          if (message.type === 'result') {
            request.onTelemetry({
              totalCostUsd: message.total_cost_usd,
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
                cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
                cacheReadInputTokens: message.usage.cache_read_input_tokens
              }
            })
          }
        }
        end('the session stream ended')
      } catch (error) {
        console.warn('[held] The session stream failed', error)
        end('the session stream failed')
      }
    })()

    return {
      close: () => {
        input.close()
        session.close()
        end('the panel closed the session')
      },
      send: (text: string) => input.push(text),
      /*
       * A real interrupt, not a close (#210).
       *
       * `query()` returns a `Query`, and its own types declare
       * `interrupt(): Promise<SDKControlInterruptResponse | undefined>` as a
       * control request "only supported when streaming input/output is used" —
       * which this session is, since its prompt is an async iterable. So the
       * session survives the interrupt and can be spoken to again, which is
       * exactly what the panel's Kick means and what `close` would have got
       * wrong.
       *
       * The resolved value is deliberately dropped. On a CLI advertising
       * `interrupt_receipt_v1` it is a receipt listing the queued messages that
       * will still run; older ones resolve to `undefined`. Neither changes the
       * only thing this handle promises — that the turn was cut short — and
       * reading the receipt would be a claim about the queue this port has no
       * business making.
       */
      interrupt: async () => {
        try {
          await session.interrupt()
          return true
        } catch (error) {
          console.warn('[held] The session refused an interrupt', error)
          return false
        }
      }
    }
  }
}
