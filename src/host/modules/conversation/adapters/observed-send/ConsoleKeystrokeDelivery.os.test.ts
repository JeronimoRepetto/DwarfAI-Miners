// L8 OS lane (17 §1.8): the observed-session key relay over the real kernel `NodeProcessControl`,
// delivering to stub processes the test starts itself (fixtures/bin/console-keys), never a real
// provider CLI and never a visible terminal. Runs only in `pnpm test:os`, one describe per OS.
//
// - Windows: the stub is a "terminal session" reading its own console's input buffer; the hidden
//   console every `windowsHide` child gets is the console the relay attaches to by pid. Its report
//   is every chunk it received, so "exactly 1 or Esc and nothing else" is read off the real buffer.
// - macOS and Linux: `ps` and `tmux` are stubs (the tmux stub records each `send-keys` argv); the
//   identity check runs against a real live process. A real tmux pane and a real Terminal.app tab
//   are the maintainer's lane (no tmux and no GUI terminal on CI runners).
//
// ISSUE-134's L8 case is here (its relay is this delivery behind wiring/bridges/keystrokeRelay.ts).
// Every process is the test's own and is ended by closing its stdin, then awaited.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'
import type { SpawnedProcess } from '../../../../kernel/ports/processControl'
import { NodeScheduler } from '../../../../platform/clock/NodeScheduler'
import { NodeProcessControl } from '../../../../platform/process/NodeProcessControl'
import {
  ConsoleKeystrokeDelivery,
  TOOL_ENV_NAMES,
  type ConsoleKeystrokeDeliveryDeps
} from './ConsoleKeystrokeDelivery'
import {
  POWERSHELL_ARGS,
  powerShellStdinLine,
  windowsKeyWriteScript,
  type ConsoleKey
} from './consoleKeys'

const STUB = fileURLToPath(
  new URL('../../../../../../fixtures/bin/console-keys/console-keys.mjs', import.meta.url)
)
const SLEEPER = fileURLToPath(
  new URL('../../../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)
const ONE: ConsoleKey = { kind: 'text', text: '1' }
const ESC: ConsoleKey = { kind: 'escape' }
/** How long a stub is watched after a press for anything beyond the one key. */
const QUIET_MS = 500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The environment a stub process gets: only what node needs to start on each OS. */
function toolEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function lane() {
  const control = new NodeProcessControl()
  const children: SpawnedProcess[] = []
  const folders: string[] = []
  const taskErrors: unknown[] = []

  afterEach(async () => {
    for (const child of children) child.stdin?.end()
    await Promise.all(
      children.splice(0).map((child) => Promise.race([child.exited, sleep(10_000)]))
    )
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
    expect(taskErrors.splice(0)).toEqual([])
  })

  function start(args: readonly string[]): SpawnedProcess {
    const child = control.spawn({
      executable: process.execPath,
      args: [...args],
      env: toolEnv(),
      cwd: dirname(STUB),
      processGroup: 'inherit',
      stdio: 'pipe'
    })
    children.push(child)
    return child
  }

  function folder(): string {
    const made = mkdtempSync(join(tmpdir(), 'dwarfai-keys-'))
    folders.push(made)
    return made
  }

  function delivery(deps: Partial<ConsoleKeystrokeDeliveryDeps>): ConsoleKeystrokeDelivery {
    return new ConsoleKeystrokeDelivery({
      processes: control,
      platform: process.platform,
      env: process.env,
      cwd: tmpdir(),
      scheduler: new NodeScheduler({ onTaskError: (error) => taskErrors.push(error) }),
      ...deps
    })
  }

  return { control, start, folder, delivery }
}

/** A recycled pid: the same pid, a start time past the one tolerance. */
const recycled = (identity: ProcessIdentity): ProcessIdentity => ({
  ...identity,
  processStartTimeMs: identity.processStartTimeMs - PROCESS_START_TOLERANCE_MS - 1
})

describe.runIf(process.platform === 'win32')('ConsoleKeystrokeDelivery on Windows (L8)', () => {
  const { control, start, delivery } = lane()

  /** Starts the stub session and resolves once it listens on its console's input. */
  async function session() {
    const child = start([STUB, 'reader', '60000'])
    const lines: string[] = []
    let buffered = ''
    let listening!: () => void
    const ready = new Promise<void>((resolve) => (listening = resolve))
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (line.trim() === 'ready') listening()
        else lines.push(line.trim())
      }
    })
    await ready
    return { identity: await child.identity, lines }
  }

  async function keysAfter(lines: string[], ms = QUIET_MS): Promise<string[]> {
    const deadline = Date.now() + 10_000
    while (lines.length === 0 && Date.now() < deadline) await sleep(50)
    await sleep(ms)
    return [...lines]
  }

  /**
   * When a press was refused, why: the relay's own PowerShell step run again by hand on the same target, its exit code
   * (2 attach, 3 CONIN$, 4 write; 1 a script error) and the start of its errors. Diagnostic only:
   * the expectation it explains stays as it is.
   */
  async function whyRefused(pid: number, key: ConsoleKey): Promise<string> {
    const written = windowsKeyWriteScript(pid, key)
    if (written === null) return 'no script for this key'
    // Each step announces itself on stderr before it runs, so a hung run names the step it hung in.
    const mark = (step: string) => `[Console]::Error.WriteLine('step ${step}')`
    const script = written
      .split('\n')
      .flatMap((line) => {
        if (line.startsWith('$assembly')) return [mark('declare'), line]
        if (line.startsWith('$buffer')) return [mark('buffer'), line]
        if (line.startsWith('[void]$kernel32::FreeConsole()')) return [mark('free'), line]
        if (line.startsWith('if (-not $kernel32::AttachConsole')) return [mark('attach'), line]
        if (line.startsWith('$conin')) return [mark('conin'), line]
        if (line.startsWith('$ok')) return [mark('write'), line]
        if (line === 'exit 0') return [mark('exit'), line]
        return [line]
      })
      .join('\n')
    const env: Record<string, string> = {}
    for (const name of TOOL_ENV_NAMES) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    const child = control.spawn({
      executable: 'powershell.exe',
      args: [...POWERSHELL_ARGS],
      env,
      cwd: tmpdir(),
      processGroup: 'inherit',
      stdio: 'pipe'
    })
    let errors = ''
    child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')))
    child.stdout?.resume()
    child.stdin?.end(powerShellStdinLine(script))
    const exit = await Promise.race([child.exited, sleep(20_000).then(() => null)])
    if (exit === null) {
      await control.killTree(await child.identity, { graceMs: 0, group: 'foreign' }).catch(() => {})
    }
    return `PowerShell exit ${JSON.stringify(exit)}, stderr ${errors.slice(0, 900)}`
  }

  it('[ADR-012] the relay delivers exactly the keys 1 or Esc to the stub and nothing else', async () => {
    const allow = await session()
    const pressed = await delivery({}).press(allow.identity, ONE)
    expect(pressed, pressed === 'pressed' ? '' : await whyRefused(allow.identity.pid, ONE)).toBe(
      'pressed'
    )
    expect(await keysAfter(allow.lines)).toEqual(['key 31'])

    const deny = await session()
    expect(await delivery({}).press(deny.identity, ESC)).toBe('pressed')
    expect(await keysAfter(deny.lines)).toEqual(['key 1b'])
  }, 60_000)

  it('[ADR-014, INV-51] a process whose identity no longer matches is never written to', async () => {
    const target = await session()
    expect(await delivery({}).press(recycled(target.identity), ONE)).toBe('refused')
    expect(await delivery({}).press({ ...target.identity, bootId: 'an-earlier-boot' }, ESC)).toBe(
      'refused'
    )
    await sleep(QUIET_MS * 2)
    expect(target.lines).toEqual([])
  }, 60_000)
})

describe.runIf(process.platform !== 'win32')(
  'ConsoleKeystrokeDelivery on macOS and Linux (L8)',
  () => {
    const { start, folder, delivery } = lane()

    function stubbed(record: string): Partial<ConsoleKeystrokeDeliveryDeps> {
      return {
        commands: {
          ps: { executable: process.execPath, prefix: [STUB, 'ps', 'pts/77'] },
          tmux: { executable: process.execPath, prefix: [STUB, 'tmux', 'pts/77', record] }
        }
      }
    }

    function recorded(record: string): unknown[] {
      try {
        return readFileSync(record, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as unknown)
      } catch {
        return []
      }
    }

    it('[ADR-012] the relay delivers exactly the keys 1 or Esc to the stub and nothing else', async () => {
      const identity = await start([SLEEPER, 'sleep', '60000']).identity
      const record = join(folder(), 'sent.jsonl')

      expect(await delivery(stubbed(record)).press(identity, ONE)).toBe('pressed')
      expect(await delivery(stubbed(record)).press(identity, ESC)).toBe('pressed')
      expect(recorded(record)).toEqual([
        ['send-keys', '-t', '%7', '-l', '1'],
        ['send-keys', '-t', '%7', 'Escape']
      ])
    }, 60_000)

    it('[ADR-014, INV-51] a process whose identity no longer matches is never written to', async () => {
      const identity = await start([SLEEPER, 'sleep', '60000']).identity
      const record = join(folder(), 'sent.jsonl')

      expect(await delivery(stubbed(record)).press(recycled(identity), ONE)).toBe('refused')
      expect(
        await delivery(stubbed(record)).press({ ...identity, bootId: 'an-earlier-boot' }, ESC)
      ).toBe('refused')
      expect(recorded(record)).toEqual([])
    }, 60_000)
  }
)
