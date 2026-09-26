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
import MessagePanelWindow from './MessagePanelWindow.vue'
import './assets/base.css'
import './assets/design-tokens.css'
import './assets/theme.css'
import { rendererSurface } from './lib/shell/surface'

/*
 * Which of the app's two windows this is (#162). The message panel is a window
 * of its own beside the shell, and it is the SAME page: main loads it again
 * with the surface query, so one bundle, one stylesheet and one CSP serve
 * both roots. See lib/shell/surface for why that beats a second entry.
 */
const surface = rendererSurface(window.location.search)

createApp(surface === 'message-panel' ? MessagePanelWindow : App).mount('#app')
