import { query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
 * ## The permission posture, and why it starts at a refusal
 *
 * `canUseTool` is where a session's permission prompts arrive — the SDK wires it
 * up as the prompt handler, which is also what makes the model raise
 * `AskUserQuestion` at all: without a client able to answer, the same request
 * comes out as prose and the turn simply ends (measured against bare
 * `claude -p --output-format stream-json`).
 *
 * So every prompt an interactive session would have shown its user arrives
 * here, and this panel has no surface to show one on yet (#96). The default is
 * therefore to REFUSE, with a message saying why, and `permissionMode` stays
 * `'default'` — the same posture an interactive session has, where the CLI
 * auto-allows what it considers safe and only prompts for the rest. The
 * alternative was `'bypassPermissions'`, and that would have made "start a
 * session in this mine" quietly mean "and let it do anything, unattended,
 * because nobody is watching" — the more surprising of the two surprises by
 * some distance, and the one that cannot be undone after the fact.
 *
 * `'allow'` exists as a posture because the refusal is a consequence of a
 * missing UI rather than a decision about what agents may do, and the day that
 * UI exists this becomes a real approval prompt instead. Which tools reach the
 * callback at all is the CLI's own policy, and this module does not restate it.
 */

/** The tool this whole mode exists for. */
const ASK_USER_QUESTION = 'AskUserQuestion'

/** What a refused tool is told, phrased for a transcript the user will read. */
const NO_APPROVAL_SURFACE =
  'The DwarfAI-Miners panel started this session and has no way to ask the user to approve ' +
  'that yet, so it is declined. Continue with what you can do without it, or ask a question ' +
  'the panel can show.'

/** What a malformed or unanswerable ask is told. */
const ASK_NOT_SHOWN = 'The panel could not put that question to the user.'

export interface SdkHeldSessionOptions {
  /**
   * What happens to every tool that is not an ask and that the CLI decided to
   * prompt about. 'deny' — the default — refuses with a stated reason; 'allow'
   * approves it unchanged.
   */
  otherTools?: 'deny' | 'allow'
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
export function createSdkHeldSession(options: SdkHeldSessionOptions = {}): HeldSessionPort {
  const otherTools = options.otherTools ?? 'deny'

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
            return otherTools === 'allow'
              ? { behavior: 'allow', updatedInput: toolInput }
              : { behavior: 'deny', message: NO_APPROVAL_SURFACE }
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
      send: (text: string) => input.push(text)
    }
  }
}
