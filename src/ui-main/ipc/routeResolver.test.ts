// layer: L1
import { describe, expect, it } from 'vitest'
import type { ChannelRoute } from './channelRoute'
import { resolveRoute } from './routeResolver'

/** One route per (channel, qualifier) (21 §1 item 2): the resolver picks it, never guesses. */
describe('resolveRoute (21 §1 item 2)', () => {
  const route = (partial: Partial<ChannelRoute>): ChannelRoute => ({
    channel: 'agent:launch',
    owner: 'legacy',
    since: 'pre-cut-0',
    parity: 'n/a',
    shape: 'today',
    ...partial
  })
  const unqualified = route({})
  const claude = route({ owner: 'host', shape: 'target', qualifier: { provider: 'claude' } })
  const legacyAsk = route({
    channel: 'agent:answerQuestion',
    qualifier: { origin: 'legacy-ask-channel' }
  })
  const table = [unqualified, claude, legacyAsk, route({ channel: 'mines:get' })]

  it('[ADR-001] a qualified route wins over the unqualified route of the same channel and an unknown qualifier falls back to the unqualified one', () => {
    expect(resolveRoute(table, 'agent:launch', { provider: 'claude' })).toBe(claude)
    expect(resolveRoute(table, 'agent:launch', { provider: 'kimi' })).toBe(unqualified)
    expect(resolveRoute(table, 'agent:launch', {})).toBe(unqualified)
    expect(resolveRoute(table, 'agent:launch')).toBe(unqualified)
    expect(resolveRoute(table, 'agent:answerQuestion', { origin: 'legacy-ask-channel' })).toBe(
      legacyAsk
    )
    // No unqualified route and no matching qualifier: no route, never another channel's.
    expect(resolveRoute(table, 'agent:answerQuestion', { origin: 'legacy-launch' })).toBeUndefined()
    expect(resolveRoute(table, 'dwarf:kick')).toBeUndefined()
  })

  it('[ADR-001] a call matching two qualified routes equally is not guessed', () => {
    const both = [
      route({ qualifier: { provider: 'claude' } }),
      route({ qualifier: { origin: 'legacy-launch' } })
    ]
    expect(
      resolveRoute(both, 'agent:launch', { provider: 'claude', origin: 'legacy-launch' })
    ).toBeUndefined()
  })
})
