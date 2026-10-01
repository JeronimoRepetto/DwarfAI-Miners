import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'

/**
 * Starts a throwaway Electron app for an OS-lane test (L8, 17 §1.8) and collects what its main
 * process prints, line by line. It lives outside `src/` because a test of the Electron tree
 * (`src/ui-main/**`) may not import `node:child_process` itself (05 §5.1 R17 keeps process
 * spawning to the listed platform and launcher paths); like the E2E harness, the test tooling
 * that launches the app is not part of the app.
 */

/** The Electron binary of the installed `electron` package (its main export is the path). */
const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

const POLL_MS = 50
/** How much of stderr `describe()` keeps, and how many stdout lines it shows. */
const STDERR_TAIL_CHARS = 4_000
const STDOUT_TAIL_LINES = 20

export class ElectronProcess {
  readonly lines: string[] = []
  readonly exited: Promise<number | null>
  private buffer = ''
  private stderrTail = ''
  private closed = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      const parts = this.buffer.split(/\r?\n/)
      this.buffer = parts.pop() ?? ''
      this.lines.push(...parts.map((line) => line.trim()).filter((line) => line !== ''))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    // 'close' comes after the output streams ended, so nothing printed is still on its way.
    child.once('close', () => {
      this.closed = true
    })
  }

  /**
   * Starts Electron on `appDir` (a folder with a `package.json` naming its main script). The
   * environment never carries `ELECTRON_RUN_AS_NODE`, so the binary always starts as Electron.
   */
  static start(
    appDir: string,
    env: NodeJS.ProcessEnv,
    flags: readonly string[] = []
  ): ElectronProcess {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    return new ElectronProcess(
      spawn(electronBinary, [appDir, ...flags], { env: childEnv, stdio: 'pipe' })
    )
  }

  /** Whether the process is still running. */
  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * The first line the process printed, or null when it printed none within `timeoutMs` or ended without
   * printing one.
   */
  async firstLine(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (this.lines.length === 0 && !this.closed && Date.now() <= deadline) await sleep(POLL_MS)
    return this.lines[0] ?? null
  }

  /** The process's state and the tail of what it printed, for an assertion message that explains a failure. */
  describe(): string {
    const state = this.running
      ? 'still running'
      : `exited with code ${String(this.child.exitCode)}, signal ${String(this.child.signalCode)}`
    const stdout = [...this.lines, this.buffer.trim()].filter((line) => line !== '')
    return [
      `Electron ${state}`,
      'stdout (tail):',
      stdout.slice(-STDOUT_TAIL_LINES).join('\n') || '(nothing)',
      'stderr (tail):',
      this.stderrTail.trim() || '(nothing)'
    ].join('\n')
  }

  /** How many printed lines equal `line`, once at least `count` did or `timeoutMs` passed. */
  async count(line: string, count: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs
    const seen = (): number => this.lines.filter((printed) => printed === line).length
    while (seen() < count && Date.now() <= deadline) await sleep(POLL_MS)
    return seen()
  }

  /** Ends the process if it still runs, and waits for its exit. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.child.kill()
    await this.exited
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
