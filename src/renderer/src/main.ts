import { createApp } from 'vue'
// Bundled, never fetched: the panel must render the same with no network, and
// the CSP in index.html allows no remote origin. All subsets, because a project
// name comes off the user's disk and may be in any script the font covers.
import '@fontsource/tiny5/400.css'
// The titles face (#635): Jacquard 12, blackletter for titles only, bundled like the rest.
import '@fontsource/jacquard-12/400.css'
// The conversation face (#347). The whole variable cut, not one static weight:
// emphasis inside a bubble is a real 700 off this axis, and asking for a weight
// the bundle does not carry is what synthetic bold looks like.
import '@fontsource-variable/pixelify-sans'
// The third face Settings offers (#370), self-hosted here rather than pulled in
// as a package: a font is a static asset, and the two above are packages only
// because they already existed as ones. Arial is the fourth and is bundled
// nowhere — the design's amendment says to use the platform's own.
import './assets/fonts/roboto/roboto.css'
import App from './App.vue'
import './assets/base.css'
import './assets/design-tokens.css'
import './assets/theme.css'
import { restoreLaunchView } from './composables/useView'
import { modeTransitionPart } from './composables/useModeTransition'
import { usePanelFrameClock } from './composables/usePanelFrameClock'
import VetaApp from './components/veta/VetaApp.vue'
import { windowRoot } from './components/veta/vetaEntry'
import ValleApp from './components/valle/ValleApp.vue'
import { isValleRoot, valleBridgeOf } from './components/valle/valleEntry'
import { readValleStores } from './composables/useValleStores'

/*
 * One window, one root (#635). The message panel had a window of its own beside the shell (#162),
 * loaded from this same page with a surface query and rooted in MessagePanelWindow.vue; the
 * decision log anchors it in the Panel, and it mounts in the shell's dock slot now, so this page
 * has the shell's root and no other.
 *
 * The shell opens on the page and the mine it last closed on (#635, PANEL-QUESTIONS 25), read
 * before it mounts so its first paint is that page, never the Map corrected a frame later.
 * restoreLaunchView never rejects: a bridge that cannot answer opens the default view.
 */
//
// This window plays its part in every mode transition run from its first frame (ISSUE-284; ADR-025 item 3): it answers
// each run and veils its content after a source half even with no chat open, so no run waits for the coordinator's
// watchdog. An open chat registers its hand-off with the same part.
//
// The Veta window loads this same page with `?mode=veta` (ADR-025 item 1; ISSUE-285) and mounts the Veta root; it
// plays its part in every run too. UI main builds that window only where Veta is in the build's built-modes list.
//
// The Panel's sprites play on a clock held still while the Panel window is hidden (ISSUE-297; ADR-025 item 7): UI main
// says when it is, because a hidden frameless window's `document.hidden` is a platform detail. Veta keeps its own
// clock, which plays while Veta is shown.
//
// The Valle window loads this same page with `?mode=valle` (ADR-025 item 1; ISSUE-299) and mounts the Valle root once
// its stores and session fields were read, so its first paint is the stored layout (07 S39.03). UI main builds that
// window only where Valle is in the build's built-modes list.
modeTransitionPart()
if (isValleRoot(window.location.search)) {
  const bridge = valleBridgeOf(window.api)
  void readValleStores(bridge).then((stores) => {
    createApp(ValleApp, { bridge, stores }).mount('#app')
  })
} else if (windowRoot(window.location.search) === 'veta') {
  createApp(VetaApp).mount('#app')
} else {
  void restoreLaunchView(window.api).then(() => {
    const panel = createApp(App)
    usePanelFrameClock(panel, window.api)
    panel.mount('#app')
  })
}
