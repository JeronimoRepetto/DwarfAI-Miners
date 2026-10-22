/*
 * How a Valle zone joins the on-screen report (07 S39.05; ISSUE-299): the root provides `track`
 * (`useVallePresence`), and each zone component (ISSUE-302…ISSUE-304) registers its element and what it shows.
 *
 * And what a zone or a nav page draws when it shows the Map, the Mines list or a mine's history (ISSUE-304; 07 S31.03…
 * S31.05, S28.19): the root provides the window's own board and page parts (`VALLE_PAGES`), the same composables the
 * Panel's shell uses, so every hosted page reads one store set per window (ADR-033 item 5).
 */
import type { InjectionKey } from 'vue'
import type { useMines } from '../../composables/useMines'
import type { MapPage } from '../../composables/useMapPage'
import type { MinesPage } from '../../composables/useMinesPage'
import type { VallePresence } from '../../composables/useVallePresence'

/** The Valle root's `track`, injected by the zones it draws. */
export const VALLE_TRACK_ZONE: InjectionKey<VallePresence['track']> = Symbol('valle-track-zone')

/** The board and the page parts the hosted pages draw from. */
export interface VallePages {
  /** The window's board read model (`useMines().state`). */
  readonly board: ReturnType<typeof useMines>['state']
  readonly map: MapPage
  readonly mines: MinesPage
}

/** The Valle root's pages, injected by the pages a zone or a nav page hosts. */
export const VALLE_PAGES: InjectionKey<VallePages> = Symbol('valle-pages')
