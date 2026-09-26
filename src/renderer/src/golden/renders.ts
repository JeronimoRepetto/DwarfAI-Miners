/*
 * What each golden state draws (#634): the real component, with props built from the design's
 * sample data as the golden page loaded it. Keyed by the manifest key `states.json` lists; the
 * state ids are the only design text here (PO ruling G-03).
 *
 * A render reaches a state through the component's own props, exactly as the app would; it never
 * styles the component. The stage and a component's UI kit framing come from the design's docs at
 * run time, so an entry that needs a tweak to match its reference has found a gap in the
 * component, which the rebuild (#635) closes.
 */
import type { Component } from 'vue'
import ShellNav from '../components/shell/ShellNav.vue'
import type { GoldenSample } from './sample'

export interface GoldenRender {
  component: Component
  props: Record<string, unknown>
}

export const RENDERS: Record<string, (sample: GoldenSample) => GoldenRender> = {
  // The Panel's nav on the Mines page with the music playing; whether the shortcut failed is the
  // sample configuration's.
  'organisms/nav#default': (sample) => ({
    component: ShellNav,
    props: { area: 'mines', broken: sample.config.shortcutFailed, musicPlaying: true }
  })
}
