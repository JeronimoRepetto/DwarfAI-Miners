import { describe, expect, it, vi } from 'vitest'
import type { ShellRunner } from '../platform/focus'
import { workerSentinel, type ConsoleWorkerProcess } from './consoleWorker'
import { WindowsTextDelivery } from './windowsTextDelivery'

/** Hands out the given clock readings in order, so stage timings are exact. */
function clockOf(...readings: number[]): () => number {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0
}

/**
 * A long-lived shell that answers every request the instant it is written, so
 * a delivery can be awaited without a real process or a real timer.
 */
function autoReplyShell() {
  const written: string[] = []
  const kill = vi.fn()
  const end = vi.fn()
  let onData: ((chunk: string) => void) | undefined

  const process: ConsoleWorkerProcess = {
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
        const id = Number(/CONSOLE:(\d+):0/.exec(chunk)?.[1] ?? 0)
        onData?.(`${workerSentinel(id, 0)}\n`)
      },
      end
    },
    stdout: {
      setEncoding: vi.fn(),
      on: (_event, listener) => {
        onData = listener
      }
    },
    on: vi.fn(),
    kill
  }

  return { process, written, kill, end }
}

/**
 * The three answers the focus seam can give (#329).
 *
 * AMENDED throughout this file for #329: the seam answered a bare boolean
 * until keystrokes had to know WHICH window came forward. `own-console` is a
 * window this session is alone on, `terminal-host` one whose tab strip the
 * panel cannot see into — see FocusReach in platform/focus.ts.
 */
const OWN_CONSOLE = { focused: true, reach: 'own-console' } as const
const TERMINAL_HOST = { focused: true, reach: 'terminal-host' } as const
const NOT_FOCUSED = { focused: false, reach: null } as const

function delivery(overrides: Partial<ConstructorParameters<typeof WindowsTextDelivery>[0]> = {}) {
  return new WindowsTextDelivery({
    home: 'C:\\Users\\j',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: 'C:\\Windows' },
    focus: vi.fn().mockResolvedValue(OWN_CONSOLE),
    runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    ...overrides
  })
}

describe('WindowsTextDelivery.sendToConsole', () => {
  it('brings the hosting terminal forward before typing into it', async () => {
    const order: string[] = []
    const focus = vi.fn().mockImplementation(async () => {
      order.push('focus')
      return OWN_CONSOLE
    })
    const runPowerShell = vi.fn().mockImplementation(async () => {
      order.push('type')
      return { stdout: '', exitCode: 0 }
    })
    const port = delivery({ focus, runPowerShell })

    await expect(
      port.sendToConsole({ pid: 42, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({
      delivered: true,
      stages: { focusMs: expect.any(Number), spawnMs: expect.any(Number) }
    })
    expect(focus).toHaveBeenCalledWith(42)
    expect(order).toEqual(['focus', 'type'])
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('run the tests')")
  })

  it('never types anything when the terminal could not be foregrounded', async () => {
    const runPowerShell = vi.fn()
    const port = delivery({ focus: vi.fn().mockResolvedValue(NOT_FOCUSED), runPowerShell })

    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/foreground|terminal/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('reports a failure when the keystroke command exits non-zero', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
    })
    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })
    await expect(
      port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('keeps the message out of the failure text', async () => {
    const port = delivery({
      focus: vi.fn().mockResolvedValue(NOT_FOCUSED)
    })
    const result = await port.sendToConsole({
      pid: 42,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

/**
 * The paste path (#319): a MESSAGE is delivered by putting it on the clipboard
 * and pressing Ctrl+V, not by typing it character by character. `sendToConsole`
 * above is untouched — it still TYPES, and since #319 the one thing that still
 * needs it is the permission digit of #203, a measured keystroke a paste must
 * not silently replace.
 */
describe('WindowsTextDelivery.pasteToConsole', () => {
  /** Records reads and writes in `order`, so the save/restore dance is assertable. */
  function trackingClipboard(order: string[], initial = 'previous clipboard') {
    const writes: string[] = []
    let value = initial
    return {
      port: {
        read: () => {
          order.push('read')
          return value
        },
        write: (text: string) => {
          order.push('write')
          writes.push(text)
          value = text
        }
      },
      writes,
      current: () => value
    }
  }

  it('saves the clipboard, writes the message, focuses, pastes, then restores the clipboard', async () => {
    const order: string[] = []
    const focus = vi.fn().mockImplementation(async () => {
      order.push('focus')
      return OWN_CONSOLE
    })
    const runPowerShell = vi.fn().mockImplementation(async () => {
      order.push('paste')
      return { stdout: '', exitCode: 0 }
    })
    const clip = trackingClipboard(order)
    const port = delivery({ focus, runPowerShell, clipboard: clip.port })

    await expect(
      port.pasteToConsole({ pid: 42, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({
      delivered: true,
      stages: { focusMs: expect.any(Number), spawnMs: expect.any(Number) }
    })
    expect(focus).toHaveBeenCalledWith(42)
    expect(order).toEqual(['read', 'write', 'focus', 'paste', 'write'])
    // The message rode the clipboard; the command pressed the keys and never
    // carried the text a shell could re-parse.
    expect(clip.writes[0]).toBe('run the tests')
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^v')")
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('{ENTER}')")
    expect(runPowerShell.mock.calls[0]?.[0]).not.toContain('run the tests')
    // Left exactly as it was found.
    expect(clip.current()).toBe('previous clipboard')
    expect(clip.writes[clip.writes.length - 1]).toBe('previous clipboard')
  })

  it('pastes without an Enter when pressEnter is false', async () => {
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const clip = trackingClipboard([])
    const port = delivery({ runPowerShell, clipboard: clip.port })

    await port.pasteToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^v')")
    expect(runPowerShell.mock.calls[0]?.[0]).not.toContain("SendWait('{ENTER}')")
  })

  it('sends no paste and reports the fallback-triggering outcome when the window will not come forward', async () => {
    const runPowerShell = vi.fn()
    const clip = trackingClipboard([])
    const port = delivery({
      focus: vi.fn().mockResolvedValue(NOT_FOCUSED),
      runPowerShell,
      clipboard: clip.port
    })

    const result = await port.pasteToConsole({ pid: 42, text: 'hi', pressEnter: false })
    // `neverStarted` is the whole point: it proves nothing was pasted, so the
    // runtime may hand the same text to the relay without a double delivery.
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/foreground|terminal/i)
    // Nothing was pasted, and the clipboard is left holding what it held before —
    // never the message the method briefly set on it.
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(clip.current()).toBe('previous clipboard')
  })

  it('restores the clipboard even when the paste command throws', async () => {
    const clip = trackingClipboard([])
    const port = delivery({
      runPowerShell: vi.fn().mockRejectedValue(new Error('powershell.exe is missing')),
      clipboard: clip.port
    })

    const result = await port.pasteToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    // A throw can land after the paste, so it is NOT neverStarted: the runtime
    // must not relay the same text behind it.
    expect(result.neverStarted).toBeUndefined()
    expect(clip.current()).toBe('previous clipboard')
  })

  it('does not mark a non-zero paste exit as neverStarted, since Ctrl+V may already have landed', async () => {
    const clip = trackingClipboard([])
    const port = delivery({
      runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 }),
      clipboard: clip.port
    })

    const result = await port.pasteToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    expect(result.neverStarted).toBeUndefined()
    expect(clip.current()).toBe('previous clipboard')
  })

  it('keeps the message out of the failure text', async () => {
    const clip = trackingClipboard([])
    const port = delivery({ focus: vi.fn().mockResolvedValue(NOT_FOCUSED), clipboard: clip.port })
    const result = await port.pasteToConsole({
      pid: 42,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

describe('WindowsTextDelivery.relayToClaudeSession', () => {
  it('spawns one claude turn addressed at the target session', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({ runRelay })

    await expect(
      port.relayToClaudeSession({ sessionName: 'sample-project-70', text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })

    const invocation = runRelay.mock.calls[0]?.[0]
    expect(invocation.command).toBe('C:\\Users\\j\\.local\\bin\\claude.exe')
    expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe('haiku')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('sample-project-70')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('run the tests')
    expect(invocation.timeoutMs).toBe(60_000)
    expect(invocation.env.PATH).toBe('C:\\Users\\j\\.local\\bin;C:\\Windows')
  })

  it('treats a non-zero exit as an undelivered message', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 2, timedOut: false })
    })
    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('names the timeout when the relay ran out of time', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 1, timedOut: true })
    })
    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  })

  it('turns a failed spawn into a failed verdict instead of a rejection', async () => {
    const port = delivery({ runRelay: vi.fn().mockRejectedValue(new Error('ENOENT')) })
    await expect(
      port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('keeps the message out of the failure text', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 2, timedOut: false })
    })
    const result = await port.relayToClaudeSession({
      sessionName: 'x',
      text: 'my-secret-payload'
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

describe('WindowsTextDelivery.sendInterrupt', () => {
  it('brings the hosting terminal forward before sending the interrupt keystroke', async () => {
    const order: string[] = []
    const focus = vi.fn().mockImplementation(async () => {
      order.push('focus')
      return OWN_CONSOLE
    })
    const runPowerShell = vi.fn().mockImplementation(async () => {
      order.push('interrupt')
      return { stdout: '', exitCode: 0 }
    })
    const port = delivery({ focus, runPowerShell })

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toEqual({
      delivered: true,
      stages: { focusMs: expect.any(Number), spawnMs: expect.any(Number) }
    })
    expect(focus).toHaveBeenCalledWith(42)
    expect(order).toEqual(['focus', 'interrupt'])
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('{ESC}')")
  })

  it('never sends the keystroke when the terminal could not be foregrounded', async () => {
    const runPowerShell = vi.fn()
    const port = delivery({ focus: vi.fn().mockResolvedValue(NOT_FOCUSED), runPowerShell })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/foreground|terminal/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('reports a failure when the keystroke command exits non-zero', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
    })
    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })
    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: false })
  })
})

/**
 * A host-level focus is not enough for a keystroke (#329).
 *
 * Measured live: two Claude sessions in two tabs of ONE Windows Terminal
 * window, so neither `claude` owns a console of its own and the ancestor walk
 * reaches the shared host for both. Foregrounding that raises whichever tab the
 * person last used, and every keystroke after it went to THAT session — an Esc
 * meant for one foreman interrupted the other. Nothing typed is preferable, and
 * `neverStarted` is what lets the relay carry the message instead.
 */
describe('WindowsTextDelivery — a host window is never proof of the session (#329)', () => {
  function hostFocused(overrides: Parameters<typeof delivery>[0] = {}) {
    return delivery({ focus: vi.fn().mockResolvedValue(TERMINAL_HOST), ...overrides })
  }

  it('pastes nothing, and says the window is shared, so the relay may take the message', async () => {
    const runPowerShell = vi.fn()
    const port = hostFocused({ runPowerShell })

    const result = await port.pasteToConsole({ pid: 42, text: 'run the tests', pressEnter: true })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/shares its terminal window/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('types nothing, so a permission digit cannot land in another tab', async () => {
    const runPowerShell = vi.fn()
    const port = hostFocused({ runPowerShell })

    const result = await port.sendToConsole({ pid: 42, text: '1', pressEnter: false })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/shares its terminal window/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  /*
   * The keystroke this issue was reported for. Kick no longer takes this path
   * at all (it ends the process instead), but a permission DENY still presses
   * Esc through here, and an Esc into the wrong tab is the same lost turn.
   */
  it('sends no interrupt keystroke, which is the Esc that reached the wrong session', async () => {
    const runPowerShell = vi.fn()
    const port = hostFocused({ runPowerShell })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/shares its terminal window/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('restores the clipboard it had already saved, exactly as a failed focus does', async () => {
    const writes: string[] = []
    let value = 'previous clipboard'
    const clipboard = {
      read: () => value,
      write: (text: string) => {
        writes.push(text)
        value = text
      }
    }
    const port = hostFocused({ clipboard, runPowerShell: vi.fn() })

    await port.pasteToConsole({ pid: 42, text: 'my-secret-payload', pressEnter: true })
    expect(value).toBe('previous clipboard')
    expect(writes[writes.length - 1]).toBe('previous clipboard')
  })

  it('keeps the message out of the refusal', async () => {
    const port = hostFocused({ runPowerShell: vi.fn() })
    const result = await port.pasteToConsole({
      pid: 42,
      text: 'my-secret-payload',
      pressEnter: true
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

/**
 * Issue #21: a Kick or Send that "feels slow" was previously logged as nothing
 * but a verdict. Each tier now reports how long its own stages took, so the
 * runtime can put real numbers in the log instead of guesses.
 */
describe('WindowsTextDelivery stage instrumentation', () => {
  it('times bringing the window forward and running the keystroke command', async () => {
    const port = delivery({ now: clockOf(0, 12, 12, 42) })

    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.stages).toEqual({ focusMs: 12, spawnMs: 30 })
  })

  it('times the interrupt path the same way', async () => {
    const port = delivery({ now: clockOf(0, 5, 5, 25) })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.stages).toEqual({ focusMs: 5, spawnMs: 20 })
  })

  it('leaves the relay tier unmeasured here — the runtime times that call itself', async () => {
    const port = delivery({ now: clockOf(0, 5_210) })

    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.stages).toBeUndefined()
  })

  it('still reports the stages of an attempt that failed', async () => {
    const port = delivery({
      now: clockOf(0, 9),
      focus: vi.fn().mockResolvedValue(NOT_FOCUSED)
    })

    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    expect(result.stages).toEqual({ focusMs: 9 })
  })

  it('never puts the message anywhere near the timings', async () => {
    const port = delivery({ now: clockOf(0, 1, 1, 2) })

    const result = await port.sendToConsole({
      pid: 42,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(JSON.stringify(result)).not.toContain('my-secret-payload')
  })
})

/**
 * The persistent console worker: one powershell.exe carries every keystroke and
 * interrupt instead of paying a fresh -NoProfile start per action.
 */
describe('WindowsTextDelivery console transport', () => {
  function workerDelivery(spawnConsoleWorker: () => ConsoleWorkerProcess, fallback?: ShellRunner) {
    return new WindowsTextDelivery({
      home: 'C:\Users\j',
      relayModel: 'haiku',
      relayTimeoutMs: 60_000,
      env: { PATH: 'C:\Windows' },
      focus: vi.fn().mockResolvedValue(OWN_CONSOLE),
      runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
      spawnConsoleWorker,
      ...(fallback === undefined ? {} : { runPowerShell: fallback })
    })
  }

  it('runs every console action through one long-lived shell', async () => {
    const shell = autoReplyShell()
    const spawn = vi.fn(() => shell.process)
    const port = workerDelivery(spawn)

    await expect(
      port.sendToConsole({ pid: 42, text: 'one', pressEnter: false })
    ).resolves.toMatchObject({ delivered: true })
    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: true })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(shell.written).toHaveLength(2)
  })

  it('hands the existing command builders through untouched', async () => {
    const shell = autoReplyShell()
    const port = workerDelivery(() => shell.process)

    await port.sendInterrupt({ pid: 42 })

    const encoded = /FromBase64String\('([^']+)'\)/.exec(shell.written[0] ?? '')?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("SendWait('{ESC}')")
  })

  it('falls back to a per-action spawn when the persistent shell cannot be started', async () => {
    const fallback = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = workerDelivery(() => {
      throw new Error('ENOENT')
    }, fallback)

    await expect(
      port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: true })
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('reports a failed verdict, never a rejection, when both transports are gone', async () => {
    const fallback = vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    const port = workerDelivery(() => {
      throw new Error('ENOENT')
    }, fallback)

    await expect(
      port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('shuts the persistent shell down cleanly on dispose', async () => {
    const shell = autoReplyShell()
    const port = workerDelivery(() => shell.process)

    await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    port.dispose()

    expect(shell.end).toHaveBeenCalled()
    expect(shell.kill).toHaveBeenCalled()
  })

  it('is safe to dispose a port that never opened a shell', () => {
    const port = workerDelivery(() => autoReplyShell().process)
    expect(() => port.dispose()).not.toThrow()
  })
})

/**
 * The Codex message queue (#97). Windows is the platform this channel was
 * actually proven on, and it needs no PowerShell, no window and no pid — only
 * the detected binary and the thread UUID.
 */
describe('WindowsTextDelivery.queueToCodexThread', () => {
  const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'

  it('spawns the detected codex.exe with the thread and the message as argv', async () => {
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\.local\\bin\\codex.exe',
      runCodexQueue
    })

    await expect(
      port.queueToCodexThread({ threadId: THREAD_ID, text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })
    expect(runCodexQueue.mock.calls[0]?.[0]).toMatchObject({
      command: 'C:\\Users\\j\\.local\\bin\\codex.exe',
      args: ['queue', '--thread', THREAD_ID, '--message', 'run the tests']
    })
  })

  /**
   * The npm-global install's `.cmd` cannot be spawned without a shell, and a
   * shell would re-parse the payload. Refused with the remedy rather than run —
   * see isShellShimPath in codexQueue.ts.
   */
  it('refuses a .cmd shim rather than running the payload through a shell', async () => {
    const runCodexQueue = vi.fn()
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd',
      runCodexQueue
    })
    const outcome = await port.queueToCodexThread({ threadId: THREAD_ID, text: 'hi' })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('CODEX_CLI_PATH')
    expect(runCodexQueue).not.toHaveBeenCalled()
  })

  it('refuses with a reason when codex was never detected', async () => {
    const outcome = await delivery({ runCodexQueue: vi.fn() }).queueToCodexThread({
      threadId: THREAD_ID,
      text: 'hi'
    })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('never echoes the message back in a refusal', async () => {
    const outcome = await delivery({ runCodexQueue: vi.fn() }).queueToCodexThread({
      threadId: THREAD_ID,
      text: 'my-secret-payload'
    })
    expect(outcome.error).not.toContain('my-secret-payload')
  })
})

/**
 * Kick's terminal tier: ask the session to exit cleanly, then force it if it
 * will not (#358, over #329).
 *
 * #329 made this a pure tree kill — no window, no keystroke — because a pid
 * cannot be the wrong session the way a foreground window can. But a taskkill /F
 * gives the Claude TUI no chance to reset the terminal modes it turned on
 * (mouse tracking above all), so the console prints endless SGR mouse reports
 * afterwards. So #358 tries a clean exit FIRST — but only on a console this
 * session is provably alone on (#329's shared-tab refusal stays), and only for a
 * pid re-verified at the moment of the act (#231's fail-closed guard stays). The
 * force kill is the same per-OS port a launched session's exit uses (#217) and
 * is the fallback whenever the clean exit is unsafe or does not take.
 */
describe('WindowsTextDelivery.endConsoleSession', () => {
  /** The creation time the provider verified and put on the wire. */
  const EXPECTED_START_MS = 1_788_001_972_136

  /**
   * AMENDED throughout this block for the #329 review: an end now names the
   * creation time it expects, and the port re-probes the pid before killing it.
   * The four cases below are unchanged in what they assert.
   */
  function ender(
    endProcessTree = vi.fn().mockResolvedValue(true),
    processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS),
    extra: Parameters<typeof delivery>[0] = {}
  ) {
    const port = delivery({
      processEnd: { endProcessTree },
      processProbe: { isCodexProcessRunning: vi.fn(), processStartTimeMs },
      // #358: the graceful-first grace window polls the pid on an injected
      // delay, so a unit test resolves it instantly instead of waiting ~3s.
      sleep: async () => {},
      ...extra
    })
    return { port, endProcessTree, processStartTimeMs }
  }

  /*
   * AMENDED for #358 (was: "ends the session's own process tree without
   * touching a window", asserting focus was never called). #358 tries a clean
   * exit first, so it DOES focus the console now — but only to type into a
   * window this session is alone on. When the console will not come forward
   * there is nowhere safe to send the clean-exit keystroke, so no key is sent
   * and the forced tree kill still ends the session, exactly as #329 did.
   */
  it('sends no clean-exit keystroke when the console will not come forward, and force-kills the tree (#358)', async () => {
    const focus = vi.fn().mockResolvedValue(NOT_FOCUSED)
    const runPowerShell = vi.fn()
    const { port, endProcessTree } = ender(undefined, undefined, { focus, runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(endProcessTree).toHaveBeenCalledWith(4242)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  /*
   * taskkill exits 128 for a pid it cannot find, and the port already reports
   * that as false rather than as an ended session (see processEnd.ts). A second
   * kick therefore reports a refusal, never a second success — the exit-0-shaped
   * lie this repo keeps refusing to tell.
   */
  it('reports a refusal when the platform would not end the tree', async () => {
    const { port } = ender(vi.fn().mockResolvedValue(false))
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('turns a throwing port into a failed verdict instead of a rejection', async () => {
    const { port } = ender(vi.fn().mockRejectedValue(new Error('taskkill is missing')))
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('times the end the way every other tier times its own work', async () => {
    const { port } = ender(undefined, undefined, { now: clockOf(0, 40) })
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.stages).toEqual({ spawnMs: 40 })
  })

  /*
   * The pid is re-verified at the moment of the act — #231's rule, which the
   * launched tier already holds — rather than trusted from the poll that
   * produced it. A poll can be two seconds old, a pid can be recycled in
   * between, and `taskkill /T` on a recycled pid ends a stranger's program and
   * everything under it.
   *
   * This is the one place in the app where UNKNOWN is a refusal. The liveness
   * guard fails OPEN because a wrong "dead" only hides a dwarf; a kill fails
   * CLOSED because it cannot be taken back.
   */
  it('probes the pid immediately before the kill, and kills only on agreement', async () => {
    const order: string[] = []
    const processStartTimeMs = vi.fn().mockImplementation(async () => {
      order.push('probe')
      return EXPECTED_START_MS
    })
    const endProcessTree = vi.fn().mockImplementation(async () => {
      order.push('kill')
      return true
    })
    const { port } = ender(endProcessTree, processStartTimeMs)

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    // AMENDED for #358: the graceful attempt and its grace-window poll probe the
    // pid first, so the invariant is now that the FORCED path re-probes
    // immediately before it kills — the last two acts are that verified probe
    // and the kill it licenses.
    expect(order.slice(-2)).toEqual(['probe', 'kill'])
    // One pid throughout, asked about and then acted on — never a different one.
    expect(processStartTimeMs).toHaveBeenCalledWith(4242)
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  it('accepts a reading inside the same tolerance the provider used', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockResolvedValue(EXPECTED_START_MS + 1_500)
    )
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(endProcessTree).toHaveBeenCalled()
  })

  it('kills nothing when the pid now belongs to another process', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockResolvedValue(EXPECTED_START_MS + 60_000)
    )
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/could not be verified/i)
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('kills nothing when the probe cannot answer, unlike the liveness guard', async () => {
    const { port, endProcessTree } = ender(undefined, vi.fn().mockResolvedValue(null))
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('kills nothing when the probe itself throws', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockRejectedValue(new Error('powershell is missing'))
    )
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: false })
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * The clean-exit-first path (#358). On a console this session is alone on, the
   * kick presses Ctrl+C twice — the measured way the Claude TUI exits and
   * restores the terminal — and polls the pid for a bounded grace. The moment
   * the pid stops being this session, the terminal was handed back by the TUI's
   * own exit, so the force kill is never reached.
   */
  it('asks the session to exit cleanly and, once it goes, never force-kills it', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    // Verified alive at the keystroke, still there on the first look, then gone.
    const processStartTimeMs = vi
      .fn()
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValue(null)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    // Ctrl+C twice was the whole act; the /F kill never ran.
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^c')")
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * The fallback stays exactly the forced kill it always was. A session that
   * does not go within the grace window is force-killed, and the outcome is the
   * same delivered:true #329 produced — the clean exit is an attempt, never a
   * replacement for the guarantee.
   */
  it('force-kills the session when the clean exit does not take within the grace window', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    // Never goes: verified alive at the keystroke and on every poll after it.
    const processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^c')")
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * #329's shared-tab refusal survives #358 unchanged. A keystroke into a
   * terminal-host window lands in whichever tab is active, so no clean-exit
   * keystroke is sent there — the kick goes straight to the forced tree kill,
   * which needs no window and cannot miss.
   */
  it('sends no clean-exit keystroke into a shared terminal window, and force-kills instead (#329)', async () => {
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const { port, endProcessTree } = ender(undefined, undefined, {
      focus: vi.fn().mockResolvedValue(TERMINAL_HOST),
      runPowerShell
    })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * The clean-exit keystroke obeys the same fail-closed pid guard the kill does
   * (#231): a pid whose creation time no longer matches is not proven to be this
   * session, so nothing is typed at it AND nothing is killed. The forced
   * fallback re-probes the same mismatch and refuses with SESSION_NOT_VERIFIED,
   * exactly as it did before #358.
   */
  it('sends no clean-exit keystroke when the pid no longer matches, and refuses as today', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS + 60_000)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/could not be verified/i)
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(endProcessTree).not.toHaveBeenCalled()
  })
})
