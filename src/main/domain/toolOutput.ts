/*
 * A launched tool's own output, kept out of every log line (#635, MESSAGE-QUESTIONS 23). What a
 * command-line tool prints can hold local paths or account names, so it is shown only in the
 * panel, where the person it belongs to reads it, and never logged or sent anywhere. A log line
 * names the fact — that it failed, its exit, its cause — and stops there.
 *
 * It reaches a log line in two shapes, and each has its one place here, so the form that writes
 * the words and the form that takes them out cannot drift apart.
 */

/*
 * How a refusal this app wrote carries the tool's words after its own sentence: "Codex stopped
 * straight away (exit 1), so nothing was delivered. It said: <stderr>" (codexResume,
 * opencodeContinue). The sentence is for the panel, whole; the log keeps what comes before.
 */
const TOOL_SAID = ' It said: '

/** The tool's words, as a refusal sentence appends them. */
export function toolSaid(said: string): string {
  return TOOL_SAID + said
}

/** A refusal sentence with the tool's words taken off, for a log line. */
export function withoutToolWords(reason: string): string {
  const at = reason.indexOf(TOOL_SAID)
  return at < 0 ? reason : reason.slice(0, at)
}

/*
 * The Claude Agent SDK writes the CLI's own words into the errors it builds, read in the
 * installed @anthropic-ai/claude-agent-sdk 0.3.258: an exit carries the stderr tail ("Claude
 * Code process exited with code 1. stderr: <tail>", its ProcessTransport's formatStderrTail), and
 * an exit after an error result is replaced by that result's own text ("Claude Code returned an
 * error result: <text>", Query.readMessages). The part before is the fact worth logging.
 *
 * Every error it builds is also tagged (its `Cn`) with `telemetryMessage`, the content-free line
 * it sends its own telemetry, and `errorClass`. That line is what a log names for an SDK error:
 * never its message, and never its stack, which repeats the message.
 */
const SDK_STDERR = '. stderr: '
const SDK_ERROR_RESULT = 'Claude Code returned an error result'

function cutToolOutput(text: string): string | null {
  const stderr = text.indexOf(SDK_STDERR)
  if (stderr >= 0) return text.slice(0, stderr)
  return text.startsWith(SDK_ERROR_RESULT) ? SDK_ERROR_RESULT : null
}

function sdkTelemetryLine(error: Error): string | undefined {
  const tagged = error as Error & { telemetryMessage?: unknown }
  return typeof tagged.telemetryMessage === 'string' ? tagged.telemetryMessage : undefined
}

/**
 * Something thrown, as a log line may name it. An error the SDK built, or one whose message
 * carries a tool's words in the SDK's forms, by its class and its fact alone, with no stack. Any
 * other error — an app bug — with its stack, so it stays diagnosable. Never the error object
 * itself, which a console prints whole.
 */
export function errorWithoutToolOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    const text = String(error)
    return cutToolOutput(text) ?? text
  }
  const telemetry = sdkTelemetryLine(error)
  if (telemetry !== undefined) return `${error.name}: ${telemetry}`
  const fact = cutToolOutput(error.message)
  if (fact !== null) return `${error.name}: ${fact}`
  return error.stack ?? `${error.name}: ${error.message}`
}
