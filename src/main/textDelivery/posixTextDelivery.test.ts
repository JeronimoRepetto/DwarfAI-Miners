import { describe, expect, it, vi } from 'vitest'
import { PosixTextDelivery } from './posixTextDelivery'

function delivery(overrides: Partial<ConstructorParameters<typeof PosixTextDelivery>[0]> = {}) {
  return new PosixTextDelivery({
    platform: 'darwin',
    home: '/Users/j',
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
      port.relayToClaudeSession({ sessionName: 'sample-project-70', text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })

    const invocation = runRelay.mock.calls[0]?.[0]
    expect(invocation.command).toBe('/Users/j/.local/bin/claude')
    expect(invocation.env.PATH).toBe('/Users/j/.local/bin:/usr/bin')
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain('sample-project-70')
  })

  it('keeps working on Linux, where it is the only tier there is', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({ platform: 'linux', home: '/home/j', runRelay })
    await expect(port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })).resolves.toEqual({
      delivered: true
    })
    expect(runRelay.mock.calls[0]?.[0].command).toBe('/home/j/.local/bin/claude')
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

/**
 * The Codex queue tier (#97) is the second platform-neutral one: it spawns a
 * CLI, so macOS and Linux get it on exactly the same terms Windows does. Only
 * the detected binary path differs, and that comes from the detection port.
 */
describe('PosixTextDelivery.queueToCodexThread', () => {
  const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'

  it('spawns the detected codex binary with the thread and the message as argv', async () => {
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({
      platform: 'linux',
      codexBinary: async () => '/home/j/.local/bin/codex',
      runCodexQueue
    })

    await expect(
      port.queueToCodexThread({ threadId: THREAD_ID, text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })
    expect(runCodexQueue.mock.calls[0]?.[0]).toMatchObject({
      command: '/home/j/.local/bin/codex',
      args: ['queue', '--thread', THREAD_ID, '--message', 'run the tests']
    })
  })

  it('refuses with a reason when codex was never detected', async () => {
    const runCodexQueue = vi.fn()
    const port = delivery({ runCodexQueue })
    const outcome = await port.queueToCodexThread({ threadId: THREAD_ID, text: 'hi' })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
    expect(runCodexQueue).not.toHaveBeenCalled()
  })

  it('never echoes the message back in a refusal', async () => {
    const port = delivery({ runCodexQueue: vi.fn() })
    const outcome = await port.queueToCodexThread({
      threadId: THREAD_ID,
      text: 'my-secret-payload'
    })
    expect(outcome.error).not.toContain('my-secret-payload')
  })
})

/**
 * Kick's terminal tier on macOS and Linux (#366).
 *
 * The same contract the Windows tier holds — verify the pid, ask it to exit,
 * poll a bounded grace, escalate, report only what was observed — reached by a
 * strictly simpler act. SIGTERM is CATCHABLE, so the signal itself gives the
 * CLI its own exit path and the terminal comes back restored: no window is
 * focused, no keystroke is synthesized, and #358's mouse-mode problem and
 * #329's shared-tab ambiguity never arise.
 *
 * The pid is signalled DIRECTLY, never as a group: an observed session's pid
 * leads no group of ours (see processEnd.ts), so `endProcessTree` — the
 * launched tier's group signal — must never be reached from here.
 */
describe('PosixTextDelivery.endConsoleSession', () => {
  /** The creation time the provider verified and put on the wire. */
  const EXPECTED_START_MS = 1_788_001_972_136
  const SESSION_PID = 4242

  function ender(
    processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS),
    signals: { terminate?: boolean; kill?: boolean } = {},
    extra: Partial<ConstructorParameters<typeof PosixTextDelivery>[0]> = {}
  ) {
    const terminateProcess = vi.fn().mockResolvedValue(signals.terminate ?? true)
    const killProcess = vi.fn().mockResolvedValue(signals.kill ?? true)
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const port = delivery({
      platform: 'linux',
      home: '/home/j',
      processEnd: { endProcessTree, terminateProcess, killProcess },
      processProbe: { isCodexProcessRunning: vi.fn(), processStartTimeMs },
      // The grace window polls the pid on an injected delay, so a unit test
      // drives it to completion instantly instead of waiting out ~3s.
      sleep: async () => {},
      ...extra
    })
    return { port, terminateProcess, killProcess, endProcessTree, processStartTimeMs }
  }

  function end(port: PosixTextDelivery) {
    return port.endConsoleSession!({ pid: SESSION_PID, expectedStartMs: EXPECTED_START_MS })
  }

  /*
   * The clean path, and the one the CLI is expected to take: TERM is catchable,
   * the TUI tears down and exits, and the pid stops answering. Nothing
   * uncatchable is ever sent.
   */
  it('asks the session to exit and, once it goes, never escalates to KILL', async () => {
    // Verified alive at the signal, still there on the first look, then gone.
    const processStartTimeMs = vi
      .fn()
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValue(null)
    const { port, terminateProcess, killProcess } = ender(processStartTimeMs)

    await expect(end(port)).resolves.toMatchObject({ delivered: true })
    expect(terminateProcess).toHaveBeenCalledWith(SESSION_PID)
    expect(killProcess).not.toHaveBeenCalled()
  })

  /*
   * A process that ignores SIGTERM is exactly the case the escalation exists
   * for. The grace window expires with the pid still this same process, so the
   * uncatchable signal follows — and the outcome is the delivered end the
   * person asked for.
   */
  it('escalates to KILL when the session survives the grace window', async () => {
    // Never goes: verified at the signal and on every look after it.
    const { port, terminateProcess, killProcess } = ender()

    await expect(end(port)).resolves.toMatchObject({ delivered: true })
    expect(terminateProcess).toHaveBeenCalledWith(SESSION_PID)
    expect(killProcess).toHaveBeenCalledWith(SESSION_PID)
  })

  /*
   * #231's rule, on the tier that needs it most: a pid is a number the OS
   * recycles, and the provider's verification happened at the last poll. A
   * reading that no longer agrees means this pid is somebody else's program now,
   * so nothing is signalled at all.
   */
  it('signals nothing when the pid now belongs to another process', async () => {
    const { port, terminateProcess, killProcess } = ender(
      vi.fn().mockResolvedValue(EXPECTED_START_MS + 60_000)
    )
    const outcome = await end(port)
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/could not be verified/i)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })

  /*
   * The one guard in this app that fails CLOSED, and this is the half that
   * makes it one: an unreadable process list is a refusal here, where the
   * liveness guard reads the same null as "alive". Before the signal null means
   * "cannot verify, do not act"; during the poll it means "gone". Same reading,
   * opposite consequence, and both are stated at their site in the port.
   */
  it('signals nothing when the probe cannot answer before the signal', async () => {
    const { port, terminateProcess, killProcess } = ender(vi.fn().mockResolvedValue(null))
    const outcome = await end(port)
    expect(outcome.delivered).toBe(false)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('signals nothing when the probe itself throws', async () => {
    const { port, terminateProcess } = ender(vi.fn().mockRejectedValue(new Error('no /proc')))
    await expect(end(port)).resolves.toMatchObject({ delivered: false })
    expect(terminateProcess).not.toHaveBeenCalled()
  })

  /*
   * A signal the platform would not deliver is not an ended session — the
   * exit-0-shaped lie this repo keeps refusing to tell. Both signals travel the
   * same `kill`, so a TERM that could not be delivered is not escalated: the
   * escalation exists for a process that DECLINED the signal, not for one that
   * never received it.
   */
  it('reports a refusal when the platform would not deliver the signal', async () => {
    const { port, killProcess } = ender(undefined, { terminate: false })
    const outcome = await end(port)
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('reports a refusal when the escalation itself would not be delivered', async () => {
    const { port } = ender(undefined, { kill: false })
    const outcome = await end(port)
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  /*
   * A pid that stopped being this process between the last look and the
   * escalation went of its own accord — the TERM took, just later than the
   * window allowed. It is an ended session, and nothing uncatchable is sent to
   * a pid nothing can vouch for any more.
   */
  it('never escalates onto a pid that stopped matching after the grace window', async () => {
    // Eleven readings verify it — the one before the signal plus ten looks —
    // and the twelfth, taken immediately before the escalation, says the pid is
    // no longer this process.
    const probe = vi.fn().mockResolvedValue(null)
    for (let reading = 0; reading < 11; reading++) {
      probe.mockResolvedValueOnce(EXPECTED_START_MS)
    }
    const { port, killProcess } = ender(probe)

    await expect(end(port)).resolves.toMatchObject({ delivered: true })
    expect(killProcess).not.toHaveBeenCalled()
  })

  /*
   * The launched tier's group signal must never be reached from here: `kill
   * -TERM -<pid>` addresses a process group this panel never created for a
   * session somebody else started in their own terminal (#217, #366).
   */
  it('never signals the process group the launched tier ends', async () => {
    const { port, endProcessTree } = ender()
    await end(port)
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('times the whole act as one stage, the way every other tier does', async () => {
    const readings = [0, 40]
    const { port } = ender(undefined, {}, { now: () => readings.shift() ?? 40 })
    const outcome = await end(port)
    expect(outcome.stages).toEqual({ spawnMs: 40 })
  })

  /*
   * The tier exists on this port now, and that is the whole of #366: the same
   * button meant two different things on two platforms because this method was
   * absent here. A port that reports it can end a session must have one.
   */
  it('offers the end tier on macOS and Linux alike', () => {
    expect(typeof delivery({ platform: 'darwin' }).endConsoleSession).toBe('function')
    expect(typeof delivery({ platform: 'linux' }).endConsoleSession).toBe('function')
  })
})
