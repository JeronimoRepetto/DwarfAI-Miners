/*
 * How a Valle zone joins the on-screen report (07 S39.05; ISSUE-299): the root provides `track`
 * (`useVallePresence`), and each zone component (ISSUE-302…ISSUE-304) registers its element and what it shows.
 */
import type { InjectionKey } from 'vue'
import type { VallePresence } from '../../composables/useVallePresence'

/** The Valle root's `track`, injected by the zones it draws. */
export const VALLE_TRACK_ZONE: InjectionKey<VallePresence['track']> = Symbol('valle-track-zone')
