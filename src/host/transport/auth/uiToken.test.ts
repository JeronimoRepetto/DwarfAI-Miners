// layer: L1
// The per-boot uiToken of ADR-003 item 3 (frozen): 32 random bytes as hex, only its SHA-256 kept in
// memory, written to <hostDataDir>/run/ui.token with an exclusive create.
import { timingSafeEqual } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UI_TOKEN_FILE, UiToken } from './uiToken'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-023-token-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'run')
}

/** Fixed bytes instead of randomness, so the token is known. */
const fixedBytes = (seed: number) => (size: number) => new Uint8Array(size).fill(seed)

describe('UiToken (ADR-003 item 3)', () => {
  it('[ADR-003] verify hashes the candidate first, so a wrong-length or non-hex candidate is refused without throwing, and only the SHA-256 digests are compared (timingSafeEqual on two 32-byte buffers)', async () => {
    const compared: Array<[number, number]> = []
    const token = new UiToken({
      randomBytes: fixedBytes(0xab),
      timingSafeEqual: (a, b) => {
        compared.push([a.length, b.length])
        return timingSafeEqual(a, b)
      }
    })
    const dir = runDir()

    // Before a token is issued nothing is accepted.
    expect(token.verify('ab'.repeat(32))).toBe(false)

    await token.issue(dir)
    const written = readFileSync(join(dir, UI_TOKEN_FILE), 'utf8')

    expect(written).toBe('ab'.repeat(32))
    expect(token.verify(written)).toBe(true)
    for (const candidate of ['', 'ab', 'ab'.repeat(33), 'zz'.repeat(32), 'AB'.repeat(32), '⛏']) {
      expect(token.verify(candidate), JSON.stringify(candidate)).toBe(false)
    }
    // Every comparison, matching or not, ran on two SHA-256 digests.
    expect(compared.length).toBeGreaterThan(0)
    expect(compared.every(([a, b]) => a === 32 && b === 32)).toBe(true)
  })

  it('[ADR-003, NFR-SEC-05] issue writes 32 random bytes as hex into a run directory it creates, replacing a file left by a previous boot', async () => {
    const dir = runDir()
    const first = new UiToken()
    await first.issue(dir)
    const firstHex = readFileSync(join(dir, UI_TOKEN_FILE), 'utf8')

    const second = new UiToken()
    await second.issue(dir)
    const secondHex = readFileSync(join(dir, UI_TOKEN_FILE), 'utf8')

    expect(firstHex).toMatch(/^[0-9a-f]{64}$/)
    expect(secondHex).toMatch(/^[0-9a-f]{64}$/)
    expect(secondHex).not.toBe(firstHex)
    expect(second.verify(secondHex)).toBe(true)
    expect(second.verify(firstHex)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')(
    '[ADR-003, NFR-SEC-05] a link planted at run/ui.token is replaced, never written through',
    async () => {
      const dir = runDir()
      const victim = join(dir, '..', 'victim.txt')
      await new UiToken().issue(dir)
      rmSync(join(dir, UI_TOKEN_FILE))
      writeFileSync(victim, 'untouched')
      symlinkSync(victim, join(dir, UI_TOKEN_FILE))

      await new UiToken().issue(dir)

      expect(readFileSync(victim, 'utf8')).toBe('untouched')
      expect(existsSync(join(dir, UI_TOKEN_FILE))).toBe(true)
      expect(readFileSync(join(dir, UI_TOKEN_FILE), 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    }
  )
})
