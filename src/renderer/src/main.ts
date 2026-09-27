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
void restoreLaunchView(window.api).then(() => createApp(App).mount('#app'))
