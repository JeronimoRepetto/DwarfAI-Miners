import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELEGATION_WAIT_MS,
  DELEGATE_ROUTE,
  DELEGATION_ENDPOINT_ENV,
  DELEGATION_TOKEN_ENV,
  DELEGATION_TOKEN_HEADER,
  DELEGATION_WAIT_MS_ENV,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  delegationFailure,
  parseDelegateAcceptedBody,
  parseDelegateRefusedBody,
  parseResultBody,
  parseTurnOutcome,
  readLinkEnv,
  resultRoute
} from './delegationProtocol'

describe('delegationFailure', () => {
  it('always appends the native-subagent fallback sentence to detail', () => {
    const failure = delegationFailure('jev-unreachable', 'TypeSafe did not answer in time.')
    expect(failure.kind).toBe('jev-unreachable')
    expect(failure.detail).toBe(
      `TypeSafe did not answer in time. ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
    )
    expect(failure.detail).toContain(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
  })

  it.each([
    'disabled',
    'jev-unreachable',
    'jev-unsure',
    'provider-not-launchable',
    'concurrency-limit',
    'depth-exceeded',
    'unknown-ticket',
    'link-unconfigured',
    'link-unreachable',
    'invalid-response',
    'launch-failed'
  ] as const)('carries the fallback sentence for kind %s', (kind) => {
    expect(delegationFailure(kind, 'reason').detail).toContain(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
  })
})

describe('resultRoute', () => {
  it('builds /result/<ticket>', () => {
    expect(resultRoute('abc123')).toBe('/result/abc123')
  })

  it('URL-encodes a ticket carrying reserved characters', () => {
    expect(resultRoute('a/b c')).toBe('/result/a%2Fb%20c')
  })
})

describe('readLinkEnv', () => {
  it('reads a fully configured env', () => {
    expect(
      readLinkEnv({
        [DELEGATION_ENDPOINT_ENV]: 'http://127.0.0.1:4123',
        [DELEGATION_TOKEN_ENV]: 'tok-1',
        [DELEGATION_WAIT_MS_ENV]: '10000'
      })
    ).toEqual({ endpoint: 'http://127.0.0.1:4123', token: 'tok-1', waitMs: 10_000 })
  })

  it('defaults waitMs when the variable is absent', () => {
    expect(
      readLinkEnv({
        [DELEGATION_ENDPOINT_ENV]: 'http://127.0.0.1:4123',
        [DELEGATION_TOKEN_ENV]: 'tok-1'
      })
    ).toEqual({
      endpoint: 'http://127.0.0.1:4123',
      token: 'tok-1',
      waitMs: DEFAULT_DELEGATION_WAIT_MS
    })
  })

  it.each([
    ['not a number', 'soon'],
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '12.5']
  ])('falls back to the default waitMs on junk (%s)', (_label, raw) => {
    expect(
      readLinkEnv({
        [DELEGATION_ENDPOINT_ENV]: 'http://127.0.0.1:4123',
        [DELEGATION_TOKEN_ENV]: 'tok-1',
        [DELEGATION_WAIT_MS_ENV]: raw
      })?.waitMs
    ).toBe(DEFAULT_DELEGATION_WAIT_MS)
  })

  it('is unconfigured when the endpoint is missing', () => {
    expect(readLinkEnv({ [DELEGATION_TOKEN_ENV]: 'tok-1' })).toBeUndefined()
  })

  it('is unconfigured when the token is missing', () => {
    expect(readLinkEnv({ [DELEGATION_ENDPOINT_ENV]: 'http://127.0.0.1:4123' })).toBeUndefined()
  })

  it('is unconfigured when the token is empty', () => {
    expect(
      readLinkEnv({
        [DELEGATION_ENDPOINT_ENV]: 'http://127.0.0.1:4123',
        [DELEGATION_TOKEN_ENV]: ''
      })
    ).toBeUndefined()
  })

  it.each([
    ['not a URL at all', 'not-a-url'],
    ['https instead of http', 'https://127.0.0.1:4123'],
    ['a non-loopback host', 'http://example.com:4123'],
    ['a path beyond the origin', 'http://127.0.0.1:4123/delegate'],
    ['a query string', 'http://127.0.0.1:4123?x=1']
  ])('is unconfigured when the endpoint is %s', (_label, endpoint) => {
    expect(
      readLinkEnv({ [DELEGATION_ENDPOINT_ENV]: endpoint, [DELEGATION_TOKEN_ENV]: 'tok-1' })
    ).toBeUndefined()
  })
})

describe('parseTurnOutcome', () => {
  it('round-trips a minimal concluded outcome', () => {
    const outcome = { kind: 'concluded', text: 'done', endedAt: 100 }
    expect(parseTurnOutcome(outcome)).toEqual(outcome)
  })

  it('round-trips every optional field', () => {
    const outcome = { kind: 'errored', detail: 'error_max_turns', endedAt: 5, truncated: true }
    expect(parseTurnOutcome(outcome)).toEqual(outcome)
  })

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing kind', { endedAt: 1 }],
    ['unrecognised kind', { kind: 'unknown', endedAt: 1 }],
    ['missing endedAt', { kind: 'concluded' }],
    ['wrong endedAt type', { kind: 'concluded', endedAt: '1' }],
    ['wrong text type', { kind: 'concluded', endedAt: 1, text: 5 }],
    ['wrong truncated type', { kind: 'concluded', endedAt: 1, truncated: 'yes' }]
  ])('returns undefined for %s', (_label, json) => {
    expect(parseTurnOutcome(json)).toBeUndefined()
  })
})

describe('parseDelegateAcceptedBody', () => {
  it('round-trips a valid body', () => {
    const body = { ticket: 't-1', routing: { provider: 'claude', model: 'sonnet' } }
    expect(parseDelegateAcceptedBody(body)).toEqual(body)
  })

  it('round-trips routing with no optional fields', () => {
    const body = { ticket: 't-1', routing: { provider: 'opencode' } }
    expect(parseDelegateAcceptedBody(body)).toEqual(body)
  })

  it.each([
    ['not an object', 'nope'],
    ['missing ticket', { routing: { provider: 'claude' } }],
    ['empty ticket', { ticket: '', routing: { provider: 'claude' } }],
    ['missing routing', { ticket: 't-1' }],
    ['routing missing provider', { ticket: 't-1', routing: {} }],
    ['routing with an unknown provider', { ticket: 't-1', routing: { provider: 'gpt5' } }],
    [
      'routing with a wrong model type',
      { ticket: 't-1', routing: { provider: 'claude', model: 5 } }
    ]
  ])('returns undefined for %s', (_label, json) => {
    expect(parseDelegateAcceptedBody(json)).toBeUndefined()
  })
})

describe('parseDelegateRefusedBody', () => {
  it('round-trips a valid refusal', () => {
    const body = { failure: { kind: 'disabled', detail: 'off' } }
    expect(parseDelegateRefusedBody(body)).toEqual(body)
  })

  it.each([
    ['not an object', 'nope'],
    ['missing failure', {}],
    ['failure with an unknown kind', { failure: { kind: 'nope', detail: 'x' } }],
    ['failure missing detail', { failure: { kind: 'disabled' } }]
  ])('returns undefined for %s', (_label, json) => {
    expect(parseDelegateRefusedBody(json)).toBeUndefined()
  })

  // T3 (#511): the delegation service's own "the child never launched at all"
  // failure — a mine that vanished, a spawn that threw — distinct from
  // 'provider-not-launchable' (decided BEFORE any launch was attempted).
  it('round-trips a refusal for the launch-failed kind', () => {
    const body = { failure: { kind: 'launch-failed', detail: 'the mine no longer exists' } }
    expect(parseDelegateRefusedBody(body)).toEqual(body)
  })
})

/*
 * `parseDelegateRequestBody` and the `RESULT_ROUTE_PREFIX` matching it are
 * SERVER-only (#511 T3) — nothing in the client-side graph
 * (`delegationLink.ts`, `jevMcpServerCore.ts`) ever calls either, so both are
 * declared in `delegationServerProtocol.ts`, never here: this file is a
 * runtime dependency of BOTH `jevMcpServer.js`'s build graph and
 * `index.js`'s, and a server-only runtime value declared here would pull it
 * into both, with Rollup extracting a shared chunk between them — the same
 * failure mode `electron.vite.config.ts`'s own comment and this file's own
 * `KNOWN_PROVIDERS` already document for `DWARF_PROVIDERS`. Their tests live
 * in `delegationServerProtocol.test.ts`, beside the code.
 */

describe('parseResultBody', () => {
  it('parses a pending result, routing included', () => {
    const routing = { provider: 'claude', model: 'sonnet' }
    expect(parseResultBody({ status: 'pending', routing })).toEqual({
      status: 'pending',
      routing
    })
  })

  it('parses a done result', () => {
    const outcome = { kind: 'concluded', text: 'ok', endedAt: 1 }
    expect(parseResultBody({ status: 'done', outcome })).toEqual({ status: 'done', outcome })
  })

  it('parses a failed result', () => {
    const failure = { kind: 'unknown-ticket', detail: 'gone' }
    expect(parseResultBody({ status: 'failed', failure })).toEqual({ status: 'failed', failure })
  })

  it.each([
    ['not an object', 'nope'],
    ['unrecognised status', { status: 'other' }],
    ['pending without routing', { status: 'pending' }],
    ['pending with an unknown provider', { status: 'pending', routing: { provider: 'gpt5' } }],
    ['done without a valid outcome', { status: 'done', outcome: { kind: 'concluded' } }],
    ['failed without a valid failure', { status: 'failed', failure: { kind: 'nope' } }]
  ])('returns undefined for %s', (_label, json) => {
    expect(parseResultBody(json)).toBeUndefined()
  })
})

describe('route constants', () => {
  it('names the delegate route and token header', () => {
    expect(DELEGATE_ROUTE).toBe('/delegate')
    expect(DELEGATION_TOKEN_HEADER).toBe('x-dwarfai-token')
  })
})
