import { describe, expect, it, vi } from 'vitest'
import type { ShellRunner } from '../focus'
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

function delivery(overrides: Partial<ConstructorParameters<typeof WindowsTextDelivery>[0]> = {}) {
  return new WindowsTextDelivery({
    home: 'C:\\Users\\j',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: 'C:\\Windows' },
    focus: vi.fn().mockResolvedValue(true),
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
      return true
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
    const port = delivery({ focus: vi.fn().mockResolvedValue(false), runPowerShell })

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
      focus: vi.fn().mockResolvedValue(false)
    })
    const result = await port.sendToConsole({
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
      return true
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
    const port = delivery({ focus: vi.fn().mockResolvedValue(false), runPowerShell })

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
      focus: vi.fn().mockResolvedValue(false)
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
      focus: vi.fn().mockResolvedValue(true),
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
