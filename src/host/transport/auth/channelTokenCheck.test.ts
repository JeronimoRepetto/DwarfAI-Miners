// layer: L2
// The hook ingress credential check (ADR-016 items 1–2; 16 §4.12 contract "a revoked token never
// authenticates an ingress request"; 13 FM-038; 19 §9.2 `ingress.rejected`): a presented token is
// hex-checked, hashed with SHA-256 and compared in constant time against the active hash of its own
// channel only. The tokens are drawn at run time, so no token value is written into the repository.
import { createHash, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { TokenChannel } from '../../modules/preferences'
import {
  drawToken,
  hashOf,
  inMemoryChannelTokens
} from '../../modules/preferences/testing/inMemoryChannelTokens'
import { ChannelTokenCheck, type ChannelTokenCheckDeps } from './channelTokenCheck'

const T0 = 1_750_000_000_000

function setUp(deps: Partial<ChannelTokenCheckDeps> = {}) {
  const channelTokens = inMemoryChannelTokens()
  const tokens = channelTokens.store
  const log = new RecordingDiagnosticsLog()
  const check = new ChannelTokenCheck({ tokens, log, ...deps })
  const issue = (channel: TokenChannel, at = T0): string => channelTokens.issue(channel, at)
  return { tokens, log, check, issue }
}

describe('ChannelTokenCheck (ADR-016 items 1–2)', () => {
  it('[ADR-016, FM-038] a revoked token never authenticates an ingress request', () => {
    const { tokens, log, check, issue } = setUp()
    const first = issue('claude-hooks')
    expect(check.authenticate('claude-hooks', first)).toBe(true)

    const second = issue('claude-hooks', T0 + 1)
    expect(check.authenticate('claude-hooks', first)).toBe(false)
    expect(check.authenticate('claude-hooks', second)).toBe(true)

    tokens.revoke('claude-hooks', T0 + 2)
    expect(check.authenticate('claude-hooks', second)).toBe(false)
    expect(check.authenticate('claude-hooks', first)).toBe(false)

    expect(log.byEvent('ingress.rejected')).toStrictEqual([
      { level: 'warn', event: 'ingress.rejected', subsystem: 'claude-hooks', causeClass: '401' },
      { level: 'warn', event: 'ingress.rejected', subsystem: 'claude-hooks', causeClass: '401' },
      { level: 'warn', event: 'ingress.rejected', subsystem: 'claude-hooks', causeClass: '401' }
    ])
  })

  it('[ADR-016] a claude-hooks token presented on the opencode-plugin channel fails, and the reverse', () => {
    const { check, issue } = setUp()
    const hooks = issue('claude-hooks')
    const plugin = issue('opencode-plugin')

    expect(check.authenticate('claude-hooks', hooks)).toBe(true)
    expect(check.authenticate('opencode-plugin', plugin)).toBe(true)
    expect(check.authenticate('opencode-plugin', hooks)).toBe(false)
    expect(check.authenticate('claude-hooks', plugin)).toBe(false)
  })

  it('[ADR-016] a non-hex or short token is refused without throwing', () => {
    const hashed: string[] = []
    const { check, log, issue } = setUp({
      sha256: (text) => {
        hashed.push(text)
        return createHash('sha256').update(text, 'utf8').digest()
      }
    })
    const token = issue('opencode-plugin')
    const malformed: unknown[] = [
      '',
      token.slice(0, 2),
      token.slice(0, 63),
      `${token}0`,
      token.toUpperCase(),
      `${token.slice(0, 62)}zz`,
      ` ${token.slice(1)}`,
      '⛏'.repeat(64),
      undefined,
      null,
      42,
      [token]
    ]

    for (const presented of malformed) {
      expect(check.authenticate('opencode-plugin', presented), String(presented)).toBe(false)
    }
    // Refused before hashing: the hash function never saw a malformed value.
    expect(hashed).toStrictEqual([])
    expect(log.byEvent('ingress.rejected')).toHaveLength(malformed.length)
    // The well-formed token still authenticates, through the hash.
    expect(check.authenticate('opencode-plugin', token)).toBe(true)
    expect(hashed).toHaveLength(1)
  })

  it('[ADR-016] the compare runs in constant time on two SHA-256 digests, also when the channel has no active token', () => {
    const compared: Array<[number, number]> = []
    const { check, issue } = setUp({
      timingSafeEqual: (a, b) => {
        compared.push([a.length, b.length])
        return timingSafeEqual(a, b)
      }
    })

    expect(check.authenticate('claude-hooks', drawToken())).toBe(false)
    expect(compared).toHaveLength(1)

    const token = issue('claude-hooks')
    expect(check.authenticate('claude-hooks', token)).toBe(true)
    expect(check.authenticate('claude-hooks', drawToken())).toBe(false)

    expect(compared).toHaveLength(3)
    expect(compared.every(([a, b]) => a === 32 && b === 32)).toBe(true)
  })

  it('[NFR-SEC-12] a presented or issued token never reaches a log record', () => {
    const { tokens, log, check, issue } = setUp()
    const hooks = issue('claude-hooks')
    const plugin = issue('opencode-plugin')
    const stranger = drawToken()

    check.authenticate('claude-hooks', hooks)
    check.authenticate('claude-hooks', plugin)
    check.authenticate('opencode-plugin', hooks)
    check.authenticate('opencode-plugin', stranger)
    check.authenticate('claude-hooks', hooks.toUpperCase())
    check.authenticate('claude-hooks', hooks.slice(0, 40))
    tokens.revoke('opencode-plugin', T0 + 1)
    check.authenticate('opencode-plugin', plugin)

    expect(log.byEvent('ingress.rejected').length).toBeGreaterThan(0)
    // The exact shape of every record: no field, and so no fragment of a token, beyond these four.
    const rejected = (subsystem: TokenChannel) => ({
      level: 'warn',
      event: 'ingress.rejected',
      subsystem,
      causeClass: '401'
    })
    expect(log.entries).toStrictEqual([
      rejected('claude-hooks'),
      rejected('opencode-plugin'),
      rejected('opencode-plugin'),
      rejected('claude-hooks'),
      rejected('claude-hooks'),
      rejected('opencode-plugin')
    ])
    expect(log.refused).toStrictEqual([])
    const logged = JSON.stringify([log.entries, log.refused]).toLowerCase()
    for (const secret of [hooks, plugin, stranger]) {
      expect(logged).not.toContain(secret)
      expect(logged).not.toContain(secret.slice(0, 40))
      expect(logged).not.toContain(hashOf(secret))
    }
  })
})
