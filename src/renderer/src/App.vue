<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EdgeRail from './components/shell/EdgeRail.vue'
import FeedModal from './components/panel/FeedModal.vue'
import MapView from './components/map/MapView.vue'
import MineScene from './components/scene/MineScene.vue'
import MinesPanel from './components/browse/MinesPanel.vue'
import PanelFrame from './components/shell/PanelFrame.vue'
import SettingsPanel from './components/panel/SettingsPanel.vue'
import ShellNav from './components/shell/ShellNav.vue'
import UnavailablePanel from './components/shell/UnavailablePanel.vue'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import { usePanelLayout } from './composables/usePanelLayout'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useProjectBrowse } from './composables/useProjectBrowse'
import { useResetMetrics } from './composables/useResetMetrics'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { useView } from './composables/useView'
import { INTERIOR_ART_SIZE } from './lib/art'
import { shellComposition } from './lib/shell/composition'
import { versionLabel, versionTitle } from './lib/appBuild'
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
const {
  layout,
  applying: layoutApplying,
  sync: syncLayout,
  apply: applyLayout,
  toggle: toggleLayout,
  setEdge
} = usePanelLayout()

/**
 * Which of the book's three compositions is on screen (#156).
 *
 * Named once, here, and handed to everything that has to know — the shell's own
 * ground and padding, and the rail. Read from `expanded` alone, the mine-only
 * composition was indistinguishable from the collapsed rail, which is what left
 * a void between the navigation column and the mine, took the amber frame with
 * it, grew the interior into padding that was no longer reserved, and put a
 * second app mark in the gap. See lib/shell/composition.ts.
 */
const composition = computed(() => shellComposition(layout.value))

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
 * Settings' "Reset metrics" action (#138). Same reasoning as the shortcut
 * surface above: App owns the composable and therefore the IPC, so
 * SettingsPanel's reset modal stays presentational and the "render only what
 * main verified" rule stays in exactly one place.
 */
const {
  resetting: metricsResetting,
  error: metricsResetError,
  reset: resetMetrics
} = useResetMetrics()

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

/**
 * The interior painting's own shape, published to CSS so the mine column can
 * derive its width from the height the shell gives it (#153). Bound from
 * `INTERIOR_ART_SIZE` rather than written into the stylesheet, so the column and
 * the projection inside it cannot disagree about the painting.
 */
const interiorColumnAspect = `${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`

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
 *
 * The secondary panel is left exactly as it is (#153): the two columns are
 * independent now, so a mine opening beside a closed secondary must not reopen
 * it, and a mine closing while the secondary is closed leaves the rail.
 */
watch(
  () => viewState.mineId !== null,
  (mineOpen) => {
    // Collapsed into the rail: nothing is drawn, and a mine opened behind it
    // must not pop the window back out.
    if (!layout.value.expanded && !layout.value.mineOpen) return
    void applyLayout({ expanded: layout.value.expanded, mineOpen })
  }
)

/**
 * The rail's arrow (#153): it closes the SECONDARY panel and leaves a mine held
 * open beside it standing — the design's own mine mock is exactly that state.
 * With no mine open there is nothing left to show, so it lands on the rail.
 */
function toggleSecondary(): void {
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
  <div
    class="shell"
    :class="[`edge-${layout.edge}`, `is-${composition}`]"
    :style="{ '--interior-column-aspect': interiorColumnAspect }"
  >
    <!--
      The rail and the collapse arrow are one control in one component, because
      they are one surface in the design: the same #f6b644, with the arrow
      turned round.
    -->
    <EdgeRail :edge="layout.edge" :composition="composition" @toggle="toggleSecondary" />

    <template v-if="layout.expanded || layout.mineOpen">
      <div v-if="layout.expanded" class="shell-secondary">
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
          Settings, rebuilt to the design's own screen (#138): the heavy 4px
          frame is PanelFrame's 'settings' variant, and SettingsPanel draws
          everything specific to the screen — its title/divider, the
          shortcut/position/Data-Base sections, and the Application section
          #142 had nowhere else to put pin/hide/version.
        -->
        <PanelFrame v-else-if="viewState.area === 'settings'" variant="settings">
          <SettingsPanel
            :shortcut-state="shortcutState"
            :shortcut-error="shortcutError"
            :shortcut-recording="shortcutRecording"
            :shortcut-applying="shortcutApplying"
            :edge="layout.edge"
            :edge-applying="layoutApplying"
            :pinned="pinned"
            :pin-tooltip="pinTooltip"
            :version-text="versionText"
            :version-hint="versionHint"
            :resetting="metricsResetting"
            :reset-error="metricsResetError"
            @start-recording="startShortcutRecording"
            @stop-recording="stopShortcutRecording"
            @record="recordShortcut"
            @reset-shortcut="resetShortcut"
            @close="showMap"
            @select-edge="setEdge"
            @toggle-pin="togglePinned"
            @hide-panel="hidePanel"
            @reset-confirm="resetMetrics"
          />
        </PanelFrame>

        <PanelFrame v-else variant="settings">
          <UnavailablePanel :feature="viewState.area === 'lab' ? 'lab' : 'market'" />
        </PanelFrame>

        <p v-if="error" class="notice" role="alert">{{ error }}</p>
      </div>

      <!--
        The app mark hides the WINDOW (#156), which is the same hidePanel the
        global shortcut and Settings' own hide control already ask for. The
        layout is deliberately untouched: the panel that comes back is the one
        that went away, mine and page and all.
      -->
      <ShellNav
        :area="viewState.area"
        :broken="shortcutBroken"
        @select="selectArea"
        @hide="hidePanel"
      />

      <!--
        One mine beside AT MOST one secondary panel: the concurrent model the
        design's exports prove, and no more than that — the source warns in as
        many words against assuming arbitrary multi-panel stacking. The column
        follows the view's own open mine, as it always has; what main's
        `mineOpen` decides is whether this whole block is drawn, so the app mark
        can collapse the shell without the view forgetting its mine (#153).
      -->
      <div v-if="currentMine" class="shell-mine">
        <PanelFrame>
          <!--
            Keyed by the mine, so switching from one to another is a fresh
            scene rather than the same one handed different dwarfs (#153). The
            walk board tells an arrival from the opening crew by which snapshot
            it first saw them, and a reused board would parade a whole new
            crew across the interior every time the user changed mine.
          -->
          <MineScene
            :key="currentMine.id"
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
/*
 * The closed window is the platform's 32px floor rather than the design's 20px
 * rail, because Windows will not make one narrower (#153, MIN_WINDOW_WIDTH in
 * main/shell/panelBounds.ts). The rail itself is still 20px, held against the
 * DOCKED side so both edges look the same: `flex-end` is the right of a `row`
 * and the left of a `row-reverse`, which is exactly the docked side each time.
 */
.shell.is-rail {
  justify-content: flex-end;
}
/*
 * Both of the book's pages are drawn on the SAME shell (#156): the amber ground,
 * the 8px padding, the radius and the shadow belong to any composition that has
 * something in it, not only to the one with a secondary panel.
 *
 * The padding is load-bearing rather than decoration. main reserves it in the
 * window (SHELL_FRAME_WIDTH in main/shell/panelBounds.ts) and the mine column's
 * width is derived from the height it leaves, so a composition that skipped it
 * left the window 8px wider than the columns it drew — the void the acceptance
 * run photographed — and grew the painting into the difference.
 */
.shell.is-mine,
.shell.is-pages {
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
/*
 * The mine's own column, outboard of the navigation stack (see the exports).
 *
 * Its width is DERIVED, not declared (#153): the painting is drawn at the full
 * height of the shell's content area with its aspect preserved and nothing
 * cropped, so `aspect-ratio` on a full-height column is the whole rule — the
 * browser reads the height the flex row already gave it and answers with the
 * width. The design's 245px is what that returns at the mock's own 768-tall
 * composition; reserving 245 on a 1392-tall display is what made the interior
 * read tiny. main reserves the same number in the window; see mineColumnWidth
 * in main/shell/panelBounds.ts and interiorColumnWidth in lib/scene/sceneSizing.
 */
.shell-mine {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: auto;
  height: 100%;
  aspect-ratio: var(--interior-column-aspect);
  min-width: 0;
}
.shell-mine > .panel-frame {
  flex: 1;
  min-height: 0;
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
