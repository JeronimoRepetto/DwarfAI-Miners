// The per-view token files over a per-test temp dir (ADR-003 item 12): owner-only, exclusive, swept.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunDirViewerTokenFiles, viewerTokenDir } from './RunDirViewerTokenFiles'

const VIEW = '00000000-0000-7000-8000-000000000001'
const TOKEN = 'ab'.repeat(32)
const POSIX = process.platform !== 'win32'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dwarfai-viewer-tokens-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('RunDirViewerTokenFiles', () => {
  it('[ADR-003] writes run/viewers/<viewId>.token holding the token only, 0600 inside a 0700 folder', async () => {
    const path = await new RunDirViewerTokenFiles({ hostDataDir: root }).write(VIEW, TOKEN)

    expect(path).toBe(join(root, 'run', 'viewers', `${VIEW}.token`))
    expect(readFileSync(path, 'utf8')).toBe(TOKEN)
    if (POSIX) {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(viewerTokenDir(root)).mode & 0o777).toBe(0o700)
    }
  })

  it('[ADR-003] never overwrites a file already at the path', async () => {
    const files = new RunDirViewerTokenFiles({ hostDataDir: root })
    await files.write(VIEW, TOKEN)

    await expect(files.write(VIEW, 'cd'.repeat(32))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(viewerTokenDir(root), `${VIEW}.token`), 'utf8')).toBe(TOKEN)
  })

  it('[ADR-003] refuses a view id that is not a UUID, so no file leaves run/viewers', async () => {
    await expect(
      new RunDirViewerTokenFiles({ hostDataDir: root }).write('../escape', TOKEN)
    ).rejects.toThrow('view id')
  })

  it('[ADR-015] remove drops one file and sweep removes every token file left at boot', async () => {
    const files = new RunDirViewerTokenFiles({ hostDataDir: root })
    await files.write(VIEW, TOKEN)
    await files.write('00000000-0000-7000-8000-000000000002', TOKEN)
    await files.write('00000000-0000-7000-8000-000000000003', TOKEN)
    writeFileSync(join(viewerTokenDir(root), 'keep.txt'), 'not a token')

    await files.remove(VIEW)
    await files.remove(VIEW)
    expect(readdirSync(viewerTokenDir(root)).sort()).toEqual([
      '00000000-0000-7000-8000-000000000002.token',
      '00000000-0000-7000-8000-000000000003.token',
      'keep.txt'
    ])
    await files.sweep()
    expect(readdirSync(viewerTokenDir(root))).toEqual(['keep.txt'])
  })

  it('[ADR-015] sweep of a folder that was never made is a no-op', async () => {
    await expect(new RunDirViewerTokenFiles({ hostDataDir: root }).sweep()).resolves.toBeUndefined()
  })
})
