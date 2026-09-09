import { readFile, rename, writeFile } from 'node:fs/promises'
import type { MessagePanelAnchor } from './panelBounds'

/**
 * The persisted position of a message panel the person moved (#296): where the
 * window was left, so closing it, reopening it, or restarting the app brings it
 * back there rather than back beside the shell.
 *
 * Storage deliberately mirrors the position, pin and shortcut preferences
 * (src/main/shell/panelEdgePreference.ts, pinPreference.ts,
 * shortcutPreference.ts): one tiny JSON document under userData, rewritten
 * atomically through a sibling temp file plus a rename, with an injected fs so
 * the tests need no real disk and Electron is never imported here — the wiring
 * in src/main/index.ts owns the userData path, keeping this module
 * unit-testable without an app instance.
 *
 * `userData` rather than the config layer, and not because it is easier: this
 * is not a setting anybody types. It is a fact about a window the person
 * produced with a gesture, the app is its only writer, and it has to be
 * reachable from an INSTALLED build — which is the whole trap the config
 * skill's own layering exists for. The three preferences named above are
 * exactly the same kind of fact and this is their shape.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface MessagePanelPositionFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: MessagePanelPositionFsLike = { readFile, writeFile, rename }

/**
 * Pure: stored bytes -> anchor, or `null` for "still docked".
 *
 * Anything that is not exactly `{ "x": number, "bottom": number }` reads as
 * docked — corrupt JSON, a wrong shape, a coordinate that is not a finite
 * number. A broken file must behave like a missing one, never block startup,
 * and never let a stray value place a window: a non-finite coordinate reaches
 * `setBounds` as a rectangle Electron cannot apply, and the panel would vanish
 * with nothing saying why (the same refusal `parseMessagePanelHeight` makes at
 * the IPC boundary, for the same reason).
 *
 * Rounded here rather than in the geometry, because this is the boundary and
 * Electron's bounds take whole pixels.
 */
export function parseMessagePanelPosition(raw: string): MessagePanelAnchor | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { x, bottom } = parsed as Record<string, unknown>
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    if (typeof bottom !== 'number' || !Number.isFinite(bottom)) return null
    return { x: Math.round(x), bottom: Math.round(bottom) }
  } catch {
    return null
  }
}

/**
 * Pure inverse of parseMessagePanelPosition; newline-terminated like the other
 * markers.
 *
 * Docked is written as an empty document rather than by deleting the file: the
 * atomic write is the only path this module has, so "snap it back" persists the
 * same way "put it there" does, and a reader of the two states sees one file
 * either way.
 */
export function serializeMessagePanelPosition(anchor: MessagePanelAnchor | null): string {
  return `${JSON.stringify(anchor === null ? {} : { x: anchor.x, bottom: anchor.bottom })}\n`
}

export interface MessagePanelPositionStore {
  /** The stored anchor, or null when the panel has never been moved (or the file is unreadable). */
  load: () => Promise<MessagePanelAnchor | null>
  /** Persist atomically. Rejections are the caller's to log — the move itself already happened. */
  save: (anchor: MessagePanelAnchor | null) => Promise<void>
}

export interface MessagePanelPositionStoreOptions {
  /** Full path of the position file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: MessagePanelPositionFsLike
}

export function createMessagePanelPositionStore(
  options: MessagePanelPositionStoreOptions
): MessagePanelPositionStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<MessagePanelAnchor | null> {
    try {
      return parseMessagePanelPosition(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way, because where a
      // window sits is never worth failing startup over.
      return null
    }
  }

  async function save(anchor: MessagePanelAnchor | null): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeMessagePanelPosition(anchor), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
