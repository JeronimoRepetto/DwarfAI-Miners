<script setup lang="ts">
/*
 * The Panel's nav (#635), `organisms/nav` in the design: docked at the screen edge, the app mark
 * at the top, the World group, the Guild group only once the guild flag reveals it, a spacer, and
 * the System group with the mode lever at the bottom. Opening or closing a mine never touches it,
 * so the eye never loses it.
 *
 * Thin by construction: it draws the page it is given and asks for the one pressed. The view is
 * `useView`'s, the window is main's, playback is the audio engine's; what the groups hold and how
 * many need you is lib/shell/panelNav's.
 *
 * One root element on purpose: the shell's fold names this element as its strip, the wall a mine
 * column slides out from behind, and measures its box (`useShellFold`). A fragment would answer no
 * element and the fold would lose it.
 */
import NavSlot from './NavSlot.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import { GUILD_SLOTS, SYSTEM_SLOTS, WORLD_SLOTS } from '../../lib/shell/panelNav'
import type { ShellArea } from '../../types'

withDefaults(
  defineProps<{
    /** The page shown, which carries aria-current. */
    page: ShellArea
    /** Whether the guild areas are shown; while off the group is not drawn at all. */
    guild?: boolean
    /** How many dwarfs need you, on the Mines slot. */
    badge?: number
    /** Whether the music is playing: the verdict, never the wish. */
    music?: boolean
    /** Whether the panel shortcut failed to register, flagged on Settings. */
    warn?: boolean
    /** The app mark and the mode lever, left out for a host that carries its own. */
    mark?: boolean
    lever?: boolean
    /** The landmark's name. */
    label?: string
  }>(),
  { guild: false, badge: 0, music: false, warn: false, mark: true, lever: true, label: 'Panel' }
)

const emit = defineEmits<{
  /** A page slot was pressed. */
  nav: [area: ShellArea]
  /** The music toggle was pressed. */
  music: []
  /** A side of the mode lever was pressed. */
  mode: [mode: 'valle' | 'veta']
  /** The app mark was pressed: hide the window, as the global shortcut does. */
  mark: []
}>()
</script>

<template>
  <nav class="dm-nav m-mat" :aria-label="label">
    <button
      v-if="mark"
      class="dm-nav__mark"
      type="button"
      title="Hide the panel"
      aria-label="Hide the panel"
      @click="emit('mark')"
    >
      <PixelIcon name="mark" :scale="2" />
    </button>
    <div class="dm-nav__group" role="group" aria-label="World">
      <NavSlot
        v-for="slot in WORLD_SLOTS"
        :key="slot.id"
        :icon="slot.icon"
        :label="slot.label"
        :data-slot="slot.id"
        :current="slot.area === page"
        :badge="slot.area === 'mines' ? badge : 0"
        @click="emit('nav', slot.area)"
      />
    </div>
    <div v-if="guild" class="dm-nav__group" role="group" aria-label="Guild">
      <span class="dm-nav__rule"></span>
      <NavSlot
        v-for="slot in GUILD_SLOTS"
        :key="slot.id"
        :icon="slot.icon"
        :label="slot.label"
        :data-slot="slot.id"
        :current="slot.area === page"
        @click="emit('nav', slot.area)"
      />
    </div>
    <span class="dm-nav__spacer"></span>
    <div class="dm-nav__group" role="group" aria-label="System">
      <NavSlot
        v-for="slot in SYSTEM_SLOTS"
        :key="slot.id"
        :icon="slot.icon"
        :label="slot.label"
        :data-slot="slot.id"
        :current="slot.area === page"
        :warn="slot.area === 'settings' && warn"
        @click="emit('nav', slot.area)"
      />
      <NavSlot
        :icon="music ? 'music-on' : 'music-off'"
        label="Music"
        :pressed="music"
        @click="emit('music')"
      />
      <div v-if="lever" class="dm-nav__lever" role="group" aria-label="Mode">
        <NavSlot icon="valle" label="▲ Valle" @click="emit('mode', 'valle')" />
        <span class="dm-nav__lever-label">MODE</span>
        <NavSlot icon="veta" label="▼ Veta" @click="emit('mode', 'veta')" />
      </div>
    </div>
  </nav>
</template>

<style scoped>
/* The design's nav.css, rule for rule and in its order. */
.dm-nav {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--rock-lo);
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  width: 56px;
  height: 100%;
  gap: 10px;
  padding: 8px 0 10px;
}
.dm-nav__group {
  display: grid;
  justify-items: center;
  gap: 6px;
}
.dm-nav__spacer {
  flex: 1;
}
.dm-nav__rule {
  width: 28px;
  height: 2px;
  background: var(--rock-lo);
  box-shadow: 0 2px 0 0 var(--wood);
}
/* The app mark: a rock plate with a notched brass edge, sunk on its top-left. */
.dm-nav__mark {
  display: grid;
  width: var(--hit-nav);
  height: var(--hit-nav);
  margin: 2px;
  place-items: center;
  background: var(--rock);
  box-shadow:
    0 -2px 0 0 var(--brass-lo),
    0 2px 0 0 var(--brass-lo),
    -2px 0 0 0 var(--brass-lo),
    2px 0 0 0 var(--brass-lo),
    inset 2px 2px 0 0 var(--rock-lo);
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-nav__mark:hover {
  box-shadow:
    0 -2px 0 0 var(--brass),
    0 2px 0 0 var(--brass),
    -2px 0 0 0 var(--brass),
    2px 0 0 0 var(--brass),
    inset 2px 2px 0 0 var(--rock-lo);
}
.dm-nav__mark:active {
  transform: translateY(var(--px));
}
/* The mode lever: a sunk rock well holding its two slots and the MODE label between them. */
.dm-nav__lever {
  display: grid;
  gap: 0;
  padding: 4px;
  background: var(--rock);
  box-shadow:
    inset 2px 2px 0 0 var(--rock-lo),
    inset -2px -2px 0 0 var(--wood);
}
.dm-nav__lever .dm-slot {
  --mat-edge: var(--rock-lo);
}
.dm-nav__lever .dm-slot:hover {
  --mat-edge: var(--brass);
}
.dm-nav__lever-label {
  padding: 2px 0;
  font: 10px / 1 var(--f-ui);
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  text-align: center;
}
</style>
