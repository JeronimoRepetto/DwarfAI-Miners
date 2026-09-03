import { readFile, rename, writeFile } from 'node:fs/promises'
import type { PanelEdge } from '../domain/types'

/**
 * The persisted Settings position preference (#138): which screen edge the
 * docked shell opens on.
 *
 * Storage deliberately mirrors the pin and shortcut preferences
 * (src/main/shell/pinPreference.ts, src/main/shell/shortcutPreference.ts):
 * one tiny JSON document under userData, rewritten atomically through a
 * sibling temp file plus a rename, with an injected fs so the tests need no
 * real disk and Electron is never imported here — the wiring in
 * src/main/index.ts owns the userData path, keeping this module
 * unit-testable without an app instance.
 */

/** The design names Right as the default side (screens/settings.md). */
export const DEFAULT_PANEL_EDGE: PanelEdge = 'right'

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface PanelEdgePreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: PanelEdgePreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure: stored bytes -> edge. Anything that is not exactly
 * `{ "edge": "left" | "right" }` (corrupt JSON, wrong shape, an edge no build
 * recognizes) falls back to the default — a broken file must behave like a
 * missing one, never block startup, and never let a stray value read as a
 * choice.
 */
export function parsePanelEdgePreference(raw: string): PanelEdge {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_PANEL_EDGE
    }
    const edge = (parsed as Record<string, unknown>).edge
    return edge === 'left' || edge === 'right' ? edge : DEFAULT_PANEL_EDGE
  } catch {
    return DEFAULT_PANEL_EDGE
  }
}

/** Pure inverse of parsePanelEdgePreference; newline-terminated like the other markers. */
export function serializePanelEdgePreference(edge: PanelEdge): string {
  return `${JSON.stringify({ edge })}\n`
}

export interface PanelEdgePreferenceStore {
  /** The stored edge, or the documented default when there is none (or it is unreadable). */
  load: () => Promise<PanelEdge>
  /** Persist atomically. Rejections are the caller's to log — the move itself already happened. */
  save: (edge: PanelEdge) => Promise<void>
}

export interface PanelEdgePreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: PanelEdgePreferenceFsLike
}

export function createPanelEdgePreferenceStore(
  options: PanelEdgePreferenceStoreOptions
): PanelEdgePreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<PanelEdge> {
    try {
      return parsePanelEdgePreference(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return DEFAULT_PANEL_EDGE
    }
  }

  async function save(edge: PanelEdge): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializePanelEdgePreference(edge), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
