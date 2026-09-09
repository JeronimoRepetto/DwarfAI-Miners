import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  MINE_PATH_MISSING_REASON,
  MINE_PATH_OUTSIDE_REASON,
  MINE_PATH_UNOPENABLE_REASON,
  parseMineOpenPathRequest,
  resolveMinePathTarget,
  verifyMinePath
} from './openMineFile'

/**
 * Resolving an activity line's path against its mine's own folder (#279).
 *
 * Pure and Electron-free, like `messagePanelState.ts` beside it: `shell.openPath`
 * itself is Electron and lives in `index.ts`'s wiring, so what is tested here is
 * everything that decides WHETHER that call is even safe to make — containment,
 * relative joining, and (through `verifyMinePath`) existence, with `FakeFs`
 * standing in for the disk the way it does everywhere else in this suite.
 */

const MINE_FOLDER_WIN = 'C:\\Users\\j\\proj'
const MINE_FOLDER_POSIX = '/home/j/proj'

describe('resolveMinePathTarget', () => {
  it('accepts an absolute target that lies inside the mine folder (win32)', () => {
    const result = resolveMinePathTarget(
      MINE_FOLDER_WIN,
      'C:\\Users\\j\\proj\\src\\main\\index.ts',
      'win32'
    )
    expect(result).toEqual({ ok: true, absolutePath: 'C:\\Users\\j\\proj\\src\\main\\index.ts' })
  })

  it('joins a relative target onto the mine folder (win32)', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_WIN, 'src\\main\\index.ts', 'win32')
    expect(result).toEqual({ ok: true, absolutePath: 'C:\\Users\\j\\proj\\src\\main\\index.ts' })
  })

  it('joins a relative target that arrived with forward slashes (win32 accepts both)', () => {
    // Codex's registry writes `\`, a rollout's session_meta.cwd can carry `/` —
    // the same cross-separator reality normalizePathKey's own doc comment
    // states, and a target string is no different.
    const result = resolveMinePathTarget(MINE_FOLDER_WIN, 'src/main/index.ts', 'win32')
    expect(result).toEqual({ ok: true, absolutePath: 'C:\\Users\\j\\proj\\src\\main\\index.ts' })
  })

  it('refuses an absolute target outside the mine folder (win32)', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_WIN, 'C:\\Users\\j\\other\\file.ts', 'win32')
    expect(result).toEqual({ ok: false })
  })

  it('refuses a relative target that climbs out of the mine folder with ..', () => {
    const result = resolveMinePathTarget(
      MINE_FOLDER_WIN,
      '..\\..\\Windows\\System32\\cmd.exe',
      'win32'
    )
    expect(result).toEqual({ ok: false })
  })

  it("refuses a sibling folder whose name merely starts with the mine folder's name", () => {
    // "proj" must not admit "projEvil" as a child — the whole reason the
    // containment check requires the folder's own separator right after it.
    const result = resolveMinePathTarget(
      MINE_FOLDER_WIN,
      'C:\\Users\\j\\projEvil\\secret.txt',
      'win32'
    )
    expect(result).toEqual({ ok: false })
  })

  it('refuses a target on a different Windows drive letter than the mine', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_WIN, 'D:\\evil\\secret.txt', 'win32')
    expect(result).toEqual({ ok: false })
  })

  it('accepts the mine folder itself as a target', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_WIN, MINE_FOLDER_WIN, 'win32')
    expect(result).toEqual({ ok: true, absolutePath: MINE_FOLDER_WIN })
  })

  it('compares containment case-insensitively on win32', () => {
    const result = resolveMinePathTarget(
      MINE_FOLDER_WIN,
      'C:\\USERS\\J\\PROJ\\src\\index.ts',
      'win32'
    )
    expect(result.ok).toBe(true)
  })

  /*
   * Cross-platform assertions run on this Windows host via node:path's OS
   * submodules rather than the real process.platform (platform-ports): a
   * Platform parameter stands in for the OS so 'darwin'/'linux' behaviour is
   * assertable here.
   */
  it('joins a relative target onto the mine folder (posix)', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_POSIX, 'src/main/index.ts', 'linux')
    expect(result).toEqual({ ok: true, absolutePath: '/home/j/proj/src/main/index.ts' })
  })

  it('refuses a relative target that climbs out of the mine folder with .. (posix)', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_POSIX, '../../etc/passwd', 'linux')
    expect(result).toEqual({ ok: false })
  })

  it('is case-sensitive on linux, unlike win32', () => {
    const result = resolveMinePathTarget(MINE_FOLDER_POSIX, '/home/j/PROJ/src/index.ts', 'linux')
    expect(result).toEqual({ ok: false })
  })
})

describe('verifyMinePath', () => {
  it('opens a target that is inside the mine and exists', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\Users\\j\\proj\\src\\main\\index.ts', 'export {}')
    const verdict = await verifyMinePath(MINE_FOLDER_WIN, 'src\\main\\index.ts', 'win32', fs)
    expect(verdict).toEqual({
      opened: true,
      absolutePath: 'C:\\Users\\j\\proj\\src\\main\\index.ts'
    })
  })

  it('refuses a target outside the mine with the fixed sentence, never an OS path', async () => {
    const fs = new FakeFs()
    const verdict = await verifyMinePath(MINE_FOLDER_WIN, '..\\..\\secret.txt', 'win32', fs)
    expect(verdict).toEqual({ opened: false, reason: MINE_PATH_OUTSIDE_REASON })
  })

  it('refuses a target inside the mine that no longer exists', async () => {
    const fs = new FakeFs()
    const verdict = await verifyMinePath(MINE_FOLDER_WIN, 'src\\gone.ts', 'win32', fs)
    expect(verdict).toEqual({ opened: false, reason: MINE_PATH_MISSING_REASON })
  })

  it("never leaks the fs adapter's own error text as the reason", async () => {
    const fs = new FakeFs()
    const verdict = await verifyMinePath(MINE_FOLDER_WIN, '..\\escape.ts', 'win32', fs)
    expect(typeof verdict.opened === 'boolean' && !verdict.opened && verdict.reason).toBe(
      MINE_PATH_OUTSIDE_REASON
    )
  })
})

describe('parseMineOpenPathRequest', () => {
  it('reads a well-formed request', () => {
    expect(parseMineOpenPathRequest({ mineId: 'mine:1', target: 'src/index.ts' })).toEqual({
      mineId: 'mine:1',
      target: 'src/index.ts'
    })
  })

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing mineId', { target: 'src/index.ts' }],
    ['empty mineId', { mineId: '', target: 'src/index.ts' }],
    ['missing target', { mineId: 'mine:1' }],
    ['empty target', { mineId: 'mine:1', target: '' }],
    ['non-string target', { mineId: 'mine:1', target: 42 }]
  ])('refuses %s', (_label, payload) => {
    expect(parseMineOpenPathRequest(payload)).toBeNull()
  })

  /**
   * #348. A mine folded from several worktrees has a crew in several folders,
   * so the click says which dwarf it came from and main reads that dwarf's
   * worktree off the board. Still an id, never a folder.
   */
  it('carries the dwarf the click came from, when the panel named one', () => {
    expect(
      parseMineOpenPathRequest({ mineId: 'mine:1', target: 'src/index.ts', dwarfId: 'claude:s1' })
    ).toEqual({ mineId: 'mine:1', target: 'src/index.ts', dwarfId: 'claude:s1' })
  })

  it.each([
    ['absent', {}],
    ['empty', { dwarfId: '' }],
    ['not a string', { dwarfId: 7 }]
  ])('reads the request without a dwarf when the id is %s', (_label, extra) => {
    // Dropped rather than refused: the request still means something without
    // one, and it resolves against the mine's own folder exactly as before.
    expect(
      parseMineOpenPathRequest({ mineId: 'mine:1', target: 'src/index.ts', ...extra })
    ).toEqual({ mineId: 'mine:1', target: 'src/index.ts' })
  })
})

/** Reason constants exist to prove a caller who imports one gets a real sentence. */
describe('fixed refusal copy', () => {
  it('never reuses the OS-facing MINE_PATH_UNOPENABLE_REASON for a missing file', () => {
    expect(MINE_PATH_MISSING_REASON).not.toBe(MINE_PATH_UNOPENABLE_REASON)
    expect(MINE_PATH_OUTSIDE_REASON).not.toBe(MINE_PATH_MISSING_REASON)
  })
})
