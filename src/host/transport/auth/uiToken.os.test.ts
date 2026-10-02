// L8 OS lane (17 §1.8): the per-boot uiToken of ADR-003 item 3 against a real symlink on macOS and Linux. MOVED for
// the cut-0 conformance audit from uiToken.test.ts, where it ran under `it.runIf(!win32)` in `pnpm test`; its
// assertions are unchanged.
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

describe.runIf(process.platform !== 'win32')('UiToken on POSIX (ADR-003 item 3)', () => {
  it('[ADR-003, NFR-SEC-05] a link planted at run/ui.token is replaced, never written through', async () => {
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
  })
})
