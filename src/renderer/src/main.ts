import { createApp } from 'vue'
// Bundled, never fetched: the panel must render the same with no network, and
// the CSP in index.html allows no remote origin. All subsets, because a project
// name comes off the user's disk and may be in any script the font covers.
import '@fontsource/tiny5/400.css'
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
