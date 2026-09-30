<script setup lang="ts">
/*
 * The mine column (#635), `organisms/mine-column` in the design: one open mine. Its toolbar plate
 * carries the tier, the name, the ambience toggle, History and Close; the art, clean, carries
 * nothing but the dwarfs on their stations; the crew roster sits under it; and the footer plate
 * holds the ore strip and + Dwarf, the column's one primary button (screens/mine.md, W1·5–8).
 * Replaces MineScene inside PanelFrame.
 *
 * It decides nothing that belongs above it: pressing a dwarf or its portrait reports the dwarf
 * (App selects it and opens its chat), and Close, History, + Dwarf and the ambience report the
 * press. The ambience state it paints is the audio engine's verdict, never the wish (#173). Who
 * stands where is lib/scene/mineColumn's.
 *
 * Its width is the design's rule, bound from the constants main reserves the column with
 * (sceneSizing, panelBounds): the painting drawn whole at the shell's height less the chrome, plus
 * 16px, never under 300px. The shell height arrives as --shell-h from the dock around it.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import TierChip from '../controls/TierChip.vue'
import VaultStrip from '../vault/VaultStrip.vue'
import CrewRoster from './CrewRoster.vue'
import SceneDwarf from './SceneDwarf.vue'
import { INTERIOR_ART_SIZE, INTERIOR_SRC } from '../../lib/art'
import type { CrewSoundEvent } from '../../lib/audio/crew'
import { mapTotals } from '../../lib/map/mapPage'
import {
  ADD_DWARF_LABEL,
  MINE_FOOTER_ORE_MAX,
  interiorLabel,
  mineColumnLabel,
  mineCrew,
  mineStands,
  type Station
} from '../../lib/scene/mineColumn'
import {
  MINE_COLUMN_ART_INSET,
  MINE_COLUMN_CHROME_HEIGHT,
  MINE_COLUMN_MIN_WIDTH
} from '../../lib/scene/sceneSizing'
import type { CrewSoundSignal } from '../../lib/sprite/crewSound'
import { INTERIOR_ROUTE, routeBetween } from '../../lib/scene/interiorRoute'
import { nearestSpawn, sceneLayout, type ScenePoint } from '../../lib/scene/sceneLayout'
import {
  createWalkBoard,
  prefersReducedMotion,
  watchReducedMotion,
  type WalkState
} from '../../lib/scene/sceneMotion'
import type { Dwarf, DwarfKickState, DwarfSendState, Mine } from '../../types'

const props = withDefaults(
  defineProps<{
    mine: Mine
    /** The dwarf whose chat is open, or null: at most one in the whole app (#159). */
    selectedId?: string | null
    /** Delivery verdicts per dwarf id, so each dwarf wears its own mark. */
    sendStates?: Record<string, DwarfSendState>
    kickStates?: Record<string, DwarfKickState>
    /** The dwarfs that were not on the previous snapshot (#156): they fade in. */
    arrived?: ReadonlySet<string>
    /** Whether the mine ambience is muted: the audio engine's verdict. */
    ambienceMuted?: boolean
    /** A station per dwarf where the caller names one; the scene assigns the rest. */
    stations?: Readonly<Record<string, Station>>
  }>(),
  {
    selectedId: null,
    sendStates: () => ({}),
    kickStates: () => ({}),
    arrived: () => new Set<string>(),
    ambienceMuted: false,
    stations: () => ({})
  }
)

const emit = defineEmits<{
  close: []
  history: []
  add: []
  select: [dwarf: Dwarf]
  'toggle-ambience-mute': []
  'crew-sound': [event: CrewSoundEvent]
}>()

const crew = computed(() => mineCrew(props.mine))
const stands = computed(() => mineStands(crew.value, props.mine.tier, props.stations))

/*
 * Today's walk (PANEL-QUESTIONS 14): the crew already at work when the column opens is placed, and
 * a dwarf that turns up later, or one the panel saw arrive (#156), walks in from the nearest
 * spawn point along the painted corridors at today's pace; a leaver walks out to its spawn point.
 * The board plans only when a target moves, so a poll does not re-plan the crew. A viewer who asked
 * for less movement gets every dwarf placed, read before the first paint (#71), and watched after
 * it: asking mid-walk drops the board, so every walk under way snaps to its station and its
 * footsteps end; letting motion back starts a fresh board that places the crew standing there, so
 * only a later arrival walks.
 */
const reducedMotion = ref(prefersReducedMotion())
const walks = ref<ReadonlyMap<string, WalkState>>(new Map())
const newBoard = () =>
  createWalkBoard((state) => {
    walks.value = state
  })
let board = newBoard()
function syncBoard(): void {
  if (reducedMotion.value) return
  const targets = new Map<string, ScenePoint>(
    stands.value.map((s) => [s.dwarf.id, { x: s.x, y: s.y }])
  )
  const layout = sceneLayout(props.mine.tier)
  board.sync(
    targets,
    (from, to) => routeBetween(INTERIOR_ROUTE, from, to),
    (target) => nearestSpawn(layout, target),
    props.arrived
  )
}
watch(stands, syncBoard, { immediate: true })
const stopWatchingMotion = watchReducedMotion((reduced) => {
  if (reduced === reducedMotion.value) return
  reducedMotion.value = reduced
  board.dispose()
  walks.value = new Map()
  if (reduced) return
  board = newBoard()
  syncBoard()
})
onBeforeUnmount(() => {
  stopWatchingMotion()
  board.dispose()
})

/** Each dwarf where the walk has it now: its current leg's end, facing the way it goes. */
const placed = computed(() =>
  stands.value.map((stand) => {
    const walk = walks.value.get(stand.dwarf.id)
    const walking = walk?.walking === true
    return {
      ...stand,
      x: walk?.point.x ?? stand.x,
      y: walk?.point.y ?? stand.y,
      facesLeft: walking ? walk.facesLeft : stand.facesLeft,
      walking,
      walkMs: walking ? walk.legMs : 0
    }
  })
)
const ore = computed(() => mapTotals(props.mine.materials))

const columnStyle = {
  '--chrome-h': MINE_COLUMN_CHROME_HEIGHT + 'px',
  '--minecol-min': MINE_COLUMN_MIN_WIDTH + 'px',
  '--minecol-inset': MINE_COLUMN_ART_INSET + 'px',
  '--interior-aspect': `${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`,
  '--interior-ratio': String(INTERIOR_ART_SIZE.width / INTERIOR_ART_SIZE.height)
}
const artStyle = computed(() => ({ backgroundImage: `url("${INTERIOR_SRC[props.mine.tier]}")` }))

/*
 * One of the crew made a sound (#330), forwarded with the two facts a dwarf cannot know about
 * itself: which mine it stands in, and which dwarf it is. The column addresses the cue and reads
 * none of it.
 */
function crewSound(dwarf: Dwarf, signal: CrewSoundSignal): void {
  emit('crew-sound', { ...signal, mineId: props.mine.id, dwarfId: dwarf.id, role: dwarf.role })
}
</script>

<template>
  <section
    class="dm-minecol"
    :aria-label="mineColumnLabel(mine.name)"
    :data-mine="mine.id"
    :data-ambience="ambienceMuted ? 'off' : 'on'"
    :style="columnStyle"
  >
    <header class="dm-minecol__bar m-mat">
      <TierChip :tier="mine.tier" />
      <h2 class="dm-minecol__name" :title="mine.name">{{ mine.name }}</h2>
      <ActionButton
        :icon="ambienceMuted ? 'ambience-off' : 'ambience-on'"
        size="sm"
        title="Mine ambience"
        :pressed="!ambienceMuted"
        @click="emit('toggle-ambience-mute')"
      />
      <ActionButton icon="history" size="sm" title="Mine history" @click="emit('history')" />
      <ActionButton icon="close" size="sm" title="Close mine" @click="emit('close')" />
    </header>
    <div class="dm-minecol__well">
      <div
        class="dm-minecol__art"
        :class="{ 'is-still': reducedMotion }"
        role="img"
        :aria-label="interiorLabel(mine.name)"
        :style="artStyle"
      >
        <SceneDwarf
          v-for="stand in placed"
          :key="stand.dwarf.id"
          :dwarf="stand.dwarf"
          :x="stand.x"
          :y="stand.y"
          :faces-left="stand.facesLeft"
          :walking="stand.walking"
          :walk-ms="stand.walkMs"
          :selected="stand.dwarf.id === selectedId"
          :entering="arrived.has(stand.dwarf.id)"
          :send-state="sendStates[stand.dwarf.id]"
          :kick-state="kickStates[stand.dwarf.id]"
          @select="emit('select', stand.dwarf)"
          @crew-sound="crewSound(stand.dwarf, $event)"
        />
      </div>
    </div>
    <div class="dm-minecol__roster m-mat">
      <CrewRoster :dwarfs="crew" :selected-id="selectedId" @pick="emit('select', $event)" />
    </div>
    <footer class="dm-minecol__foot m-mat">
      <VaultStrip :ore="ore" label="Ore" :max="MINE_FOOTER_ORE_MAX" />
      <ActionButton
        :label="ADD_DWARF_LABEL"
        variant="primary"
        size="lg"
        block
        @click="emit('add')"
      />
    </footer>
  </section>
</template>

<style scoped>
/* The design's mine-column.css, rule for rule, its numbers bound from sceneSizing. */
.dm-minecol {
  --art-h: calc(var(--shell-h, 760px) - var(--chrome-h));
  --art-w: calc(var(--art-h) * var(--interior-ratio));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  width: max(var(--minecol-min), calc(var(--art-w) + var(--minecol-inset)));
  height: 100%;
  min-height: 0;
  gap: 4px;
}
.dm-minecol__bar {
  --mat-fill: var(--wood);
  display: flex;
  min-width: 0;
  gap: 2px;
  padding: 4px 4px 4px 6px;
  margin: 2px;
  align-items: center;
}
.dm-minecol__name {
  flex: 1;
  min-width: 0;
  font: var(--fs-section) / 1.1 var(--f-label);
  color: var(--parchment);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-minecol__well {
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
}
.dm-minecol__art {
  /* A size container, so a walking dwarf's offset is a percent of the art (SceneDwarf). */
  container-type: size;
  height: 100%;
  aspect-ratio: var(--interior-aspect);
  position: relative;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.dm-minecol__roster {
  --mat-fill: var(--wood-lo);
  margin: 2px;
}
.dm-minecol__foot {
  --mat-fill: var(--wood);
  display: grid;
  gap: 4px;
  padding: 6px;
  margin: 2px;
}
</style>
