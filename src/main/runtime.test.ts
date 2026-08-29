import { describe, expect, it, vi } from 'vitest'
import type { FeedMessage } from '../shared/contracts'
import { FakeFs } from './adapters/fakeFs'
import { defaultConfig } from './config'
import type { Provider } from './providers/provider'
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

describe('AgentRuntime provider wiring', () => {
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
