import { describe, expect, it, vi } from 'vitest'
import type { FeedMessage } from '../shared/contracts'
import { defaultConfig } from './config'
import type { Provider } from './providers/provider'
import { AgentRuntime, expandHomePath } from './runtime'

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
      feed: []
    })
    expect(source.feed).not.toHaveBeenCalled()
  })

  it('returns a transcript fallback when terminal focus fails', async () => {
    const feed = [{ role: 'assistant' as const, text: 'Still working', timestamp: 'now' }]
    const source = provider(feed)
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      providers: [source],
      focus: vi.fn().mockResolvedValue(false),
      onMinesUpdated: vi.fn()
    })
    await runtime.refresh()

    await expect(runtime.activateDwarf('claude:session-1')).resolves.toEqual({
      focused: false,
      feed
    })
    expect(source.feed).toHaveBeenCalledWith('claude:session-1', 12)
  })
})
