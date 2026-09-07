/**
 * Which of the app's two windows this renderer is running in (#162).
 *
 * The message panel is a window of its own, and it is the SAME page: main
 * loads `index.html` again with `?surface=message-panel`, and `main.ts` picks
 * its root component from the answer here. One bundle, one stylesheet, one
 * Content-Security-Policy — a second renderer entry in
 * `electron.vite.config.ts` would duplicate all three for one component, and
 * every design token the panel draws with lives in the first one.
 *
 * Pure, and takes the query rather than reading `window.location`: that is
 * what makes both branches assertable, and it is the only thing about the two
 * windows the renderer has to decide.
 */
import { MESSAGE_PANEL_SURFACE, RENDERER_SURFACE_PARAM, type RendererSurface } from '../../types'

/**
 * Read the surface out of a location query — with or without its leading `?`,
 * and whatever else the dev server appended beside it.
 *
 * Anything unrecognised is the SHELL rather than nothing: it is the only root
 * that draws itself from main's own state, so a query that means nothing in
 * this build still opens a window with something in it.
 */
export function rendererSurface(search: string): RendererSurface {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return params.get(RENDERER_SURFACE_PARAM) === MESSAGE_PANEL_SURFACE
    ? MESSAGE_PANEL_SURFACE
    : 'shell'
}
