import { describe, expect, it } from 'vitest'
import { REDACTED, redactSecrets } from './redactSecrets'

/**
 * Every "secret" below is a fixture-shaped fake assembled for this suite —
 * none has ever been a real credential. Shapes mirror what each issuer
 * documents, at the minimum lengths the patterns require.
 */
const FAKE_GITHUB_PAT = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'
const FAKE_SK_KEY = 'sk-proj-FAKE1234FAKE1234FAKE1234FAKE1234FAKE1234'
const FAKE_GOOGLE_KEY = 'AIzaSyFAKE-FAKE_FAKE1234FAKE1234FAKE123'
const FAKE_SLACK_TOKEN = 'xoxb-1234567890-1234567890123-FAKEFAKEFAKEFAKEFAKEFAKE'
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZha2UifQ.' +
  'FAKEsignatureFAKEsignatureFAKEsignature1234'
const FAKE_HEX_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const FAKE_BASE64_KEY = 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnM='

describe('redactSecrets', () => {
  it('redacts GitHub tokens of every prefix flavor', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr'] as const) {
      const token = `${prefix}_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234`
      expect(redactSecrets(`auth with ${token} please`)).toBe(`auth with ${REDACTED} please`)
    }
  })

  it('redacts sk- style API keys', () => {
    expect(redactSecrets(`key: ${FAKE_SK_KEY}`)).toBe(`key: ${REDACTED}`)
  })

  it('redacts Google AIza keys', () => {
    expect(redactSecrets(`maps key ${FAKE_GOOGLE_KEY} here`)).toBe(`maps key ${REDACTED} here`)
  })

  it('redacts Slack xox tokens', () => {
    expect(redactSecrets(`bot: ${FAKE_SLACK_TOKEN}`)).toBe(`bot: ${REDACTED}`)
  })

  it('redacts a JWT as one token, not three fragments', () => {
    expect(redactSecrets(`bearer ${FAKE_JWT}`)).toBe(`bearer ${REDACTED}`)
  })

  it('redacts long hex runs, accepting that git SHAs are casualties', () => {
    // A 40-hex run is indistinguishable from a SHA-1 secret digest. Redacting
    // a commit SHA costs a copy-paste; leaking a key costs the key.
    expect(redactSecrets(`token ${FAKE_HEX_KEY}`)).toBe(`token ${REDACTED}`)
    expect(redactSecrets(`commit ${FAKE_HEX_KEY} pushed`)).toBe(`commit ${REDACTED} pushed`)
    expect(redactSecrets('HEX DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF!')).toBe(`HEX ${REDACTED}!`)
  })

  it('redacts long mixed-alphabet base64-ish runs', () => {
    expect(redactSecrets(`secret=${FAKE_BASE64_KEY}`)).toBe(`secret=${REDACTED}`)
  })

  it('redacts every secret when a message contains several', () => {
    const text = `first ${FAKE_GITHUB_PAT} then ${FAKE_SLACK_TOKEN} done`
    expect(redactSecrets(text)).toBe(`first ${REDACTED} then ${REDACTED} done`)
  })

  describe('normal code-y prose passes through untouched', () => {
    const untouched = [
      'Fixed the bug in src/main/providers/claude/claudeProvider.ts at line 32.',
      'See commit abc123def456 for details.',
      'https://github.com/JeronimoRepetto/DwarfAI-Miners/issues/23',
      'C:\\Users\\j\\Desktop\\Sample-Project\\agent-name\\src\\main\\runtime.ts',
      // Long but digit-free identifiers are prose, not entropy.
      'renamed thisIsAVeryLongCamelCaseIdentifierUsedForNamingThings everywhere',
      // Short sk-/gh mentions below the length floor are ordinary words.
      'sk-test is not a key and ghp_short is not either',
      'The 2s poll ran 40 times; pid 32896 stayed alive.',
      ''
    ]
    for (const text of untouched) {
      it(`keeps ${JSON.stringify(text.slice(0, 40))}...`, () => {
        expect(redactSecrets(text)).toBe(text)
      })
    }
  })

  it('keeps surrounding prose intact around a redaction', () => {
    const text = `Deploy failed. Set GITHUB_TOKEN=${FAKE_GITHUB_PAT} and retry the workflow.`
    expect(redactSecrets(text)).toBe(
      `Deploy failed. Set GITHUB_TOKEN=${REDACTED} and retry the workflow.`
    )
  })
})
