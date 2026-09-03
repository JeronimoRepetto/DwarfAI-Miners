import { describe, expect, it, vi } from 'vitest'
import { MAX_DWARF_TEXT_CHARS, type DwarfProvider } from '../domain/types'
import type { CliDetection, CliDetector } from '../platform/cliDetection'
import { launchClaudeSession, type LaunchInvocation } from './launchRunner'

const CLAUDE_PATH = '/home/j/.local/bin/claude'
const CODEX_PATH = '/home/j/.local/bin/codex'
const MINE_PATH = '/home/j/work/project'

function detector(verdict: CliDetection): CliDetector {
  return { detect: vi.fn().mockResolvedValue(verdict), peek: vi.fn().mockReturnValue(verdict) }
}

function installed(): CliDetector {
  return detector({ cli: 'claude', installed: true, path: CLAUDE_PATH, source: 'convention' })
}

function installedCodex(): CliDetector {
  return detector({ cli: 'codex', installed: true, path: CODEX_PATH, source: 'convention' })
}

function launch(options: {
  provider?: DwarfProvider
  prompt?: string
  cli?: CliDetector
  run?: (invocation: LaunchInvocation) => Promise<void>
  env?: NodeJS.ProcessEnv
}) {
  const run = options.run ?? vi.fn().mockResolvedValue(undefined)
  return {
    run,
    result: launchClaudeSession({
      provider: options.provider ?? 'claude',
      minePath: MINE_PATH,
      prompt: options.prompt ?? 'set up the build',
      detector: options.cli ?? installed(),
      env: options.env ?? { PATH: '/usr/bin' },
      platform: 'linux',
      run
    })
  }
}

describe('launchClaudeSession', () => {
  it('starts the detected binary in the mine folder, with the prompt on stdin', async () => {
    const { run, result } = launch({ prompt: 'set up the build' })

    await expect(result).resolves.toEqual({ launched: true, provider: 'claude' })
    expect(run).toHaveBeenCalledTimes(1)
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    // cwd is the whole trick: aggregation groups sessions by cwd, so this is
    // what puts the new dwarf in the mine the user launched it from.
    expect(invocation.cwd).toBe(MINE_PATH)
    expect(invocation.command).toBe(CLAUDE_PATH)
    expect(invocation.stdin).toBe('set up the build')
  })

  it('never puts the prompt in argv, where any process on this machine could read it', async () => {
    const secret = 'rotate the deploy key'
    const { run, result } = launch({ prompt: secret })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args.join(' ')).not.toContain(secret)
    expect(invocation.args).not.toContain(secret)
  })

  it("leads the child's PATH with the binary's own directory", async () => {
    // Same reason the relay does it: a re-exec of `claude` inside the child
    // must find the real binary rather than a shim earlier on PATH.
    const { run, result } = launch({ env: { PATH: '/usr/bin' } })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.env.PATH).toBe('/home/j/.local/bin:/usr/bin')
  })

  it('trims and caps the prompt before it reaches the child', async () => {
    const { run, result } = launch({ prompt: `  ${'x'.repeat(MAX_DWARF_TEXT_CHARS + 100)}  ` })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.stdin).toHaveLength(MAX_DWARF_TEXT_CHARS)
  })

  it('refuses an empty prompt without probing the disk or spawning anything', async () => {
    const cli = installed()
    const { run, result } = launch({ prompt: '   ', cli })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'none',
      error: 'Type a prompt first.'
    })
    expect(run).not.toHaveBeenCalled()
    expect(cli.detect).not.toHaveBeenCalled()
  })

  it('gives "not installed" its own reason, carrying what detection said', async () => {
    const { run, result } = launch({
      cli: detector({ cli: 'claude', installed: false, reason: 'claude not found on PATH' })
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: 'Claude Code is not installed on this machine. claude not found on PATH'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('still refuses when detection claims installed but names no path', async () => {
    const { run, result } = launch({ cli: detector({ cli: 'claude', installed: true }) })

    await expect(result).resolves.toMatchObject({ launched: false, provider: 'claude' })
    expect(run).not.toHaveBeenCalled()
  })

  it('maps a spawn failure to a stated reason rather than a silent no-op', async () => {
    const { result } = launch({
      run: vi.fn().mockRejectedValue(new Error('ENOENT'))
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: 'Claude Code could not be started.'
    })
  })

  it('claims only that the process started, never that a dwarf exists', async () => {
    // The exact shape is the assertion: a launch result carries no dwarf id and
    // no mine, because the poll — not this call — is what discovers the session.
    await expect(launch({}).result).resolves.toEqual({ launched: true, provider: 'claude' })
  })

  /*
   * #168. This function used to take no provider and detect the literal
   * 'claude', so every chip in the Add Panel reached the same binary. It now
   * asks for the provider it was given, and refuses one it has no invocation
   * for BY NAME rather than falling back — a fallback here would start Claude
   * for a user who pressed something else, in a real folder.
   */
  it('detects the provider it was asked for rather than a hardcoded one', async () => {
    const cli = installed()
    await launch({ cli }).result

    expect(cli.detect).toHaveBeenCalledWith('claude')
  })

  it('detects Codex, not Claude, when Codex is the provider asked for', async () => {
    const cli = installedCodex()
    await launch({ provider: 'codex', cli }).result

    expect(cli.detect).toHaveBeenCalledWith('codex')
  })
})

/*
 * Codex's launch, and what it can honestly be (#168).
 *
 * NOT a held session. docs/command-surface-evaluation.md states that "Codex has
 * no held-session engine in this app (no equivalent of `sdkHeldSession.ts`
 * exists for it)", and docs/question-capture-evaluation.md's matrix marks the
 * `codex exec` row's live capture and answering both No. So this is the
 * detached shape and only that: a process started in the mine's folder, let go
 * of, and discovered afterwards by the ordinary poll reading Codex's own
 * rollout storage — where `threads.cwd` is what puts it in the right mine, the
 * same trick the Claude launch relies on.
 */
describe('launching Codex', () => {
  it('starts the detected codex binary in the mine folder, with the prompt on stdin', async () => {
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), prompt: 'dig' })

    await expect(result).resolves.toEqual({ launched: true, provider: 'codex' })
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(CODEX_PATH)
    // cwd is the whole trick here too: the Codex provider reads a thread's own
    // `cwd` column, so this is what files the new session under the right mine.
    expect(invocation.cwd).toBe(MINE_PATH)
    expect(invocation.args).toEqual(['exec', '-'])
    expect(invocation.stdin).toBe('dig')
  })

  it('never puts the prompt in argv for Codex either', async () => {
    const secret = 'rotate the deploy key'
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), prompt: secret })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args.join(' ')).not.toContain(secret)
  })

  it('says Codex is missing in Codex’s own words, carrying what detection said', async () => {
    // "Claude Code is not installed" for a Codex chip would be this app naming
    // the wrong program at the one moment the user can act on the answer.
    const { run, result } = launch({
      provider: 'codex',
      cli: detector({ cli: 'codex', installed: false, reason: 'codex not found on PATH' })
    })

    const verdict = await result
    expect(verdict.provider).toBe('codex')
    expect(verdict.error).toContain('Codex')
    expect(verdict.error).not.toContain('Claude')
    expect(verdict.error).toContain('codex not found on PATH')
    expect(run).not.toHaveBeenCalled()
  })

  /*
   * The npm-global install, which is the common one for Codex on Windows.
   * `spawn('codex.cmd', …, { shell: false })` throws EINVAL — verified against
   * this machine's Node — and the shell that would fix it is exactly what a
   * launcher handling user text must not introduce. So it is refused with the
   * one thing the user can act on, and the escape hatch is the CLI-path
   * override the config already has.
   */
  it('refuses a shell shim rather than failing opaquely, and says what to set', async () => {
    const shim = 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd'
    const { run, result } = launch({
      provider: 'codex',
      cli: detector({ cli: 'codex', installed: true, path: shim, source: 'path' })
    })

    const verdict = await result
    expect(verdict.launched).toBe(false)
    expect(verdict.provider).toBe('codex')
    expect(verdict.error).toContain('CODEX_CLI_PATH')
    expect(run).not.toHaveBeenCalled()
  })

  it('never publishes the shim path it refused', async () => {
    // Fixed copy only: a detected path names this machine's filesystem, and the
    // wire is where it stops (docs/privacy.md, #59).
    const shim = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd'
    const verdict = await launch({
      provider: 'codex',
      cli: detector({ cli: 'codex', installed: true, path: shim, source: 'path' })
    }).result

    expect(verdict.error).not.toContain('someone')
    expect(verdict.error).not.toContain('.cmd')
  })

  it('claims only that the process started, and never a dwarf', async () => {
    // Codex's dwarf is discovered by the poll off its rollout storage, up to a
    // poll interval later, exactly as a session a human started is.
    await expect(launch({ provider: 'codex', cli: installedCodex() }).result).resolves.toEqual({
      launched: true,
      provider: 'codex'
    })
  })
})
