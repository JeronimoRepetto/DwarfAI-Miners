<script setup lang="ts">
/*
 * The Map page (#635), `organisms/map-page` in the design (W5): the page header, the valley's
 * painting in its well with every mine as a tier marker on its measured site and the "?" marker
 * for a mine that needs you, the ore totals plate in its corner, and the legend plate with the
 * tier and ore explainer. The painting and the sites are untouched: only the frame around them is
 * the redesign's. On a first run the painting dims under the veil and one card offers "Add a
 * mine" (decision log, Empty map; First run: add a mine).
 *
 * The page owns what needs the drawn page: the measured art box, and the one tooltip, which only
 * ever shows for one marker. What it shows is lib/map/mapPage's; the clock is the host's
 * (useMapTime), so the page paints whichever variant it is handed.
 *
 * `mines` is this poll's live board; `projects` every project the app remembers (#197), so the map
 * and the Mines page agree on who is on it (lib/map/mapPopulation.ts).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import PageHeader from '../shell/PageHeader.vue'
import ActionButton from '../controls/ActionButton.vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import TooltipCard from '../overlay/TooltipCard.vue'
import TierInfo from '../browse/TierInfo.vue'
import VaultStrip from '../vault/VaultStrip.vue'
import TierMarker from './TierMarker.vue'
import { MAP_ART_SIZE, MAP_BG_SRC } from '../../lib/art'
import { projectToMapBox } from '../../lib/map/mapProjection'
import { mapMines } from '../../lib/map/mapPopulation'
import { MAP_ADD_LABEL, MAP_EMPTY_SAY, mapMarkers, mapTotals, mineTip } from '../../lib/map/mapPage'
import type { MapTimeVariant } from '../../lib/map/mapTime'
import { TIP_DELAY_MS, placeTip, type TipSide } from '../../lib/overlay/tipCard'
import { designTierLabel } from '../../lib/presentation'
import { MINE_TIERS } from '../../types'
import type { MaterialTotals, Mine, ProjectSummary } from '../../types'

const props = withDefaults(
  defineProps<{
    mines: Mine[]
    projects?: ProjectSummary[]
    /**
     * The WHOLE vault by material, not the sum of the mines on screen: main sums it over the
     * entire persisted ledger, so it holds ore no mine on screen produces (#22).
     */
    materials?: MaterialTotals
    /** The mine open in the mine column, whose marker is pressed. */
    openId: string | null
    /** The painting for the time of day. */
    variant: MapTimeVariant
    /** True while main shows the folder picker or adopts a project (#85). */
    adding?: boolean
    /** True until the first board arrives: a map not read yet is not an empty valley. */
    loading?: boolean
  }>(),
  { projects: () => [], materials: undefined, adding: false, loading: false }
)
const emit = defineEmits<{
  open: [id: string]
  add: []
  /** A press on a marker whose mine cannot be entered, for the shell to say why (PANEL-QUESTIONS 6). */
  refuse: [id: string]
}>()

const population = computed(() => mapMines(props.mines, props.projects))
// The mines whose folder no longer exists: main asks the disk (ProjectSummary.folderMissing).
const unenterable = computed(
  () => new Set(props.projects.filter((p) => p.folderMissing).map((p) => p.id))
)
const empty = computed(() => !props.loading && population.value.length === 0)
const totals = computed(() => mapTotals(props.materials))
const artStyle = computed(() => ({ backgroundImage: `url("${MAP_BG_SRC[props.variant]}")` }))

/*
 * The art box's measured size, for projectToMapBox. The box carries the painting's own aspect, so
 * the projection leaves a site's image percent as it is; zero until measured, which the
 * projection answers with the authored point unchanged, so the first frame is already right.
 */
const artEl = ref<HTMLElement | null>(null)
const box = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined

const markers = computed(() =>
  mapMarkers(population.value, props.openId).map((marker) => {
    const at = projectToMapBox(marker, box.value, MAP_ART_SIZE)
    return { ...marker, style: { '--x': at.x + '%', '--y': at.y + '%' } }
  })
)

const LEGEND = MINE_TIERS.map((tier) => ({ tier, label: designTierLabel(tier) }))
const tierInfoOpen = ref(false)

/*
 * The one tooltip (components.md, Tooltip card): 300ms after the pointer arrives, at once on
 * keyboard focus, gone on leave, blur, press or Esc. Held by mine id, so a poll replacing the
 * board keeps it describing the same mine with fresh numbers instead of vanishing under the
 * pointer. A press dismisses it until the pointer leaves: nothing re-arms it before then, neither
 * the pointer resting on nor the window handing the pressed marker its focus back (which brought
 * it back a second after a click, #654). A mouse press takes no focus at all (`@mousedown.prevent`),
 * so the keyboard's ring shows only for the keyboard; Tab still focuses and shows the card.
 */
const tipId = ref<string | null>(null)
const tipCard = ref<InstanceType<typeof TooltipCard> | null>(null)
const tipPlace = ref<{ left: number; top: number; side: TipSide }>({ left: 0, top: 0, side: 'top' })
let tipTarget: HTMLElement | null = null
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let dismissed = false

const tipMine = computed(() => population.value.find((mine) => mine.id === tipId.value))
const tip = computed(() =>
  tipMine.value === undefined
    ? undefined
    : mineTip(tipMine.value, { notEnterable: unenterable.value.has(tipMine.value.id) })
)
const tipStyle = computed(() => ({
  left: tipPlace.value.left + 'px',
  top: tipPlace.value.top + 'px',
  // It rises 6px into place above its target, and drops 6px into place below it.
  '--tip-rise': tipPlace.value.side === 'bottom' ? '-6px' : '6px'
}))

function clearHover(): void {
  if (hoverTimer !== null) clearTimeout(hoverTimer)
  hoverTimer = null
}

async function showTip(id: string, target: HTMLElement): Promise<void> {
  clearHover()
  tipTarget = target
  tipId.value = id
  await nextTick()
  const card = tipCard.value?.$el as HTMLElement | undefined
  if (!card || tipTarget !== target) return
  tipPlace.value = placeTip(
    target.getBoundingClientRect(),
    { width: card.offsetWidth, height: card.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  )
}

function hideTip(): void {
  clearHover()
  tipTarget = null
  tipId.value = null
}

function hover(id: string, event: PointerEvent): void {
  if (dismissed) return
  const target = event.currentTarget as HTMLElement
  clearHover()
  hoverTimer = setTimeout(() => void showTip(id, target), TIP_DELAY_MS)
}

function focus(id: string, event: FocusEvent): void {
  if (!dismissed) void showTip(id, event.currentTarget as HTMLElement)
}

// Only the pointer leaving re-arms a card a press dismissed.
function leave(): void {
  dismissed = false
  hideTip()
}

function press(): void {
  dismissed = true
  hideTip()
}

function open(id: string): void {
  hideTip()
  if (unenterable.value.has(id)) emit('refuse', id)
  else emit('open', id)
}

function escape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && tipId.value !== null) hideTip()
}

onMounted(() => {
  window.addEventListener('keydown', escape)
  const element = artEl.value
  if (!element || typeof ResizeObserver !== 'function') return
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    // A zero rect means "not laid out yet", never an empty map: keep the last good size.
    if (rect.width > 0 && rect.height > 0) box.value = { width: rect.width, height: rect.height }
  }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(element)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', escape)
  observer?.disconnect()
  clearHover()
})
</script>

<template>
  <section class="dm-mappage" aria-label="Map">
    <PageHeader title="Map" />
    <div class="dm-mappage__well">
      <div
        ref="artEl"
        class="dm-mappage__art"
        :class="{ 'is-empty': empty }"
        role="group"
        aria-label="Valley map"
        :data-variant="variant"
        :style="artStyle"
      >
        <TierMarker
          v-for="marker in markers"
          :key="marker.id"
          :tier="marker.tier"
          :asking="marker.asking"
          :label="marker.label"
          :selected="marker.selected"
          :style="marker.style"
          @pointerenter="hover(marker.id, $event)"
          @pointerleave="leave"
          @pointerdown="press"
          @mousedown.prevent
          @focus="focus(marker.id, $event)"
          @blur="hideTip"
          @click="open(marker.id)"
        />
      </div>
      <div class="dm-mappage__totals">
        <VaultStrip :ore="totals" label="Ore" plate />
      </div>
      <div v-if="empty" class="dm-mappage__empty">
        <div class="dm-mappage__card m-mat m-wood m-raised" role="status">
          <p class="dm-mappage__say">{{ MAP_EMPTY_SAY }}</p>
          <ActionButton
            :label="MAP_ADD_LABEL"
            variant="primary"
            size="lg"
            :disabled="adding"
            @click="emit('add')"
          />
        </div>
      </div>
    </div>
    <footer class="dm-mappage__legend m-mat" aria-label="Legend">
      <span v-for="key in LEGEND" :key="key.tier" class="dm-mappage__key" :data-tier="key.tier"
        ><span class="dm-hex"></span>{{ key.label }}</span
      >
      <span class="dm-mappage__key"><span class="dm-pill__q">?</span>needs you</span>
      <ActionButton icon="info" size="sm" title="Tiers and ore" @click="tierInfoOpen = true" />
    </footer>

    <ModalDialog
      :open="tierInfoOpen"
      title="Tiers and ore"
      wide
      :actions="[{ label: 'Close' }]"
      @action="tierInfoOpen = false"
      @cancel="tierInfoOpen = false"
    >
      <TierInfo />
    </ModalDialog>
    <!-- In <body>: the well is a size container, which would otherwise hold a fixed card. -->
    <Teleport to="body">
      <Transition name="dm-tip-pop">
        <TooltipCard
          v-if="tip"
          ref="tipCard"
          :tier="tip.tier"
          :title="tip.title"
          :rows="tip.rows"
          :style="tipStyle"
        />
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
/* The design's map-page.css, rule for rule. */
.dm-mappage {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
  gap: 4px;
}
.dm-mappage__well {
  display: grid;
  min-height: 0;
  position: relative;
  margin: 2px;
  background: var(--rock-lo);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo);
  place-items: center;
  overflow: hidden;
  container-type: size;
}
.dm-mappage__art {
  width: min(100cqw, 100cqh * 0.805556);
  aspect-ratio: 1856 / 2304;
  position: relative;
  background-size: 100% 100%;
}
.dm-mappage__art .dm-marker {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 1;
}
.dm-mappage__art .dm-marker--ask {
  z-index: 2;
}
.dm-mappage__totals {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
}
.dm-mappage__art.is-empty::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--veil);
}
.dm-mappage__empty {
  display: grid;
  position: absolute;
  inset: 0;
  padding: 16px;
  z-index: 4;
  place-items: center;
  pointer-events: none;
}
.dm-mappage__card {
  display: grid;
  max-width: 320px;
  gap: 12px;
  padding: 16px;
  justify-items: center;
  text-align: center;
  pointer-events: auto;
}
.dm-mappage__say {
  font: var(--fs-body) / 1.35 var(--f-meta);
  color: var(--ink);
}
.dm-mappage__legend {
  --mat-fill: var(--wood);
  display: flex;
  gap: 2px 10px;
  padding: 6px 6px 6px 10px;
  margin: 2px;
  align-items: center;
  flex-wrap: wrap;
}
.dm-mappage__key {
  display: inline-flex;
  gap: 6px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  align-items: center;
}
.dm-mappage__key .dm-hex {
  width: 12px;
  height: 10px;
  background: var(--tier-c);
  clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%);
}
.dm-mappage__legend .dm-btn {
  margin-left: auto;
}
/* The chip's tier map (controls/chip.css), repeated because each component's rules are scoped. */
[data-tier='bronze'] {
  --tier-c: var(--tier-bronze);
}
[data-tier='copper'] {
  --tier-c: var(--tier-copper);
}
[data-tier='silver'] {
  --tier-c: var(--tier-silver);
}
[data-tier='gold'] {
  --tier-c: var(--tier-gold);
}
[data-tier='uranium'] {
  --tier-c: var(--tier-uranium);
}
/* The tooltip's entry and exit (motion.md, Overlays): transform and opacity only. */
.dm-tip-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-tip-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.dm-tip-pop-enter-from {
  opacity: 0;
  transform: translateY(var(--tip-rise));
}
.dm-tip-pop-leave-to {
  opacity: 0;
}
</style>

<!-- The legend's "?" plate is the pill's (atoms/badge), scoped here as the pill scopes it. -->
<style scoped src="../dwarf/badge.css"></style>
