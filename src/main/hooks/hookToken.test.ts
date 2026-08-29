import { describe, expect, it } from 'vitest'
import { FakeHookFs } from './fakeHookFs'
import { loadOrCreateHookToken, tokensMatch } from './hookToken'

const PATH = 'C:/Users/j/AppData/Roaming/DwarfAI-Miners/hook-token'
const VALID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('loadOrCreateHookToken', () => {
  it('generates and stores a token on the first ever call', async () => {
    const fs = new FakeHookFs()
    const token = await loadOrCreateHookToken({ fs, path: PATH, generate: () => VALID })
    expect(token).toBe(VALID)
    expect(fs.read(PATH)).toBe(VALID)
  })

  it('reuses the stored token so installed hook commands stay valid', async () => {
    const fs = new FakeHookFs()
    fs.addFile(PATH, VALID)
    const token = await loadOrCreateHookToken({
      fs,
      path: PATH,
      generate: () => {
        throw new Error('should not regenerate')
      }
    })
    expect(token).toBe(VALID)
  })

  it('tolerates surrounding whitespace in the stored file', async () => {
    const fs = new FakeHookFs()
    fs.addFile(PATH, `  ${VALID}\n`)
    expect(await loadOrCreateHookToken({ fs, path: PATH, generate: () => 'x' })).toBe(VALID)
  })

  it.each([
    ['an empty file', ''],
    ['a truncated token', 'abcd'],
    ['a non-hex token', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ['stray content', 'token = abc']
  ])('replaces %s with a fresh token', async (_label, stored) => {
    const fs = new FakeHookFs()
    fs.addFile(PATH, stored)
    expect(await loadOrCreateHookToken({ fs, path: PATH, generate: () => VALID })).toBe(VALID)
    expect(fs.read(PATH)).toBe(VALID)
  })

  it('creates the user-data directory before writing', async () => {
    const fs = new FakeHookFs()
    await loadOrCreateHookToken({ fs, path: PATH, generate: () => VALID })
    expect(await fs.exists('C:/Users/j/AppData/Roaming/DwarfAI-Miners')).toBe(true)
  })

  it('produces a distinct 32-hex-character token per install by default', async () => {
    const fs = new FakeHookFs()
    const first = await loadOrCreateHookToken({ fs, path: PATH })
    await fs.remove(PATH)
    const second = await loadOrCreateHookToken({ fs, path: PATH })
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
  })
})

describe('tokensMatch', () => {
  it('accepts the exact token', () => {
    expect(tokensMatch(VALID, VALID)).toBe(true)
  })

  it.each([
    ['a different token of the same length', 'b1b2c3d4e5f60718293a4b5c6d7e8f90'],
    ['a prefix', VALID.slice(0, 8)],
    ['the token plus a suffix', `${VALID}0`],
    ['an empty string', ''],
    ['a different case', VALID.toUpperCase()]
  ])('rejects %s', (_label, presented) => {
    expect(tokensMatch(VALID, presented)).toBe(false)
  })

  it.each([undefined, null, 42, ['a'], {}])('rejects the non-string %s', (presented) => {
    expect(tokensMatch(VALID, presented)).toBe(false)
  })

  it('rejects everything when the expected token is empty', () => {
    expect(tokensMatch('', '')).toBe(false)
  })
})
