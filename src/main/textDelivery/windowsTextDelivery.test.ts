import { describe, expect, it, vi } from 'vitest'
import { WindowsTextDelivery } from './windowsTextDelivery'

function delivery(overrides: Partial<ConstructorParameters<typeof WindowsTextDelivery>[0]> = {}) {
  return new WindowsTextDelivery({
    home: 'C:\\Users\\jeron',
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
    ).resolves.toEqual({ delivered: true })
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
      port.relayToClaudeSession({ sessionName: 'ai-tools-70', text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })

    const invocation = runRelay.mock.calls[0]?.[0]
    expect(invocation.command).toBe('C:\\Users\\jeron\\.local\\bin\\claude.exe')
    expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe('haiku')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('ai-tools-70')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('run the tests')
    expect(invocation.timeoutMs).toBe(60_000)
    expect(invocation.env.PATH).toBe('C:\\Users\\jeron\\.local\\bin;C:\\Windows')
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

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toEqual({ delivered: true })
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
