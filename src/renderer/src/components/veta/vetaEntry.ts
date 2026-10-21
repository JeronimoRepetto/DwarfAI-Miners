/*
 * Which root this page mounts (ADR-025 item 1; 05 §2.3): every mode window loads the same bundle, and UI
 * main names the mode in the entry's query. The Veta window loads it with `?mode=veta`; every other
 * window is the Panel. Pure.
 */

/** The roots this build's renderer mounts. Valle joins with its window (EPIC-20). */
export type WindowRoot = 'panel' | 'veta'

/** The root for the page's query string (`location.search`). */
export function windowRoot(search: string): WindowRoot {
  return new URLSearchParams(search).get('mode') === 'veta' ? 'veta' : 'panel'
}
