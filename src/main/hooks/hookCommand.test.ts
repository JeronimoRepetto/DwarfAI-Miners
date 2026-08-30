import { describe, expect, it } from 'vitest'
import {
  HOOK_MARKER,
  HOOK_ROUTE,
  HOOK_TOKEN_HEADER,
  buildHookCommand,
  curlBinaryFor,
  isOurHookCommand
} from './hookCommand'

const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('curlBinaryFor', () => {
  it('uses the .exe name on Windows so no PowerShell alias can shadow it', () => {
    expect(curlBinaryFor('win32')).toBe('curl.exe')
  })

  it.each(['darwin', 'linux'] as const)('uses plain curl on %s', (platform) => {
    expect(curlBinaryFor(platform)).toBe('curl')
  })
})

describe('buildHookCommand', () => {
  it('posts the hook stdin to the loopback route with the install token', () => {
    expect(buildHookCommand({ port: 47821, token, platform: 'win32' })).toBe(
      'curl.exe -s -m 2 -X POST ' +
        `-H ${HOOK_TOKEN_HEADER}:${token} ` +
        '-H Content-Type:application/json ' +
        '--noproxy 127.0.0.1 -d@- ' +
        `http://127.0.0.1:47821${HOOK_ROUTE}`
    )
  })

  it('honours the port it is given', () => {
    expect(buildHookCommand({ port: 51000, token, platform: 'linux' })).toContain(
      'http://127.0.0.1:51000'
    )
  })

  it('never emits a quote or a shell metacharacter', () => {
    // Claude Code runs a shell-form hook through sh, Git Bash or PowerShell
    // depending on the host. Every argument here is a single whitespace-free
    // token, which is the only shape all three parse identically -- a bare
    // `@-` is a PowerShell parse error, which is why the stdin flag is -d@-.
    const command = buildHookCommand({ port: 47821, token, platform: 'win32' })
    expect(command).not.toMatch(/["'`$&|<>()]/)
    for (const argument of command.split(' ')) {
      expect(argument).not.toBe('')
    }
  })

  it('carries the ownership marker so install/uninstall can recognise it', () => {
    expect(buildHookCommand({ port: 47821, token, platform: 'win32' })).toContain(HOOK_MARKER)
    expect(isOurHookCommand(buildHookCommand({ port: 1234, token, platform: 'darwin' }))).toBe(true)
  })

  it.each([
    ['a port below 1', 0],
    ['a negative port', -1],
    ['a port above 65535', 70000],
    ['a fractional port', 4782.5]
  ])('refuses %s', (_label, port) => {
    expect(() => buildHookCommand({ port, token, platform: 'win32' })).toThrow(/port/i)
  })

  it.each([
    ['a token with a space', 'abc def'],
    ['a token with a quote', `abc"def`],
    ['a token that is too short', 'abcd'],
    ['a non-hex token', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['an empty token', '']
  ])('refuses %s so nothing can be injected into the command', (_label, bad) => {
    expect(() => buildHookCommand({ port: 47821, token: bad, platform: 'win32' })).toThrow(/token/i)
  })
})

describe('isOurHookCommand', () => {
  it('recognises our own command by its marker alone', () => {
    expect(isOurHookCommand(`curl -d@- http://127.0.0.1:1/${HOOK_MARKER}`)).toBe(true)
  })

  it('recognises an entry written by an older port or token', () => {
    // Identity is the marker, never the exact string: a re-install after a
    // port or token change must still replace the old entry, not duplicate it.
    expect(isOurHookCommand(buildHookCommand({ port: 40000, token, platform: 'linux' }))).toBe(true)
  })

  it.each([
    ['a foreign hook', 'rtk hook claude'],
    ['another tool that also relays hooks', 'agentpet.exe hook --agent claude'],
    ['a user script', 'node C:/Users/j/.claude/hooks/user-script.js'],
    ['a similar-looking name', 'dwarfai-miners --version'],
    ['an empty command', '']
  ])('leaves %s alone', (_label, command) => {
    expect(isOurHookCommand(command)).toBe(false)
  })

  it.each([undefined, null, 42, {}, []])('treats the non-string %s as foreign', (value) => {
    expect(isOurHookCommand(value)).toBe(false)
  })
})
