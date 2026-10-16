// L8 OS lane (17 §1.8; ADR-016 item 1): the modes `NodeFs` gives what it writes, on a real POSIX
// disk. A file the Host writes into another tool's folder may hold a channel token, so a new file
// is owner-only (`0600`), a replaced file keeps the mode it had, and a folder the Host makes is
// owner-only (`0700`); a folder that already exists is left as it is. Windows has no POSIX modes,
// and `NodeFs` changes nothing there, so these cases run on macOS and Linux only. Runs only in
// `pnpm test:os`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { NodeFs } from './NodeFs'

const mode = (path: string): number => statSync(path).mode & 0o7777

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-nodefs-os-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe.runIf(process.platform !== 'win32')('NodeFs modes on POSIX', () => {
  it('[ADR-016] a new file written atomically is 0600', async () => {
    const path = join(root(), 'dwarfai-miners-permission.ts')

    expect(await new NodeFs().writeFileAtomic(path, 'token inside')).toStrictEqual({
      ok: true,
      value: undefined
    })

    expect(mode(path)).toBe(0o600)
  })

  it('[ADR-016] replacing a 0644 file keeps 0644, and replacing a 0600 file keeps 0600', async () => {
    for (const kept of [0o644, 0o600]) {
      const path = join(root(), 'settings.json')
      writeFileSync(path, '{}\n')
      chmodSync(path, kept)

      expect(await new NodeFs().writeFileAtomic(path, '{"hooks":{}}\n')).toStrictEqual({
        ok: true,
        value: undefined
      })

      expect(mode(path)).toBe(kept)
    }
  })

  it('[ADR-016] makeDir makes every missing folder 0700 and leaves an existing one as it is', async () => {
    const base = root()
    const existing = join(base, '.config')
    mkdirSync(existing)
    chmodSync(existing, 0o755)

    const made = await new NodeFs().makeDir(join(existing, 'opencode', 'plugin'))

    expect(made).toStrictEqual({ ok: true, value: undefined })
    expect(mode(join(existing, 'opencode'))).toBe(0o700)
    expect(mode(join(existing, 'opencode', 'plugin'))).toBe(0o700)
    expect(mode(existing)).toBe(0o755)
  })
})
