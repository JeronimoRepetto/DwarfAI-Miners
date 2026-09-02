<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import FeedModal from './components/panel/FeedModal.vue'
import MapView from './components/map/MapView.vue'
import MineScene from './components/scene/MineScene.vue'
import ShortcutSettings from './components/panel/ShortcutSettings.vue'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { useView } from './composables/useView'
import { versionLabel, versionTitle } from './lib/appBuild'
import { shouldHidePanelAfterActivation } from './lib/delivery/activation'
import type { AppBuild, Dwarf, FeedMessage, Mine, MinesSnapshot } from './types'

const { state, setMines } = useMines()
const { state: viewState, openMine, showMap, syncWithMines } = useView()
const { state: messagingState, send: sendDwarfText } = useDwarfMessaging()
const { state: kickingState, kick } = useDwarfKicking()
const { state: questionState, answer: answerDwarfQuestion } = useDwarfQuestion()
const { pinned, sync: syncPinned, toggle: togglePinned } = usePinnedWindow()

// The hover line explains what the CURRENT state does; the accessible name
// stays stable and aria-pressed carries the state (see the pin button below).
const pinTooltip = computed(() =>
  pinned.value
    ? 'Pinned: the panel stays above other windows'
    : 'Unpinned: other windows can cover the panel'
)

/**
 * Settings surface (see #17). App owns the composable — and therefore the IPC —
 * so ShortcutSettings can stay presentational and the "render only what main
 * verified" rule lives in exactly one place.
 */
const {
  state: shortcutState,
  error: shortcutError,
  recording: shortcutRecording,
  applying: shortcutApplying,
  sync: syncShortcut,
  startRecording: startShortcutRecording,
  stopRecording: stopShortcutRecording,
  record: recordShortcut,
  reset: resetShortcut
} = useToggleShortcut()

const settingsOpen = ref(false)

/**
 * A shortcut the OS refused is flagged on the CLOSED gear too: a failure the
 * user only meets after opening settings is a failure they never look for.
 */
const shortcutBroken = computed(
  () => shortcutState.value !== null && !shortcutState.value.registered
)

const settingsTooltip = computed(() =>
  shortcutBroken.value ? 'Shortcut unavailable - click to change it' : 'Settings'
)

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value
  // Closing while the recorder is listening would leave it capturing
  // keystrokes the next time the panel opens.
  if (!settingsOpen.value) stopShortcutRecording()
}

function closeSettings(): void {
  settingsOpen.value = false
  stopShortcutRecording()
}

/**
 * Which build is running (see #79). Read from main once on mount, because a
 * version cannot change under a live process — there is nothing to keep in
 * step and nothing to subscribe to.
 *
 * Null until it arrives, and null forever if the read fails, in which case the
 * titlebar prints nothing at all. That is deliberate: a placeholder like
 * "unknown" would be furniture for a case that means the bridge itself is
 * down, and inventing a version where the real one belongs is the one failure
 * this whole feature exists to prevent.
 */
const build = ref<AppBuild | null>(null)
const versionText = computed(() => (build.value === null ? null : versionLabel(build.value)))
const versionHint = computed(() => (build.value === null ? '' : versionTitle(build.value)))

const loading = ref(true)
const error = ref<string | null>(null)
const activating = ref<string | null>(null)
const feed = ref<FeedMessage[]>([])
const feedFor = ref<string | null>(null)
let unsubscribe: (() => void) | undefined

const currentMine = computed<Mine | undefined>(() => {
  const view = viewState.view
  return view.kind === 'mine' ? state.mines.find((mine) => mine.id === view.mineId) : undefined
})

function hidePanel(): void {
  window.api.hidePanel()
}

function update(snapshot: MinesSnapshot): void {
  setMines(snapshot)
  loading.value = false
  syncWithMines(snapshot.mines.map((mine) => mine.id))
  if (import.meta.env.DEV) {
    console.log(
      '[renderer] mines:',
      snapshot.mines
        .map((mine) => `${mine.name} (${mine.tier}, ${mine.dwarfs.length} dwarfs)`)
        .join('; ') || 'none'
    )
  }
}

async function load(): Promise<void> {
  try {
    update(await window.api.getMines())
  } catch {
    error.value =
      'DwarfAI-Miners could not load active mines. It will keep trying as activity changes.'
    loading.value = false
  }
}

async function loadBuild(): Promise<void> {
  try {
    build.value = await window.api.getAppBuild()
  } catch {
    // Main is the only source there is, so there is nothing to fall back on
    // and nothing worth guessing: the titlebar stays as it was.
  }
}

function enterMine(mineId: string): void {
  openMine(mineId)
  error.value = null
}

function backToMap(): void {
  showMap()
  error.value = null
}

function closeFeed(): void {
  feed.value = []
  feedFor.value = null
}

async function activate(dwarf: Dwarf): Promise<void> {
  activating.value = dwarf.id
  error.value = null
  try {
    const result = await window.api.activateDwarf(dwarf.id)
    if (shouldHidePanelAfterActivation(result)) {
      hidePanel()
      return
    }
    if (result.focused || result.openedTerminal) {
      // A window was focused, or a new terminal now tails the transcript
      // live — nothing else to do, and the panel stays visible (it is
      // alwaysOnTop, so it never needs to get out of the way).
      return
    }
    if (result.feed.length) {
      feed.value = result.feed
      feedFor.value = dwarf.name
    } else {
      error.value = 'The agent terminal is unavailable.'
    }
  } catch {
    error.value = 'The agent terminal could not be opened.'
  } finally {
    activating.value = null
  }
}

/**
 * Delivery runs in the background: the panel stays open and usable, and the
 * verdict lands on the dwarf itself (see DwarfSprite's send-result marker)
 * rather than in a modal.
 */
function sendText(dwarf: Dwarf, payload: { text: string; pressEnter: boolean }): void {
  void sendDwarfText(dwarf.id, payload.text, payload.pressEnter)
}

/** Same reasoning as sendText: fire-and-observe, verdict lands on the dwarf itself. */
function kickDwarf(dwarf: Dwarf): void {
  void kick(dwarf.id)
}

/**
 * Answer the question that dwarf's agent is blocked on (#125).
 *
 * The question itself is never touched here. It is drawn from the dwarf's own
 * `pendingQuestion` on the latest snapshot, and only main's next snapshot may
 * drop it — the panel's part ends at handing the choice over.
 */
function answerQuestion(dwarf: Dwarf, label: string): void {
  if (dwarf.pendingQuestion === undefined) return
  void answerDwarfQuestion(dwarf.id, dwarf.pendingQuestion, label)
}

onMounted(() => {
  void load()
  // The button's initial "pinned" guess matches main's default; this adopts
  // the real BrowserWindow state (the user may have unpinned on a past run).
  void syncPinned()
  // Reads the accelerator AND whether it actually registered, so a startup
  // failure can be flagged on the gear before anyone opens settings.
  void syncShortcut()
  void loadBuild()
  unsubscribe = window.api.onMinesUpdated(update)
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="panel">
    <header class="titlebar">
      <span class="title">
        <i aria-hidden="true"></i>DwarfAI-Miners
        <!--
          The running version (see #79). A label, not a control: it stays out
          of .window-controls so nothing about it invites a click, and out of
          the no-drag region so the whole name still drags the panel.
        -->
        <span v-if="versionText" class="version" :title="versionHint">{{ versionText }}</span>
      </span>
      <div class="window-controls">
        <!--
          Settings (see #17). aria-expanded ties the gear to the panel it
          opens, and `is-broken` mirrors a shortcut the OS refused so the
          failure is visible without opening anything.
        -->
        <button
          class="settings"
          :class="{ 'is-broken': shortcutBroken }"
          type="button"
          aria-label="Settings"
          :aria-expanded="settingsOpen ? 'true' : 'false'"
          :title="settingsTooltip"
          @click="toggleSettings"
        >
          <!-- Pixel-art cog on the same 16x16 rect grid as the other icons. -->
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="6" y="1" width="4" height="2" fill="#a8703a" />
            <rect x="6" y="13" width="4" height="2" fill="#a8703a" />
            <rect x="1" y="6" width="2" height="4" fill="#a8703a" />
            <rect x="13" y="6" width="2" height="4" fill="#a8703a" />
            <rect x="3" y="3" width="2" height="2" fill="#a8703a" />
            <rect x="11" y="3" width="2" height="2" fill="#a8703a" />
            <rect x="3" y="11" width="2" height="2" fill="#a8703a" />
            <rect x="11" y="11" width="2" height="2" fill="#a8703a" />
            <rect x="4" y="4" width="8" height="8" fill="#f4c76a" />
            <rect x="6" y="6" width="4" height="4" fill="#3f2a14" />
            <!-- Warning pip: the same red the error notices use. -->
            <rect v-if="shortcutBroken" x="12" y="0" width="4" height="3" fill="#e07a5f" />
          </svg>
        </button>
        <!--
          Pin toggle (see #35): stable accessible name + aria-pressed for the
          state, tooltip explaining what the current state does. `pinned` only
          ever reflects the real BrowserWindow state handed back over IPC (see
          usePinnedWindow), so a declined or failed toggle can never paint an
          always-on-top the window does not have.
        -->
        <button
          class="pin"
          type="button"
          aria-label="Keep panel on top"
          :aria-pressed="pinned ? 'true' : 'false'"
          :title="pinTooltip"
          @click="togglePinned"
        >
          <!-- Pixel-art pushpins on the same 16x16 rect grid as the dwarf
               action bar icons (see DwarfActionBar.vue), crispEdges via CSS. -->
          <svg v-if="pinned" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="6" y="1" width="4" height="2" fill="#ffe29c" />
            <rect x="5" y="3" width="6" height="4" fill="#f4c76a" />
            <rect x="4" y="7" width="8" height="2" fill="#a8703a" />
            <rect x="7" y="9" width="2" height="4" fill="#6b5a44" />
            <rect x="7" y="13" width="2" height="2" fill="#3f2a14" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <!-- Tilted pin, needle free of the ground: nothing is held down. -->
            <rect x="10" y="1" width="4" height="2" fill="#8a7a5e" />
            <rect x="9" y="3" width="5" height="3" fill="#6b5a44" />
            <rect x="8" y="6" width="3" height="2" fill="#4b3c28" />
            <rect x="6" y="8" width="2" height="2" fill="#4b3c28" />
            <rect x="4" y="10" width="2" height="2" fill="#4b3c28" />
            <rect x="2" y="12" width="2" height="2" fill="#3f2a14" />
          </svg>
        </button>
        <button class="close" type="button" aria-label="Hide panel" @click="hidePanel">
          &times;
        </button>
      </div>
    </header>
    <ShortcutSettings
      v-if="settingsOpen"
      :state="shortcutState"
      :error="shortcutError"
      :recording="shortcutRecording"
      :applying="shortcutApplying"
      @start-recording="startShortcutRecording"
      @stop-recording="stopShortcutRecording"
      @record="recordShortcut"
      @reset="resetShortcut"
      @close="closeSettings"
    />
    <main class="content">
      <div v-if="loading" class="loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p>Scanning the hills for active agents...</p>
      </div>
      <MineScene
        v-else-if="currentMine"
        :mine="currentMine"
        :activating-id="activating"
        :send-states="messagingState.byDwarfId"
        :kick-states="kickingState.byDwarfId"
        :answer-states="questionState.byDwarfId"
        @back="backToMap"
        @activate="activate"
        @send-text="sendText"
        @kick="kickDwarf"
        @answer-question="answerQuestion"
      />
      <MapView
        v-else
        :mines="state.mines"
        :tokens-observed="state.tokensObserved"
        :materials="state.materials"
        @open="enterMine"
      />
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
    </main>
    <FeedModal v-if="feedFor" :title="feedFor" :messages="feed" @close="closeFeed" />
  </div>
</template>

<style scoped>
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  color: var(--ink);
  background: var(--bg-panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
}
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-soft);
  -webkit-app-region: drag;
}
.title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.04em;
}
/* Quiet by construction: the faintest ink in the palette, normal weight
   against the title's bold, and small enough to read as a footnote to the name
   rather than a second heading. This is a monitor — the version is there for
   the moment somebody asks, and must not draw the eye for the rest of it. */
.version {
  color: var(--ink-faint);
  font-weight: 400;
  font-size: 11px;
  letter-spacing: normal;
}
.title i {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--lantern);
  transform: rotate(45deg);
  box-shadow: 0 0 10px var(--lantern);
}
.window-controls {
  display: flex;
  gap: 2px;
  align-items: center;
}
/* Every titlebar button opts out of the frameless drag surface, or its
   clicks would start a window drag instead of reaching the handler. */
.settings,
.pin,
.close {
  -webkit-app-region: no-drag;
  border: 0;
  border-radius: 7px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font: inherit;
}
.close {
  padding: 2px 8px;
  font-size: 22px;
}
.settings,
.pin {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px 7px;
  line-height: 0;
}
.settings svg,
.pin svg {
  width: 16px;
  height: 16px;
  /* Blocky pixel look, matching the action-bar icons: no anti-aliasing
     between the rect "pixels". */
  shape-rendering: crispEdges;
}
/* The gear dims until it has something to say, so a broken shortcut is the
   thing that catches the eye rather than the settings entry point itself. */
.settings svg {
  opacity: 0.75;
}
.settings.is-broken svg,
.settings:hover svg {
  opacity: 1;
}
/* The unpinned glyph dims like a disabled action-bar icon: still clickable,
   but visually "off" next to the lit pinned pin. */
.pin[aria-pressed='false'] svg {
  opacity: 0.6;
}
.settings:hover,
.pin:hover,
.close:hover {
  color: #fff;
  background: #4b3c28;
}
.settings:focus-visible,
.pin:focus-visible,
.close:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
}
.content {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.content > * {
  flex: 1;
}
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ink-dim);
  font-size: 13px;
}
.loading p {
  margin: 0;
}
.spinner {
  width: 25px;
  height: 25px;
  border: 3px solid #655139;
  border-top-color: #f4c76a;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.notice {
  position: absolute;
  z-index: 90;
  right: 14px;
  bottom: 12px;
  left: 14px;
  flex: none;
  margin: 0;
  padding: 9px 10px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: 12px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
