import { createApp } from 'vue'
// Bundled, never fetched: the panel must render the same with no network, and
// the CSP in index.html allows no remote origin. All subsets, because a project
// name comes off the user's disk and may be in any script the font covers.
import '@fontsource/tiny5/400.css'
import App from './App.vue'
import './assets/base.css'
import './assets/design-tokens.css'
import './assets/theme.css'

createApp(App).mount('#app')
