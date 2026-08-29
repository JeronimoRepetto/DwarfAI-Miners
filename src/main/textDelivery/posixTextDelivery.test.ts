import { describe, expect, it, vi } from 'vitest'
import { PosixTextDelivery } from './posixTextDelivery'

function delivery(overrides: Partial<ConstructorParameters<typeof PosixTextDelivery>[0]> = {}) {
  return new PosixTextDelivery({
    platform: 'darwin',
    home: '/Users/jeron',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: '/usr/bin' },
    focus: vi.fn().mockResolvedValue(true),
    consoleInput: null,
    runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    ...overrides
  })
}

function consoleInput() {
  return {
    sendText: vi.fn().mockResolvedValue(true),
    sendInterrupt: vi.fn().mockResolvedValue(true)
  }
}

describe('PosixTextDelivery without console input', () => {
  it('declares console input unsupported', () => {
    expect(delivery().supportsConsoleInput).toBe(false)
  })

  it('refuses to type into a console, with a reason the panel can show', async () => {
    const focus = vi.fn().mockResolvedValue(true)
    const port = delivery({ focus })
    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: true })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
    // Nothing is focused either: refusing early keeps a click from stealing
    // the foreground for a delivery that was never going to land.
    expect(focus).not.toHaveBeenCalled()
  })

  it('refuses to interrupt a console the same way', async () => {
    const result = await delivery().sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('never echoes the message back in the refusal', async () => {
    const result = await delivery().sendToConsole({
      pid: 42,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

describe('PosixTextDelivery with console input', () => {
  it('declares console input supported', () => {
    expect(delivery({ consoleInput: consoleInput() }).supportsConsoleInput).toBe(true)
  })

  it('brings the hosting terminal forward before typing into it', async () => {
    const order: string[] = []
    const input = consoleInput()
    input.sendText.mockImplementation(async () => {
      order.push('type')
      return true
    })
    const port = delivery({
      consoleInput: input,
      focus: vi.fn().mockImplementation(async () => {
        order.push('focus')
        return true
      })
    })
    await expect(port.sendToConsole({ pid: 42, text: 'hi', pressEnter: true })).resolves.toEqual({
      delivered: true
    })
    expect(order).toEqual(['focus', 'type'])
    expect(input.sendText).toHaveBeenCalledWith('hi', true)
  })

  it('types nothing when the terminal will not come forward', async () => {
    // Keystrokes land in whatever window holds the foreground, so a failed
    // focus must abort rather than type into the wrong window.
    const input = consoleInput()
    const port = delivery({ consoleInput: input, focus: vi.fn().mockResolvedValue(false) })
    const result = await port.sendToConsole({ pid: 42, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    expect(input.sendText).not.toHaveBeenCalled()
  })

  it('reports a failed keystroke as undelivered', async () => {
    const input = consoleInput()
    input.sendText.mockResolvedValue(false)
    const result = await delivery({ consoleInput: input }).sendToConsole({
      pid: 42,
      text: 'hi',
      pressEnter: false
    })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('focuses before sending an interrupt, and skips it when focus fails', async () => {
    const input = consoleInput()
    const focused = delivery({ consoleInput: input })
    await expect(focused.sendInterrupt({ pid: 42 })).resolves.toEqual({ delivered: true })
    expect(input.sendInterrupt).toHaveBeenCalledOnce()

    const unfocused = delivery({
      consoleInput: consoleInput(),
      focus: vi.fn().mockResolvedValue(false)
    })
    await expect(unfocused.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: false })
  })

  it('turns a throwing focus into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      consoleInput: consoleInput(),
      focus: vi.fn().mockRejectedValue(new Error('osascript blew up'))
    })
    await expect(
      port.sendToConsole({ pid: 1, text: 'x', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })
})

describe('PosixTextDelivery.relayToClaudeSession', () => {
  it('spawns the POSIX claude binary with a POSIX PATH', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({ runRelay })

    await expect(
      port.relayToClaudeSession({ sessionName: 'ai-tools-70', text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })

    const invocation = runRelay.mock.calls[0]?.[0]
    expect(invocation.command).toBe('/Users/jeron/.local/bin/claude')
    expect(invocation.env.PATH).toBe('/Users/jeron/.local/bin:/usr/bin')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('ai-tools-70')
  })

  it('keeps working on Linux, where it is the only tier there is', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({ platform: 'linux', home: '/home/jeron', runRelay })
    await expect(port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })).resolves.toEqual({
      delivered: true
    })
    expect(runRelay.mock.calls[0]?.[0].command).toBe('/home/jeron/.local/bin/claude')
  })

  it('names the timeout when the relay ran out of time', async () => {
    const port = delivery({ runRelay: vi.fn().mockResolvedValue({ exitCode: 1, timedOut: true }) })
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
})
