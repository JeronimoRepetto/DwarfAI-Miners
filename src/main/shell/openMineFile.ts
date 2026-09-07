import { posix, win32 } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import { normalizePathKey, type Platform } from '../platform/platform'
import type { MineOpenPathRequest } from '../domain/types'

/**
 * A click on an activity line's own path (#279) — resolving it against the
 * MINE's own folder, verifying it exists, and refusing anything that escapes.
 *
 * Pure and Electron-free, like `messagePanelState.ts` beside it: `shell.openPath`
 * itself, and the mine-id-to-folder lookup, are both `index.ts`'s job — this
 * module only decides whether the call is safe to make at all, which is what
 * lets every branch below be asserted with `FakeFs` and no display.
 */

/**
 * Fixed refusal sentences (#279). Never the OS's own wording: `shell.openPath`'s
 * return value and any filesystem error are both swallowed at the call site in
 * `index.ts`, because this app decided what a person is told, not the platform.
 *
 * Three, not two, though the issue only names two refusals. A path outside the
 * mine and a path that no longer exists are the two the design calls out; a
 * third — the OS could not open a file that IS inside the mine and DOES
 * exist, e.g. no registered handler — is a real third outcome `shell.openPath`
 * can report, and conflating it with "no longer exists" would tell a person
 * their file vanished when it did not.
 */
export const MINE_PATH_OUTSIDE_REASON = "That path is outside this mine's folder."
export const MINE_PATH_MISSING_REASON = 'That file no longer exists.'
export const MINE_PATH_UNOPENABLE_REASON = 'That file could not be opened.'

/** node:path's OS-specific submodule for `platform` — never the running host's (see platform-ports). */
function pathFor(platform: Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

export type MinePathResolution =
  | { ok: true; absolutePath: string }
  | { ok: false }

/**
 * Resolve one activity line's target against the mine's own folder (#279).
 *
 * Absolute targets must already lie inside the folder; relative ones are
 * joined to it first — the design's "relative paths are relative to the
 * session's cwd, which the mine knows" (the mine's folder IS that cwd; see
 * `Mine.path`). Resolution is pure string joining through node:path's OS
 * submodule for `platform`, deliberately never `path.resolve`'s cwd-touching
 * form: a Platform parameter stands in for the OS everywhere in this app
 * (platform-ports), and reading the real process cwd here would defeat that
 * on every platform but whichever one is actually running the test.
 *
 * Containment is checked on the folded key `normalizePathKey` already owns,
 * requiring the folder's own separator immediately after the prefix — "proj"
 * must not admit "projEvil" as a child — and a Windows drive-letter target
 * folds to a key that shares no prefix with a folder on another drive at all.
 */
export function resolveMinePathTarget(
  mineFolder: string,
  target: string,
  platform: Platform
): MinePathResolution {
  const p = pathFor(platform)
  const combined = p.isAbsolute(target) ? target : p.join(mineFolder, target)
  const resolvedTarget = p.normalize(combined)
  const resolvedFolder = p.normalize(mineFolder)
  const normalizedTarget = normalizePathKey(resolvedTarget, platform)
  const normalizedFolder = normalizePathKey(resolvedFolder, platform)
  const sep = platform === 'win32' ? '\\' : '/'
  const inside =
    normalizedTarget === normalizedFolder ||
    normalizedTarget.startsWith(`${normalizedFolder}${sep}`)
  if (!inside) return { ok: false }
  return { ok: true, absolutePath: resolvedTarget }
}

/**
 * The verdict for one click, resolved AND verified (#279): inside the folder
 * and existing, or a fixed refusal.
 *
 * Existence is checked HERE, on the click, never on render: the feed is a
 * tail of a transcript polled at 2Hz, and stat-ing every path line on every
 * poll would be a disk cost nobody asked to pay for a link nobody may ever
 * press (see `screens/mine.md`'s amendment). `index.ts` calls this and then
 * `shell.openPath` itself — this function never touches Electron.
 */
export async function verifyMinePath(
  mineFolder: string,
  target: string,
  platform: Platform,
  fs: FsLike
): Promise<{ opened: true; absolutePath: string } | { opened: false; reason: string }> {
  const resolved = resolveMinePathTarget(mineFolder, target, platform)
  if (!resolved.ok) return { opened: false, reason: MINE_PATH_OUTSIDE_REASON }
  const exists = await fs.exists(resolved.absolutePath)
  if (!exists) return { opened: false, reason: MINE_PATH_MISSING_REASON }
  return { opened: true, absolutePath: resolved.absolutePath }
}

/**
 * Read the mine id and target a renderer asked to open, or refuse the
 * payload — the same boundary discipline every channel in `index.ts` holds.
 * Both fields are required and non-empty: a request naming no mine or no
 * target could not mean anything, and honouring it would be resolving a path
 * against nothing.
 */
export function parseMineOpenPathRequest(payload: unknown): MineOpenPathRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const { mineId, target } = record
  if (typeof mineId !== 'string' || mineId === '') return null
  if (typeof target !== 'string' || target === '') return null
  return { mineId, target }
}
