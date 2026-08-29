import { describe, expect, it, vi } from 'vitest'
import {
  buildOsascriptInterruptCommand,
  buildOsascriptKeystrokeCommand,
  createOsascriptConsoleInput,
  escapeAppleScriptString
} from './osascriptInput'

describe('escapeAppleScriptString', () => {
  it('escapes the two characters that can end an AppleScript literal', () => {
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"')
    expect(escapeAppleScriptString('a\\b')).toBe('a\\\\b')
  })

  it('escapes backslashes before quotes, so an escaped quote cannot be unescaped', () => {
    // Escaping in the other order would turn `\"` into `\\"`, which closes the
    // literal and leaves the rest of the payload as AppleScript source.
    expect(escapeAppleScriptString('a\\"b')).toBe('a\\\\\\"b')
  })
})

describe('buildOsascriptKeystrokeCommand', () => {
  it('types the text through System Events', () => {
    const command = buildOsascriptKeystrokeCommand('hello there', false)
    expect(command.command).toBe('osascript')
    expect(command.args).toEqual([
      '-e',
      'tell application "System Events" to keystroke "hello there"'
    ])
  })

  it('sends Return as its own key code so a payload can never submit itself', () => {
    const command = buildOsascriptKeystrokeCommand('hello', true)
    expect(command.args).toHaveLength(4)
    expect(command.args[3]).toBe('tell application "System Events" to key code 36')
  })

  it('flattens a multi-line message to one console line', () => {
    // Same reason as the Windows path: a console submits on a literal newline,
    // so a pasted paragraph would send its first line and type the rest into a
    // fresh prompt.
    const command = buildOsascriptKeystrokeCommand('first\nsecond   third', false)
    expect(command.args[1]).toContain('"first second third"')
  })

  it('neutralises a payload that tries to close the AppleScript literal', () => {
    const command = buildOsascriptKeystrokeCommand('bye" \nreturn 1', false)
    expect(command.args[1]).toBe('tell application "System Events" to keystroke "bye\\" return 1"')
  })
})

describe('buildOsascriptInterruptCommand', () => {
  it('sends the Escape key code, which is what the Claude Code TUI interrupts on', () => {
    expect(buildOsascriptInterruptCommand()).toEqual({
      command: 'osascript',
      args: ['-e', 'tell application "System Events" to key code 53']
    })
  })
})

describe('createOsascriptConsoleInput', () => {
  it('reports success when osascript exits cleanly', async () => {
    const run = vi.fn(async () => '')
    const input = createOsascriptConsoleInput(run)
    expect(await input.sendText('hi', true)).toBe(true)
    expect(await input.sendInterrupt()).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports failure instead of throwing when osascript is denied', async () => {
    // Synthesizing keystrokes needs Accessibility permission; without it
    // osascript exits non-zero rather than doing nothing silently.
    const input = createOsascriptConsoleInput(() => Promise.reject(new Error('not authorised')))
    expect(await input.sendText('hi', false)).toBe(false)
    expect(await input.sendInterrupt()).toBe(false)
  })
})
