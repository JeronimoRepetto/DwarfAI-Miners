<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EdgeRail from './components/shell/EdgeRail.vue'
import FeedModal from './components/panel/FeedModal.vue'
import MapView from './components/map/MapView.vue'
import MineScene from './components/scene/MineScene.vue'
import MinesPanel from './components/browse/MinesPanel.vue'
import PanelFrame from './components/shell/PanelFrame.vue'
import ShellNav from './components/shell/ShellNav.vue'
import ShortcutSettings from './components/panel/ShortcutSettings.vue'
import UnavailablePanel from './components/shell/UnavailablePanel.vue'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import { usePanelLayout } from './composables/usePanelLayout'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useProjectBrowse } from './composables/useProjectBrowse'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { useView } from './composables/useView'
import { versionLabel, versionTitle } from './lib/appBuild'
import { CLOSE_ICON_SRC } from './lib/art'
import { shouldHidePanelAfterActivation } from './lib/delivery/activation'
import type { AppBuild, Dwarf, FeedMessage, Mine, MinesSnapshot, ShellArea } from './types'

const { state, setMines } = useMines()
const { state: viewState, openMine, closeMine, showArea, showMap, syncWithMines } = useView()
const { state: messagingState, send: sendDwarfText } = useDwarfMessaging()
const { state: kickingState, kick } = useDwarfKicking()
const { state: questionState, answer: answerDwarfQuestion } = useDwarfQuestion()
const { pinned, sync: syncPinned, toggle: togglePinned } = usePinnedWindow()

/**
 * The docked shell's own shape (#90). `layout` is only ever what MAIN reported,
 * because the window's rectangle is derived from the display: the rail's arrow
 * is drawn from `layout.edge`, and drawing it from a guess would point the user
 * off the screen.
 */
const { layout, sync: syncLayout, apply: applyLayout, toggle: toggleLayout } = usePanelLayout()

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

/**
 * The browse over every project the app remembers (#92). App owns the
 * composable — and therefore the IPC — for the same reason it owns the shortcut
 * one: MinesPanel then stays presentational, and the honesty rules about what a
 * refused query may render live in exactly one place.
 */
const {
  filters: browseFilters,
  projects,
  loading: browseLoading,
  error: browseError,
  exhausted: browseExhausted,
  adding: addingProject,
  addError: addProjectError,
  load: loadProjects,
  loadMore: loadMoreProjects,
  setSearch: setProjectSearch,
  setTier: setProjectTier,
  toggleDirection: toggleProjectOrder,
  addProject
} = useProjectBrowse()

/**
 * A shortcut the OS refused is flagged on the navigation stack's Settings
 * button, without anything being opened: a failure the user only meets after
 * opening settings is a failure they never look for. It was flagged on the old
 * titlebar's gear, which the design replaced.
 */
const shortcutBroken = computed(
  () => shortcutState.value !== null && !shortcutState.value.registered
)

/**
 * Selecting an area never closes the mine held open beside it — that is the
 * design's concurrent model, and it is the whole reason the two are separate
 * pieces of state.
 *
 * Every open reads the browse's first page again: the list spans projects
 * nobody is working, so nothing pushes it and a remembered page would age
 * silently. Leaving the recorder listening across a switch would capture
 * keystrokes the next time settings came back.
 */
function selectArea(area: ShellArea): void {
  if (viewState.area === 'settings' && area !== 'settings') stopShortcutRecording()
  showArea(area)
  error.value = null
  if (area === 'mines') void loadProjects()
}

/** The browse and the board share one id scheme, so a card opens its mine directly. */
function openFromBrowse(projectId: string): void {
  openMine(projectId)
  error.value = null
}

/**
 * Which build is running (see #79). Read from main once on mount, because a
 * version cannot change under a live process — there is nothing to keep in
 * step and nothing to subscribe to.
 *
 * Null until it arrives, and null forever if the read fails, in which case the
 * settings panel prints nothing at all. That is deliberate: a placeholder like
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

const currentMine = computed<Mine | undefined>(() =>
  viewState.mineId === null ? undefined : state.mines.find((mine) => mine.id === viewState.mineId)
)

/**
 * The mine column is width the WINDOW has to be given before anything can be
 * drawn into it, so opening or closing a mine reshapes the shell. Serialized in
 * usePanelLayout behind whatever the rail is doing, because the two overlap.
 */
watch(
  () => viewState.mineId !== null,
  (mineOpen) => {
    if (!layout.value.expanded) return
    void applyLayout({ expanded: true, mineOpen })
  }
)

function toggleShell(): void {
  void toggleLayout(viewState.mineId !== null)
}

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
    // and nothing worth guessing: the settings panel stays as it was.
  }
}

function enterMine(mineId: string): void {
  openMine(mineId)
  error.value = null
}

function leaveMine(): void {
  closeMine()
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
  // Adopts the window's REAL shape: which edge it is docked to decides which
  // way the rail's arrow points, and the renderer never chose it.
  void syncLayout()
  // The button's initial "pinned" guess matches main's default; this adopts
  // the real BrowserWindow state (the user may have unpinned on a past run).
  void syncPinned()
  // Reads the accelerator AND whether it actually registered, so a startup
  // failure can be flagged on the Settings button before anyone opens it.
  void syncShortcut()
  void loadBuild()
  unsubscribe = window.api.onMinesUpdated(update)
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="shell" :class="[`edge-${layout.edge}`, layout.expanded ? 'is-open' : 'is-closed']">
    <!--
      The rail and the collapse arrow are one control in one component, because
      they are one surface in the design: the same #f6b644, with the arrow
      turned round.
    -->
    <EdgeRail :edge="layout.edge" :expanded="layout.expanded" @toggle="toggleShell" />

    <template v-if="layout.expanded">
      <div class="shell-secondary">
        <!--
          The map container from the design: 21px padding on every side, a 2px
          #fae2b6 border and elevation 5, with the collected-materials totals
          overlaid in its upper-right corner (VaultChip, inside MapView).
        -->
        <PanelFrame v-if="viewState.area === 'map'" variant="map">
          <div v-if="loading" class="loading" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <p>Scanning the hills for active agents...</p>
          </div>
          <MapView
            v-else
            :mines="state.mines"
            :tokens-observed="state.tokensObserved"
            :materials="state.materials"
            @open="enterMine"
          />
        </PanelFrame>

        <PanelFrame v-else-if="viewState.area === 'mines'">
          <MinesPanel
            :projects="projects"
            :mines="state.mines"
            :search="browseFilters.search"
            :tier="browseFilters.tier"
            :direction="browseFilters.direction"
            :loading="browseLoading"
            :error="browseError"
            :exhausted="browseExhausted"
            :adding="addingProject"
            :add-error="addProjectError"
            @search="setProjectSearch"
            @tier="setProjectTier"
            @toggle-direction="toggleProjectOrder"
            @load-more="loadMoreProjects"
            @add="addProject"
            @open="openFromBrowse"
          />
        </PanelFrame>

        <!--
          Settings keeps the existing shortcut section inside the design's heavy
          frame; the screen's own rebuild is a later slice. The pin and the
          running version live here because the titlebar that carried them is
          gone and the design gives neither a home of its own — a preference and
          a build number belong with the other preferences rather than as
          furniture on a 20px rail.
        -->
        <PanelFrame v-else-if="viewState.area === 'settings'" variant="settings">
          <div class="settings-area">
            <ShortcutSettings
              :state="shortcutState"
              :error="shortcutError"
              :recording="shortcutRecording"
              :applying="shortcutApplying"
              @start-recording="startShortcutRecording"
              @stop-recording="stopShortcutRecording"
              @record="recordShortcut"
              @reset="resetShortcut"
              @close="showMap"
            />
            <div class="shell-preferences">
              <button
                class="pin"
                type="button"
                aria-label="Keep panel on top"
                :aria-pressed="pinned ? 'true' : 'false'"
                :title="pinTooltip"
                @click="togglePinned"
              >
                Always on top
              </button>
              <!--
                The titlebar's close button was the renderer's ONLY caller of
                hidePanel, and the design has no window-close control: the
                panel's way out of the user's way is collapsing to the rail.
                Keeping it here relocates the capability rather than dropping
                it — hiding also stays on the tray and the global shortcut.
              -->
              <button
                class="hide-panel"
                type="button"
                title="Hide the panel; the shortcut or the tray brings it back"
                @click="hidePanel"
              >
                Hide panel
              </button>
              <span v-if="versionText" class="version" :title="versionHint">{{ versionText }}</span>
            </div>
          </div>
        </PanelFrame>

        <PanelFrame v-else variant="settings">
          <UnavailablePanel :feature="viewState.area === 'lab' ? 'lab' : 'market'" />
        </PanelFrame>

        <p v-if="error" class="notice" role="alert">{{ error }}</p>
      </div>

      <ShellNav :area="viewState.area" :broken="shortcutBroken" @select="selectArea" />

      <!--
        One mine beside one secondary panel: the concurrent model the design's
        exports prove, and no more than that — the source warns in as many words
        against assuming arbitrary multi-panel stacking.
      -->
      <div v-if="currentMine" class="shell-mine">
        <PanelFrame>
          <MineScene
            :mine="currentMine"
            :activating-id="activating"
            :send-states="messagingState.byDwarfId"
            :kick-states="kickingState.byDwarfId"
            :answer-states="questionState.byDwarfId"
            @back="leaveMine"
            @activate="activate"
            @send-text="sendText"
            @kick="kickDwarf"
            @answer-question="answerQuestion"
          />
        </PanelFrame>
        <button class="close-mine" type="button" aria-label="Close mine" @click="leaveMine">
          <span
            class="close-glyph"
            :style="{ '--close-icon': `url(${CLOSE_ICON_SRC})` }"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    </template>

    <FeedModal v-if="feedFor" :title="feedFor" :messages="feed" @close="closeFeed" />
  </div>
</template>

<style scoped>
/*
 * The shell is the whole window: a docked strip whose columns run from its free
 * edge to the screen edge it hangs on. A left-docked panel is the same DOM in
 * the other direction, which is what `row-reverse` buys — one order to reason
 * about, mirrored once.
 */
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.shell.edge-left {
  flex-direction: row-reverse;
}
.shell.is-open {
  gap: var(--space-nav-gap);
  padding: var(--space-nav-gap);
  border-radius: var(--radius-default);
  background: var(--color-rail);
  box-shadow: var(--elevation-5);
}
.shell-secondary {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.shell-secondary > * {
  flex: 1;
  min-height: 0;
}
/* The mine's own column, outboard of the navigation stack (see the exports). */
/*
 * The design's 245px mine interior, plus the 32px of chrome MineScene still
 * wraps around the cave (its padding and header row) — the interior's own
 * rebuild is a later slice, and until it lands the cave needs that much more
 * column to be drawn at the width the design gives it. main reserves the same
 * width in the window; see MINE_COLUMN_WIDTH in main/shell/panelBounds.ts.
 */
.shell-mine {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: calc(var(--size-mine-interior-width) + 32px);
  min-width: 0;
}
.shell-mine > .panel-frame {
  flex: 1;
  min-height: 0;
}
/*
 * The design's round close, at the mine panel's top-right corner. It closes the
 * MINE, never the window — the panel's own way out is the rail.
 */
.close-mine {
  position: absolute;
  z-index: 6;
  top: var(--space-settings);
  right: var(--space-settings);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.close-glyph {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  background: var(--color-cream);
  mask: var(--close-icon) center / contain no-repeat;
}
.close-mine:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.settings-area {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  overflow: auto;
}
.shell-preferences {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-settings);
  padding: var(--space-settings);
}
.pin,
.hide-panel {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  cursor: pointer;
}
.pin[aria-pressed='false'] {
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
.pin:focus-visible,
.hide-panel:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/* Quiet by construction: a monitor, not a control. */
.version {
  color: var(--color-accent);
}
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-settings);
  color: var(--color-tooltip-text);
}
.loading p {
  margin: 0;
}
.spinner {
  width: 25px;
  height: 25px;
  border: 3px solid var(--color-control);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.notice {
  position: absolute;
  z-index: 90;
  right: var(--space-modal-margin);
  bottom: var(--space-modal-margin);
  left: var(--space-modal-margin);
  flex: none;
  margin: 0;
  padding: 9px var(--space-settings);
  border-left: 3px solid var(--danger-line);
  border-radius: var(--radius-default);
  color: var(--danger-ink);
  background: var(--danger-bg);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
