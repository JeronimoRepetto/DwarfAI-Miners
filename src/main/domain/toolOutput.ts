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
 * The Claude Agent SDK builds a CLI's exit error with the CLI's stderr in its message: "Claude
 * Code process exited with code 1. stderr: <tail>" (its ProcessTransport's formatStderrTail, read
 * in the installed @anthropic-ai/claude-agent-sdk 0.3.258). The exit is the fact worth logging;
 * the tail is the tool's own writing.
 */
const SDK_STDERR = '. stderr: '

const cutStderr = (text: string): string => {
  const at = text.indexOf(SDK_STDERR)
  return at < 0 ? text : text.slice(0, at)
}

/**
 * Something thrown, as a log line may name it: its class and its message, with any stderr the
 * SDK appended taken off. Never the error object itself, which a console prints whole.
 */
export function errorWithoutToolOutput(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${cutStderr(error.message)}`
  return cutStderr(String(error))
}
