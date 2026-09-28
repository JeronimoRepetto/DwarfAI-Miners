import { describe, expect, it } from 'vitest'
import { errorWithoutToolOutput, toolSaid, withoutToolWords } from './toolOutput'

/*
 * #635 (MESSAGE-QUESTIONS 23): a launched tool's own output can hold local paths or account
 * names, so it is shown only in the panel and never logged. These are the two shapes it reaches a
 * log line in: a refusal sentence this app wrote around the tool's words, and an error the Claude
 * Agent SDK built with the CLI's stderr in its message.
 */
describe('withoutToolWords', () => {
  it('keeps the app’s own sentence and drops what the tool said', () => {
    const reason = 'Codex stopped straight away (exit 1), so nothing was delivered.' + toolSaid('x')
    expect(withoutToolWords(reason)).toBe(
      'Codex stopped straight away (exit 1), so nothing was delivered.'
    )
  })

  it('writes the tool’s words after the app’s sentence in one fixed form', () => {
    expect(toolSaid('error: not signed in')).toBe(' It said: error: not signed in')
  })

  it('leaves a reason that carries no tool words as it is', () => {
    expect(withoutToolWords('The relay never answered.')).toBe('The relay never answered.')
  })
})

describe('errorWithoutToolOutput', () => {
  it('drops the stderr the Agent SDK appends to a CLI exit, keeping the exit itself', () => {
    const error = new Error(
      'Claude Code process exited with code 1. stderr: error: not signed in as j'
    )
    expect(errorWithoutToolOutput(error)).toBe('Error: Claude Code process exited with code 1')
  })

  /*
   * AMENDED for #635 (was: 'TypeError: spawn EACCES', the class and message alone): an error that
   * is not the SDK's carries no tool output, so it keeps its stack and an app bug stays diagnosable.
   */
  it('logs an error that carries no tool output with its stack', () => {
    const error = Object.assign(new TypeError('spawn EACCES'), { code: 'EACCES' })
    expect(errorWithoutToolOutput(error)).toBe(error.stack)
  })

  // ADDED for #635: the SDK replaces the exit error with the CLI's own error result text.
  it('drops the CLI’s own error result text, keeping that it returned one', () => {
    const error = new Error('Claude Code returned an error result: signed in as j, quota gone')
    expect(errorWithoutToolOutput(error)).toBe('Error: Claude Code returned an error result')
  })

  /*
   * ADDED for #635: the SDK tags every error it builds with the content-free line it sends to its
   * own telemetry, which is what a log may say — never the message, nor the stack that repeats it.
   */
  it('logs an error the SDK built by the line it tagged it with, and no stack', () => {
    const error = Object.assign(new Error('Claude Code control request failed: j said no'), {
      telemetryMessage: 'Claude Code control request failed (interrupt)',
      errorClass: 'control_request_failed'
    })
    expect(errorWithoutToolOutput(error)).toBe(
      'Error: Claude Code control request failed (interrupt)'
    )
  })

  it('drops the same tail from something thrown that is not an Error', () => {
    expect(errorWithoutToolOutput('exited. stderr: secret')).toBe('exited')
    expect(errorWithoutToolOutput(undefined)).toBe('undefined')
  })
})
