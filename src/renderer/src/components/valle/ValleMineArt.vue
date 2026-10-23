<script setup lang="ts">
/*
 * A Valle zone's painting (an EPIC-20 package gap resolved in development; `DS/docs/components.md` organisms/mine-zone
 * `.dm-vz__art`; ADR-034 Reuse): the mine's own interior for its tier, its crew on their stations, drawn with the
 * Panel's own parts, unchanged: each dwarf is the Panel's `SceneDwarf`, placed on the station the scene assigns it
 * (`lib/scene/mineColumn` `mineStands`), over the interior the Panel's mine column paints (`INTERIOR_SRC`). The zone's
 * header, roster and "+" are the zone's own (ValleControlRoom, ValleWorkFront); the column's toolbar and footer are not
 * drawn here, since the mine zone is the design's Valle form of the mine column.
 *
 * - A dwarf pressed reports it (`dwarf`): the root pins or focuses its chat (S29.03…S29.05). A double-click on a sprite
 *   never dives (S28.05): the zone's well tells a sprite from the painting.
 * - A crew sound is forwarded with the two facts a sprite cannot know about itself, its mine and its dwarf, as the
 *   Panel's column does; the window's one engine plays only the current mine's (US-VALLE-016.AC03).
 * - Its sprites run on a frame clock of its own, held still while none of the zone is in the viewport
 *   (`useValleArtClocks`; NFR-PERF-10, ADR-034 item 5): `data-clock` says which.
 * - The crew walks as the Panel's column walks it, through the same composable (`useCrewWalk`; US-MINE-009): the crew
 *   already there is placed, a later arrival, or one the board saw arrive (`arrived`, #156), walks in from the spawn
 *   point, a leaver walks out, and reduced motion places everyone at once.
 */
import { computed, inject, onBeforeUnmount, onMounted, provide, shallowRef } from 'vue'
import { useCrewWalk } from '../../composables/useCrewWalk'
import { FRAME_CLOCK_KEY } from '../../composables/useFramePlayer'
import { VALLE_ART_CLOCKS, browserArtClock } from '../../composables/useValleArtClocks'
import { INTERIOR_ART_SIZE, INTERIOR_SRC } from '../../lib/art'
import type { CrewSoundEvent } from '../../lib/audio/crew'
import { interiorLabel, mineCrew, mineStands } from '../../lib/scene/mineColumn'
import type { CrewSoundSignal } from '../../lib/sprite/crewSound'
import type { Dwarf, Mine } from '../../types'
import SceneDwarf from '../scene/SceneDwarf.vue'

const props = withDefaults(
  defineProps<{
    mine: Mine
    /** The dwarf whose chat is in focus, or null. */
    selectedId?: string | null
    /** The dwarfs the board saw arrive since it last published (#156): they walk in. */
    arrived?: ReadonlySet<string>
  }>(),
  { selectedId: null, arrived: () => new Set<string>() }
)
const emit = defineEmits<{
  dwarf: [dwarf: Dwarf]
  'crew-sound': [event: CrewSoundEvent]
}>()

const clocks = inject(VALLE_ART_CLOCKS, null)
const clock = clocks?.clock() ?? browserArtClock()
provide(FRAME_CLOCK_KEY, clock)
const runs = shallowRef(true)

const stands = computed(() => mineStands(mineCrew(props.mine), props.mine.tier))
const { placed } = useCrewWalk({
  stands,
  tier: () => props.mine.tier,
  arrived: () => props.arrived
})
const artStyle = computed(() => ({
  backgroundImage: `url("${INTERIOR_SRC[props.mine.tier]}")`,
  '--interior-aspect': `${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`,
  '--interior-ratio': String(INTERIOR_ART_SIZE.width / INTERIOR_ART_SIZE.height)
}))

function pressed(dwarf: Dwarf): void {
  emit('dwarf', dwarf)
}
function crewSound(dwarf: Dwarf, signal: CrewSoundSignal): void {
  emit('crew-sound', { ...signal, mineId: props.mine.id, dwarfId: dwarf.id, role: dwarf.role })
}

const art = shallowRef<HTMLElement | null>(null)
let release: (() => void) | null = null
onMounted(() => {
  if (art.value === null || clocks === null) return
  release = clocks.watch(art.value, clock, (now) => {
    runs.value = now
  })
})
onBeforeUnmount(() => {
  release?.()
  clock.dispose()
})
</script>

<template>
  <div
    ref="art"
    class="dm-vz__art"
    role="img"
    :aria-label="interiorLabel(mine.name)"
    :style="artStyle"
    :data-valle-art="mine.id"
    :data-clock="runs ? 'running' : 'paused'"
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
      :entering="arrived.has(stand.dwarf.id)"
      :selected="stand.dwarf.id === selectedId"
      @select="pressed(stand.dwarf)"
      @crew-sound="crewSound(stand.dwarf, $event)"
    />
  </div>
</template>

<style scoped>
/*
 * `DS` mine-zone.css `.dm-vz__art`: the painting's own box, contained whole whichever side of the well binds (the
 * coordinates rule), and a size container so a dwarf's offsets are a percent of the art (SceneDwarf).
 */
.dm-vz__art {
  position: relative;
  height: min(100cqh, calc(100cqw / var(--interior-ratio)));
  aspect-ratio: var(--interior-aspect);
  container-type: size;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
</style>
