// layer: L1
// The credential minter of the transport's token issuance (05 §2.1; ADR-016 item 1; lead decision
// 2026-09-30, ISSUE-198): 32 random bytes as lower-case hex, and the SHA-256 of that hex text as
// lower-case hex, the only form a store ever keeps. The hash must be the one the hook ingress
// verifies (ChannelTokenCheck, ISSUE-219), so the check runs here against a minted pair.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import {
  hashOf,
  inMemoryChannelTokens
} from '../../modules/preferences/testing/inMemoryChannelTokens'
import { ChannelTokenCheck } from './channelTokenCheck'
import { CREDENTIAL_RANDOM_SOURCE, mintCredential } from './mintCredential'

const AT = 1_760_000_000_000

describe('mintCredential (ADR-016 item 1)', () => {
  it('[ADR-016] a minted credential is 32 random bytes as lower-case hex with the SHA-256 of that hex text, never repeated', () => {
    const first = mintCredential()
    const second = mintCredential()

    expect(first.value).toMatch(/^[0-9a-f]{64}$/)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.sha256).toBe(hashOf(first.value))
    expect(first.sha256).not.toBe(first.value)
    expect(second.value).not.toBe(first.value)
    expect(second.sha256).toBe(hashOf(second.value))
  })

  it('[ADR-016, NFR-SEC-12] the hook ingress check accepts a minted value once its hash is issued, and only on its own channel', () => {
    const tokens = inMemoryChannelTokens().store
    const check = new ChannelTokenCheck({ tokens, log: new RecordingDiagnosticsLog() })
    const minted = mintCredential()

    tokens.issue('claude-hooks', minted.sha256, AT)

    expect(check.authenticate('claude-hooks', minted.value)).toBe(true)
    expect(check.authenticate('opencode-plugin', minted.value)).toBe(false)
    expect(check.authenticate('claude-hooks', minted.sha256)).toBe(false)
  })

  // AMENDED for ISSUE-221 (appended, review F3): the credential's bytes come from the injected source, by default the
  // platform's cryptographic one, never a predictable generator such as Math.random.
  it('[ADR-016, NFR-SEC-12] the value is the hex of 32 bytes drawn from the random source, which is node:crypto randomBytes by default', () => {
    const asked: number[] = []
    const bytes = Uint8Array.from({ length: 32 }, (_, at) => (at * 37 + 11) % 256)
    const minted = mintCredential((size) => {
      asked.push(size)
      return bytes
    })

    expect(asked).toStrictEqual([32])
    expect(minted.value).toBe(Buffer.from(bytes).toString('hex'))
    expect(minted.sha256).toBe(hashOf(minted.value))
    expect(CREDENTIAL_RANDOM_SOURCE).toBe(randomBytes)
  })
})
