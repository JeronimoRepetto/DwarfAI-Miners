import { readFile, rename, writeFile } from 'node:fs/promises'
import { parseLaunchView, type LaunchView } from '../domain/types'

/**
 * The page and the mine the app opens on (#635): the ones that were open when it last closed, kept
 * per machine (PO ruling 2026-09-27, PANEL-QUESTIONS 25; decision log, "Launch restores the last
 * page and mine"). A first run, with nothing stored, opens the default view.
 *
 * Storage deliberately mirrors the pin, edge, audio and typography preferences
 * (src/main/shell/audioPreference.ts and its siblings): one tiny JSON document under userData,
 * rewritten atomically through a sibling temp file plus a rename, with an injected fs so the tests
 * need no real disk and Electron is never imported here — the wiring in src/main/index.ts owns
 * the userData path. A preference store rather than a key in the three-layer config because it is
 * where the person last was, written at runtime, never something an operator sets (see the
 * `config-layering` skill). The PARSER is `parseLaunchView` in `shared/contracts.ts`, shared with
 * the preload and the renderer, so this file has no defaults of its own.
 *
 * ## Why `remember` coalesces
 *
 * Unlike a Settings control, the view changes on every nav press and every mine walked into, and
 * the renderer reports each change as it happens. So a burst never becomes a write storm: at most
 * one write is in flight, and only the LATEST view waits behind it — every view reported while a
 * write lands collapses into that one — and a view identical to the one on disk writes nothing.
 * Nothing is delayed on a timer either: the view is on its way to disk the moment it changes, so a
 * quit right after a click loses at most the write still landing.
 *
 * Nothing here fails startup or rejects a report: a corrupt document is the shape half of the
 * `config-layering` rule and reads as nothing remembered, but never QUIETLY — `onWarn` names the
 * file — and a failed write is warned the same way, because the view it would have stored is
 * already on screen.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface LaunchViewFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: LaunchViewFsLike = { readFile, writeFile, rename }

/**
 * Pure inverse of `parseLaunchView`, newline-terminated like the other markers — and it PARSES what
 * it was handed on the way out, so the one writer under our control cannot produce a file the next
 * startup would have to correct.
 */
export function serializeLaunchView(view: LaunchView): string {
  return `${JSON.stringify(parseLaunchView(view))}\n`
}

export interface LaunchViewStore {
  /** The stored view, or the default view when there is none or it is unreadable. */
  load: () => Promise<LaunchView>
  /**
   * Store the view the shell now shows. Resolves once it, or a view reported after it, is on disk
   * or its write has failed and been warned about; never rejects.
   */
  remember: (view: LaunchView) => Promise<void>
}

export interface LaunchViewStoreOptions {
  /** Full path of the document (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: LaunchViewFsLike
  /** Where a discarded document or a failed write is reported; defaults to console.warn. */
  onWarn?: (message: string) => void
}

export function createLaunchViewStore(options: LaunchViewStoreOptions): LaunchViewStore {
  const fs = options.fs ?? realFs
  const warn = options.onWarn ?? ((message: string) => console.warn(message))

  /** The bytes known to be on disk, so a report of the same view writes nothing. */
  let stored: string | undefined
  /** The latest view reported while a write was landing, or undefined when none is waiting. */
  let waiting: LaunchView | undefined
  let writing: Promise<void> | undefined

  async function load(): Promise<LaunchView> {
    let raw: string
    try {
      raw = await fs.readFile(options.filePath, 'utf8')
    } catch {
      // Missing file is the common first-run case; any other read failure (permissions, transient
      // IO) is treated the same way because a launch view is never worth failing startup over.
      return parseLaunchView(undefined)
    }
    let document: unknown
    try {
      document = JSON.parse(raw)
    } catch {
      warn(`[launch-view] ${options.filePath} is not readable JSON; the app opens on the Map.`)
      return parseLaunchView(undefined)
    }
    const view = parseLaunchView(document)
    if (raw === serializeLaunchView(view)) stored = raw
    return view
  }

  /** Writes every view reported until none is waiting; each failure is warned, never thrown. */
  async function drain(): Promise<void> {
    while (waiting !== undefined) {
      const next = serializeLaunchView(waiting)
      waiting = undefined
      if (next === stored) continue
      const tempPath = `${options.filePath}${TEMP_SUFFIX}`
      try {
        await fs.writeFile(tempPath, next, 'utf8')
        await fs.rename(tempPath, options.filePath)
        stored = next
      } catch (error) {
        warn(
          `[launch-view] Could not write ${options.filePath} (${String(error)}); the next start may open an older view.`
        )
      }
    }
  }

  /*
   * `writing` is let go in a continuation rather than inside `drain`: a drain with nothing to write
   * finishes synchronously, before `??=` below has even stored it, and clearing it there would leave
   * a settled promise standing in for a write forever. A view reported while that continuation was
   * queued is picked up by it rather than dropped.
   */
  function run(): Promise<void> {
    return drain().then(() => {
      writing = undefined
      return waiting === undefined ? undefined : remember(waiting)
    })
  }

  function remember(view: LaunchView): Promise<void> {
    waiting = view
    writing ??= run()
    return writing
  }

  return { load, remember }
}
