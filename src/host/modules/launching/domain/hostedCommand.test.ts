// The 12 tests of `src/main/sessionLaunch/hostedCommand.test.ts` (at 0bfd108), transplanted unchanged
// into launching's domain (17 §2.5; 21 §6), then one new row (ISSUE-165). TC-165-01: the 12 pass
// unchanged in the new home (NFR-SEC-09). TC-165-02 (with wiring/flows/launchOther.test.ts): every
// metacharacter, an unclosed quote and a shim are refused before any spawn (S5.17, NFR-SEC-09).
import { describe, expect, it } from 'vitest'
import {
  SHELL_METACHARACTER_REFUSAL,
  SHIM_REFUSAL,
  UNCLOSED_QUOTE_REFUSAL,
  parseHostedCommand
} from './hostedCommand'

/*
 * The parse behind Add > Other (#194). Pure, so the whole security posture of
 * "no shell, ever" is asserted here rather than inferred from a spawn nobody
 * runs in the suite.
 */

describe('parseHostedCommand', () => {
  it('splits a bare program name into a program and no arguments', () => {
    expect(parseHostedCommand('my-agent')).toEqual({
      ok: true,
      program: 'my-agent',
      args: []
    })
  })

  it('splits a program and its flags on whitespace, in order', () => {
    expect(parseHostedCommand('my-agent --do-the-thing --twice')).toEqual({
      ok: true,
      program: 'my-agent',
      args: ['--do-the-thing', '--twice']
    })
  })

  it('collapses the runs of whitespace a text box collects', () => {
    expect(parseHostedCommand('  my-agent   --flag \t --other  ')).toEqual({
      ok: true,
      program: 'my-agent',
      args: ['--flag', '--other']
    })
  })

  /*
   * The design source's own two examples (`screens/launch.md`): they are
   * illustrations of a custom command rather than a supported syntax, and this
   * only pins that neither is mangled on the way through.
   */
  it("passes the design source's own example commands through unchanged", () => {
    expect(parseHostedCommand('/localhost:7654')).toEqual({
      ok: true,
      program: '/localhost:7654',
      args: []
    })
    expect(parseHostedCommand('/Lalolanda')).toEqual({
      ok: true,
      program: '/Lalolanda',
      args: []
    })
  })

  it('refuses a box with nothing in it', () => {
    expect(parseHostedCommand('   \n\t ').ok).toBe(false)
  })

  /*
   * The posture docs/custom-launch-command.md described as buildable and never
   * built: no shell anywhere, the command resolved as a program name plus an
   * argv array, anything carrying shell metacharacters refused. A refusal is
   * the whole point — `spawn` is called with `shell: false`, so a pipeline
   * would not be interpreted, it would be handed to the program as literal
   * arguments and silently do something else than what was typed.
   */
  it.each([
    ['a pipeline', 'my-agent | tee log.txt'],
    ['a chain', 'my-agent && rm -rf .'],
    ['a background operator', 'my-agent &'],
    ['a statement separator', 'my-agent; whoami'],
    ['a redirection', 'my-agent > out.txt'],
    ['an input redirection', 'my-agent < in.txt'],
    ['a subshell', 'my-agent $(whoami)'],
    ['a backtick substitution', 'my-agent `whoami`'],
    ['a variable expansion', 'my-agent $HOME'],
    ['a Windows variable expansion', 'my-agent %USERPROFILE%'],
    ['a newline', 'my-agent\nwhoami']
  ])('refuses %s, naming the shell metacharacter rule', (_what, typed) => {
    const parsed = parseHostedCommand(typed)

    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toBe(SHELL_METACHARACTER_REFUSAL)
  })

  /*
   * Grouping, not a shell: double quotes hold one argument together and are
   * removed, with no expansion, no escapes and no nesting. Without it the most
   * ordinary Windows spelling of a program path is refused for being correct.
   */
  it('takes a quoted path as one program, quotes removed', () => {
    expect(parseHostedCommand('"C:\\Program Files\\my agent\\agent.exe" --once')).toEqual({
      ok: true,
      program: 'C:\\Program Files\\my agent\\agent.exe',
      args: ['--once']
    })
  })

  it('takes a quoted argument as one argument', () => {
    expect(parseHostedCommand('my-agent --dir "C:\\two words"')).toEqual({
      ok: true,
      program: 'my-agent',
      args: ['--dir', 'C:\\two words']
    })
  })

  it('refuses a quote that is never closed rather than guessing where it ended', () => {
    expect(parseHostedCommand('my-agent "C:\\Program Files\\agent.exe').ok).toBe(false)
  })

  it('refuses a single quote, which groups on POSIX and is literal on Windows', () => {
    // Two shells disagree about what it means, so this app declines to pick.
    expect(parseHostedCommand("my-agent 'one two'").ok).toBe(false)
  })

  /*
   * Verified against this machine's Node (v24.11.1) for #193: `spawn` of a
   * `.cmd`/`.bat` with `shell: false` throws EINVAL since the CVE-2024-27980
   * fix. A hosted process is spawned without a shell like every other launch
   * here, so a shim is refused BY NAME rather than left to fail as "could not
   * be started" — the same reasoning launchRunner's PRODUCT_NAME follows: the
   * refusal a person can act on must say what it is refusing.
   *
   * Slice 1 does not read the shim for the program it points at, which is what
   * #193 taught the detected-CLI launcher to do. It cannot: that reading starts
   * from a path detection produced, and this starts from a name somebody typed.
   */
  it.each([
    ['a Windows cmd shim', 'C:\\Users\\x\\AppData\\Roaming\\npm\\my-agent.cmd'],
    ['a Windows bat shim', 'C:\\tools\\my-agent.bat'],
    ['a shim in any case, because Windows paths are', 'C:\\tools\\MY-AGENT.CMD']
  ])('refuses %s, because it cannot be spawned without a shell', (_what, typed) => {
    const parsed = parseHostedCommand(typed)

    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toBe(SHIM_REFUSAL)
  })

  it('names no path in either refusal, so the copy can be shown as it is', () => {
    // The wire rule AgentProviderOption states: a reason is fixed copy and
    // never this machine's filesystem. These two are shown in the panel.
    expect(SHELL_METACHARACTER_REFUSAL).not.toMatch(/[/\\]/)
    expect(SHIM_REFUSAL).not.toMatch(/[/\\]/)
  })
})

/*
 * ISSUE-165's new row (18 C-17, T-19; ADR-020 item 3): the whole refusal set at once, every
 * metacharacter one by one, so a character dropped from the rule fails here by name. The parse is
 * what runs before any spawn: launching settles a refusal `could-not-start` and spawns nothing.
 */
describe('parseHostedCommand refusals (ISSUE-165)', () => {
  it('[NFR-SEC-09, S5.17] every shell metacharacter, an unclosed quote and a .cmd or .bat shim are refused before any spawn', () => {
    const metacharacters = ['&', '|', ';', '<', '>', '(', ')', '$', '`', "'", '%', '\n', '\r']
    for (const character of metacharacters) {
      const parsed = parseHostedCommand(`my-agent --flag${character}x`)
      expect(parsed, `metacharacter ${JSON.stringify(character)}`).toEqual({
        ok: false,
        reason: SHELL_METACHARACTER_REFUSAL
      })
    }
    expect(parseHostedCommand('my-agent "never closed')).toEqual({
      ok: false,
      reason: UNCLOSED_QUOTE_REFUSAL
    })
    for (const shim of ['my-agent.cmd', 'my-agent.bat', 'C:\\tools\\My-Agent.Bat --once']) {
      expect(parseHostedCommand(shim), shim).toEqual({ ok: false, reason: SHIM_REFUSAL })
    }
  })
})
