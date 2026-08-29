import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedMessage } from '../shared/contracts'
import { FakeFs } from './adapters/fakeFs'
import { defaultConfig } from './config'
import type { Provider } from './providers/provider'
import type { TextDeliveryPort, TextDeliveryTarget } from './textDelivery/port'
import { AgentRuntime, expandHomePath } from './runtime'

function datePath(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}\\${month}\\${day}`
}

describe('expandHomePath', () => {
  const home = 'C:\\Users\\jeron'

  it.each([
    ['~', home],
    ['~/.claude', 'C:\\Users\\jeron\\.claude'],
    ['~\\.claude-multitec', 'C:\\Users\\jeron\\.claude-multitec'],
    ['C:\\custom\\claude', 'C:\\custom\\claude']
  ])('expands %s', (input, expected) => {
    expect(expandHomePath(input, home)).toBe(expected)
  })
})

describe('AgentRuntime activation', () => {
  const scan = vi.fn<Provider['scan']>().mockResolvedValue([
    {
      provider: 'claude',
      sessionId: 'session-1',
      cwd: 'C:\\work\\project',
      status: 'busy',
      updatedAt: 1,
      dwarfs: [
        {
          id: 'claude:session-1',
          provider: 'claude',
          role: 'worker',
          name: 'worker',
          status: 'working',
          sessionId: 'session-1',
          pid: 42
        }
      ]
    }
  ])

  function provider(feed: FeedMessage[] = []): Provider {
    return { kind: 'claude', scan, feed: vi.fn().mockResolvedValue(feed) }
  }

  it('focuses a known dwarf before consulting its transcript', async () => {
    const source = provider()
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(true),
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: true,
      openedTerminal: false,
      feed: []
    })
    expect(source.feed).not.toHaveBeenCalled()
  })

  it('opens a terminal tailing the transcript when focus fails but a transcript path is known', async () => {
    const source: Provider = {
      kind: 'claude',
      scan,
      feed: vi.fn().mockResolvedValue([]),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: true,
      feed: []
    })
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
    expect(source.feed).not.toHaveBeenCalled()
  })

  it('falls back to the transcript feed when focus fails and no terminal could be opened', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
    const source: Provider = {
      kind: 'claude',
      scan,
      feed: vi.fn().mockResolvedValue(feed),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    const launchTerminal = vi.fn().mockResolvedValue(false)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
    expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
  })

  it('skips straight to the transcript feed when the provider exposes no transcript path', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
    const source = provider(feed)
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      launchTerminal,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(launchTerminal).not.toHaveBeenCalled()
    expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
  })
})

describe('AgentRuntime dwarf lifecycle wiring', () => {
  it('keeps a disappeared dwarf visible as leaving, then drops it after dwarfLeaveGraceS', async () => {
    let now = 0
    const workingDwarf = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1'
    }
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [workingDwarf]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [{ kind: 'claude', scan, feed: vi.fn().mockResolvedValue([]) }],
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([workingDwarf])

    now = 1_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([
      { id: 'claude:session-1', status: 'leaving' }
    ])

    now = 21_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toEqual([])
  })
})

/**
 * R3-leaving-dwarf-activation: a 'leaving' dwarf's agent has already
 * finished/disappeared, so its retained pid is stale (or, worst case, reused
 * by an unrelated process) — attempting to focus it serves no purpose and
 * risks focusing the wrong window. The terminal/feed fallbacks still read
 * from disk, so they should still work for as long as the dwarf stays in its
 * grace period.
 */
describe('AgentRuntime activation for a leaving dwarf', () => {
  function leavingScan() {
    const workingDwarf = {
      id: 'claude:session-1',
      provider: 'claude' as const,
      role: 'worker' as const,
      name: 'worker',
      status: 'working' as const,
      sessionId: 'session-1',
      pid: 42
    }
    return vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [workingDwarf]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
  }

  it('skips focusing a leaving dwarf and opens a terminal tailing its transcript instead', async () => {
    const focus = vi.fn().mockResolvedValue(true)
    const launchTerminal = vi.fn().mockResolvedValue(true)
    const source: Provider = {
      kind: 'claude',
      scan: leavingScan(),
      feed: vi.fn().mockResolvedValue([]),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [source],
      focus,
      launchTerminal,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh() // dwarf is 'working'
    now = 1_000
    await runtime.refresh() // the agent disappeared -> dwarf is now 'leaving'
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([{ status: 'leaving', pid: 42 }])

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: true,
      feed: []
    })
    expect(focus).not.toHaveBeenCalled()
    expect(launchTerminal).toHaveBeenCalledWith('worker', 'C:\\claude\\session-1.jsonl')
  })

  it('falls all the way back to the transcript feed for a leaving dwarf when no terminal can be opened', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Final message', timestamp: 'now' }]
    const focus = vi.fn().mockResolvedValue(true)
    const launchTerminal = vi.fn().mockResolvedValue(false)
    const source: Provider = {
      kind: 'claude',
      scan: leavingScan(),
      feed: vi.fn().mockResolvedValue(feed),
      transcriptPath: vi.fn().mockReturnValue('C:\\claude\\session-1.jsonl')
    }
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [source],
      focus,
      launchTerminal,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()
    expect(runtime.getMines()[0]!.dwarfs).toMatchObject([{ status: 'leaving' }])

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      openedTerminal: false,
      feed
    })
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime.sendDwarfText', () => {
  const FOREMAN_ID = 'claude:session-1'
  const WORKER_ID = 'claude:session-1:agent-9'

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          },
          {
            id: WORKER_ID,
            provider: 'claude',
            role: 'worker',
            name: 'Explorer',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    } satisfies TextDeliveryPort
  }

  async function runtimeWith(
    targets: Record<string, TextDeliveryTarget>,
    port: TextDeliveryPort = fakePort()
  ) {
    const source: Provider = {
      kind: 'claude',
      scan: crewScan(),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) => targets[dwarfId] ?? null
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, port }
  }

  it('types the message into the console of a terminal-hosted dwarf', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'terminal' })
    expect(port.sendToConsole).toHaveBeenCalledWith({
      pid: 42,
      text: 'run the tests',
      pressEnter: true
    })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('relays the message to a headless session by name', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'ai-tools-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'status?', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'ai-tools-70',
      text: 'status?'
    })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it("routes a worker's message to its foreman under an explicit prefix", async () => {
    const { runtime, port } = await runtimeWith({
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' },
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'ai-tools-70' }
    })

    await expect(
      runtime.sendDwarfText({ dwarfId: WORKER_ID, text: 'stop digging', pressEnter: true })
    ).resolves.toEqual({ delivered: true, via: 'foreman-relay' })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'ai-tools-70',
      text: '[for agent Explorer] stop digging'
    })
  })

  it('refuses a dwarf that is no longer on the floor', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.sendDwarfText({
      dwarfId: 'claude:ghost',
      text: 'hello',
      pressEnter: true
    })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('refuses a dwarf whose session type has no input channel', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'hello',
      pressEnter: true
    })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses an empty message instead of waking the agent for nothing', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })
    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: '   \n  ',
      pressEnter: true
    })
    expect(result.delivered).toBe(false)
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('trims the message to the 4000-character limit', async () => {
    const port = fakePort()
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)
    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'x'.repeat(5_000),
      pressEnter: false
    })
    expect(port.sendToConsole.mock.calls[0]?.[0].text).toHaveLength(4_000)
  })

  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
  })

  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn().mockRejectedValue(new Error('boom')),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('refuses a leaving dwarf, whose retained pid and session are already stale', async () => {
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: FOREMAN_ID,
              provider: 'claude',
              role: 'foreman',
              name: 'boss',
              status: 'working',
              sessionId: 'session-1',
              pid: 42
            }
          ]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const port = fakePort()
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [
        {
          kind: 'claude',
          scan,
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: () => ({ kind: 'terminal', pid: 42 })
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()

    const result = await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'hi',
      pressEnter: false
    })
    expect(result.delivered).toBe(false)
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('never writes the message content to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: false, error: 'nope' }),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn()
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await runtime.sendDwarfText({
      dwarfId: FOREMAN_ID,
      text: 'my-secret-payload',
      pressEnter: false
    })
    const written = [...warn.mock.calls, ...log.mock.calls].flat().join(' ')
    expect(written).not.toContain('my-secret-payload')
    warn.mockRestore()
    log.mockRestore()
  })

  it('publishes the delivery channel on every dwarf so the panel can render it', async () => {
    const { runtime } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 },
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' }
    })
    const dwarfs = runtime.getMines()[0]!.dwarfs
    expect(dwarfs.find((dwarf) => dwarf.id === FOREMAN_ID)?.textDelivery).toBe('terminal')
    expect(dwarfs.find((dwarf) => dwarf.id === WORKER_ID)?.textDelivery).toBe('foreman-relay')
  })

  it('leaves a dwarf with no channel unmarked', async () => {
    const { runtime } = await runtimeWith({})
    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBeUndefined()
  })

  it('withholds the terminal channel where the platform cannot type into a console', async () => {
    // The session offers a console; this operating system cannot reach it
    // (Linux always, macOS until its osascript path is verified). The panel
    // must show the honest disabled button rather than a Send that types
    // nowhere, so the channel is never published at all.
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBeUndefined()
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false, via: 'none' })
    expect(port.sendToConsole).not.toHaveBeenCalled()
  })

  it('keeps the relay channel where console input is unavailable', async () => {
    // The relay spawns a CLI rather than talking to a window server, so it is
    // the tier that survives on every platform.
    const port = { ...fakePort(), supportsConsoleInput: false }
    const { runtime } = await runtimeWith(
      { [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'ai-tools-70' } },
      port
    )

    expect(runtime.getMines()[0]!.dwarfs[0]?.textDelivery).toBe('claude-relay')
    await expect(
      runtime.sendDwarfText({ dwarfId: FOREMAN_ID, text: 'hi', pressEnter: false })
    ).resolves.toEqual({ delivered: true, via: 'claude-relay' })
  })
})

describe('AgentRuntime.kickDwarf', () => {
  const FOREMAN_ID = 'claude:session-1'
  const WORKER_ID = 'claude:session-1:agent-9'

  function crewScan() {
    return vi.fn<Provider['scan']>().mockResolvedValue([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: 'C:\\work\\project',
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: FOREMAN_ID,
            provider: 'claude',
            role: 'foreman',
            name: 'boss',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          },
          {
            id: WORKER_ID,
            provider: 'claude',
            role: 'worker',
            name: 'Explorer',
            status: 'working',
            sessionId: 'session-1',
            pid: 42
          }
        ]
      }
    ])
  }

  function fakePort() {
    return {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    } satisfies TextDeliveryPort
  }

  async function runtimeWith(
    targets: Record<string, TextDeliveryTarget>,
    port: TextDeliveryPort = fakePort()
  ) {
    const source: Provider = {
      kind: 'claude',
      scan: crewScan(),
      feed: vi.fn().mockResolvedValue([]),
      textDelivery: (dwarfId: string) => targets[dwarfId] ?? null
    }
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      textDelivery: port,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()
    return { runtime, port }
  }

  it('sends a raw interrupt keystroke to a terminal-hosted dwarf, never typed text', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'terminal', pid: 42 }
    })

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'terminal'
    })
    expect(port.sendInterrupt).toHaveBeenCalledWith({ pid: 42 })
    expect(port.sendToConsole).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('relays the exact fixed cancel instruction to a headless session by name', async () => {
    const { runtime, port } = await runtimeWith({
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'ai-tools-70' }
    })

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: true,
      via: 'claude-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'ai-tools-70',
      text: 'The user asks you to STOP your current work now. Interrupt what you are doing, leave things in a safe state, and wait for further instructions.'
    })
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it("routes a worker's kick to its foreman under the exact '[cancel agent X]' prefix", async () => {
    const { runtime, port } = await runtimeWith({
      [WORKER_ID]: { kind: 'foreman-relay', foremanDwarfId: FOREMAN_ID, workerName: 'Explorer' },
      [FOREMAN_ID]: { kind: 'claude-relay', sessionName: 'ai-tools-70' }
    })

    await expect(runtime.kickDwarf({ dwarfId: WORKER_ID })).resolves.toEqual({
      delivered: true,
      via: 'foreman-relay'
    })
    expect(port.relayToClaudeSession).toHaveBeenCalledWith({
      sessionName: 'ai-tools-70',
      text: '[cancel agent Explorer] Stop that agent now. Interrupt its work, leave things in a safe state, and wait for further instructions.'
    })
  })

  it('refuses a dwarf that is no longer on the floor', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.kickDwarf({ dwarfId: 'claude:ghost' })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
  })

  it('refuses a dwarf whose session type has no cancel channel (Codex, all shapes)', async () => {
    const { runtime, port } = await runtimeWith({})
    const result = await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    expect(result).toMatchObject({ delivered: false, via: 'none' })
    expect(result.error).toBeTruthy()
    expect(port.relayToClaudeSession).not.toHaveBeenCalled()
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('refuses a leaving dwarf, whose retained pid and session are already stale', async () => {
    const scan = vi
      .fn<Provider['scan']>()
      .mockResolvedValueOnce([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'busy',
          updatedAt: 1,
          dwarfs: [
            {
              id: FOREMAN_ID,
              provider: 'claude',
              role: 'foreman',
              name: 'boss',
              status: 'working',
              sessionId: 'session-1',
              pid: 42
            }
          ]
        }
      ])
      .mockResolvedValue([
        {
          provider: 'claude',
          sessionId: 'session-1',
          cwd: 'C:\\work\\project',
          status: 'idle',
          updatedAt: 2,
          dwarfs: []
        }
      ])
    const port = fakePort()
    let now = 0
    const runtime = new AgentRuntime({
      config: { ...defaultConfig(), dwarfLeaveGraceS: 20 },
      providers: [
        {
          kind: 'claude',
          scan,
          feed: vi.fn().mockResolvedValue([]),
          textDelivery: () => ({ kind: 'terminal', pid: 42 })
        }
      ],
      textDelivery: port,
      onMinesUpdated: vi.fn(),
      now: () => now
    })

    await runtime.refresh()
    now = 1_000
    await runtime.refresh()

    const result = await runtime.kickDwarf({ dwarfId: FOREMAN_ID })
    expect(result.delivered).toBe(false)
    expect(port.sendInterrupt).not.toHaveBeenCalled()
  })

  it('reports the failure reason the delivery port gave', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi
        .fn()
        .mockResolvedValue({ delivered: false, error: 'The terminal would not come forward.' })
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toEqual({
      delivered: false,
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
  })

  it('turns a throwing delivery port into a failed verdict', async () => {
    const port = {
      sendToConsole: vi.fn(),
      relayToClaudeSession: vi.fn(),
      sendInterrupt: vi.fn().mockRejectedValue(new Error('boom'))
    } satisfies TextDeliveryPort
    const { runtime } = await runtimeWith({ [FOREMAN_ID]: { kind: 'terminal', pid: 42 } }, port)

    await expect(runtime.kickDwarf({ dwarfId: FOREMAN_ID })).resolves.toMatchObject({
      delivered: false
    })
  })
})

describe('AgentRuntime provider wiring', () => {
  /**
   * R3-wiring-test-real-clock: this test builds a real (non-injected)
   * CodexProvider, which resolves "today" from Date.now() internally — using
   * the real clock here too was a flaky risk (a day-boundary tick between
   * computing fiveDaysAgo and the provider's own scan could shift which day
   * directory each side means). A fake clock keeps both sides reading the
   * exact same "now".
   */
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 7, 29, 12, 0, 0) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds the real CodexProvider from config.codexSessionsRoot (expanded) and config.codexScanDays', async () => {
    const home = 'C:\\Users\\jeron'
    const fake = new FakeFs()
    // 5 days back: only visible if codexScanDays (default 7) actually reaches
    // that day directory, proving both codexSessionsRoot and codexScanDays
    // are wired from config into the real CodexProvider (not just a fixed
    // path or a hardcoded today/yesterday scan).
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000)
    fake.addFile(
      `${home}\\.codex\\sessions\\${datePath(fiveDaysAgo)}\\rollout-wiring-check.jsonl`,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'wiring-session', cwd: 'C:\\Users\\jeron\\Desktop\\Wiring-Project' }
      }) + '\n',
      Date.now() - 5_000
    )

    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home,
      fs: fake,
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    expect(runtime.getMines().map((mine) => mine.path)).toContain(
      'C:\\Users\\jeron\\Desktop\\Wiring-Project'
    )
  })
})
