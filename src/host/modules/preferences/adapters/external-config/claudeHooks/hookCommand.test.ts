import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import {
  buildHookCommand,
  isLegacyHookCommand,
  isOwnedHookCommand,
  ownedCommandPrefix
} from './hookCommand'

// L1 (17 §1.1): the hook command builder and the two probes of the `claude-hooks` target (ADR-016
// items 1, 6.2; 16 §7.1). Pure: the platform is a parameter, never the running OS.
const TOKEN = 'a'.repeat(64)
const OLD_TOKEN = '0123456789abcdef0123456789abcdef'

/** The exact command the old app wrote (legacy `hooks/hookCommand.ts` `buildHookCommand`). */
const oldAppCommand = (curl: string, port = 45123, token = OLD_TOKEN): string =>
  `${curl} -s -m 2 -X POST -H x-dwarfai-token:${token} -H Content-Type:application/json ` +
  `--noproxy 127.0.0.1 -d@- http://127.0.0.1:${port}/dwarfai-miners-hook`

describe('claude-hooks hook command', () => {
  it('[ADR-016, C-21] the hook command posts stdin to the Claude hooks route of the loopback ingress with the token in the x-dwarfai-token header', () => {
    expect(buildHookCommand({ port: 45123, token: TOKEN, platform: 'linux' })).toBe(
      'curl -s -m 2 --noproxy 127.0.0.1 -X POST -H Content-Type:application/json -d@- ' +
        `-H x-dwarfai-token:${TOKEN} http://127.0.0.1:45123/hooks/claude/event`
    )
    // Windows names curl.exe: PowerShell aliases a bare `curl` to Invoke-WebRequest.
    expect(buildHookCommand({ port: 45123, token: TOKEN, platform: 'win32' })).toMatch(
      /^curl\.exe -s /
    )
    // Every argument is one whitespace-free, quote-free word: identical in sh, Git Bash and PowerShell.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const command = buildHookCommand({ port: 1, token: TOKEN, platform })
      expect(command).not.toMatch(/["'`;&|<>$()]/)
      expect(command.startsWith(ownedCommandPrefix(platform))).toBe(true)
    }
  })

  it('[ADR-016, C-21] a token that is not lower-case hex, or a port outside 1-65535, is refused before a command is built', () => {
    for (const token of ['', 'tok-1', 'A'.repeat(64), `${'a'.repeat(63)} `, 'abc', `${TOKEN};x`]) {
      expect(() => buildHookCommand({ port: 45123, token, platform: 'linux' })).toThrow(
        HostInvariantError
      )
    }
    for (const port of [0, 65536, 1.5, Number.NaN]) {
      expect(() => buildHookCommand({ port, token: TOKEN, platform: 'linux' })).toThrow(
        HostInvariantError
      )
    }
  })

  it("[ADR-016] the ownership probe matches DwarfAI's exact command prefix and nothing that merely mentions DwarfAI", () => {
    const ours = buildHookCommand({ port: 45123, token: TOKEN, platform: 'darwin' })
    expect(isOwnedHookCommand(ours, 'darwin')).toBe(true)
    // Another port or token is still DwarfAI's own entry, to be replaced.
    expect(
      isOwnedHookCommand(
        buildHookCommand({ port: 1, token: 'b'.repeat(64), platform: 'darwin' }),
        'darwin'
      )
    ).toBe(true)

    for (const foreign of [
      oldAppCommand('curl'),
      `echo ${ours}`,
      'notify-send dwarfai-miners-hook-watcher x-dwarfai-token',
      ownedCommandPrefix('darwin').slice(0, -1),
      42,
      null
    ]) {
      expect(isOwnedHookCommand(foreign, 'darwin')).toBe(false)
    }
    // The prefix is the platform's own: curl on macOS, curl.exe on Windows.
    expect(isOwnedHookCommand(ours, 'win32')).toBe(false)
  })

  it("[ADR-016] the legacy probe recognises only the old app's exact command form", () => {
    expect(isLegacyHookCommand(oldAppCommand('curl'))).toBe(true)
    expect(isLegacyHookCommand(oldAppCommand('curl.exe', 1))).toBe(true)

    for (const near of [
      buildHookCommand({ port: 45123, token: TOKEN, platform: 'linux' }),
      `${oldAppCommand('curl')}/opencode`,
      `${oldAppCommand('curl')} && echo`,
      ` ${oldAppCommand('curl')}`,
      oldAppCommand('curl', 45123, 'NOT-HEX-TOKEN-00'),
      oldAppCommand('wget'),
      'notify-send dwarfai-miners-hook',
      undefined
    ]) {
      expect(isLegacyHookCommand(near)).toBe(false)
    }
  })
})
