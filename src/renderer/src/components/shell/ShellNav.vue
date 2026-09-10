<script setup lang="ts">
import { computed } from 'vue'
import {
  MUSIC_OFF_ICON_SRC,
  MUSIC_ON_ICON_SRC,
  SHELL_ICON_SRC,
  TRAY_ICON_SRC,
  maskImageValue
} from '../../lib/art'
import { SHELL_NAV, type ShellArea } from '../../lib/shell/shellNav'

/**
 * The shell navigation stack (#90): the app mark at the top of the panel's
 * outer edge, and below it the six areas, vertically centred against the panel.
 *
 * Thin by construction — it renders the area it is given and asks for the one
 * that was pressed. The view itself belongs to `useView`, and whether an area
 * can be reached at all belongs to the shell.
 */
const props = defineProps<{
  area: ShellArea
  /**
   * Whether the global panel shortcut failed to register (#17). Flagged here
   * because the settings button is now the only entry point to the panel that
   * would explain it — and a failure nobody meets until they open settings is
   * a failure nobody looks for.
   */
  broken: boolean
  /**
   * Whether the background music is playing right now (#174).
   *
   * The verdict, never the wish: the engine above owns playback, so a button
   * that painted itself on the click could show music playing when nothing had
   * started — the same rule the pin control holds about the window.
   */
  musicPlaying: boolean
}>()

const emit = defineEmits<{
  select: [area: ShellArea]
  /**
   * The app mark was pressed: hide the whole window (#156).
   *
   * Its own event rather than an area, because it is not one — the design's
   * navigation stack selects between the areas it lists, and the mark above it
   * is not one of them. Decides nothing here for the same reason the rail's
   * arrow does not:
   * the window is main's, and hiding it is main's to do.
   *
   * It collapsed the shell into the rail until the second acceptance run. The
   * arrow already closes the left page and the interior's round close already
   * closes the right one, so that made this a third way to do what those two do
   * between them; the maintainer's ruling is that it takes the WINDOW away,
   * identically to the global shortcut. Nothing about the layout is touched, so
   * whatever was drawn is what comes back.
   */
  hide: []
  /**
   * The music button was pressed (#174): playback should flip for this run.
   *
   * Its own event rather than an area, for the reason `hide` is not one — the
   * navigation stack selects between the areas the design lists and this is not
   * one of them. It
   * decides nothing either: the audio engine belongs to App.vue, which is
   * where every other cross-cutting surface is owned.
   */
  'toggle-music': []
}>()

const musicIcon = computed(() =>
  maskImageValue(props.musicPlaying ? MUSIC_ON_ICON_SRC : MUSIC_OFF_ICON_SRC)
)
</script>

<template>
  <nav class="shell-nav" aria-label="DwarfAI-Miners sections">
    <!--
      The app mark, and the control that takes the window away (#156) — the same
      action the global shortcut takes, which is why it says so in the tooltip:
      it is the one control a user who has forgotten the accelerator can find.
    -->
    <button
      class="nav-mark"
      type="button"
      aria-label="Hide DwarfAI-Miners"
      title="Hide DwarfAI-Miners"
      @click="emit('hide')"
    >
      <img class="nav-mark-art" :src="TRAY_ICON_SRC" alt="" draggable="false" />
    </button>
    <div class="nav-stack">
      <button
        v-for="item in SHELL_NAV"
        :key="item.area"
        class="nav-button"
        :class="{
          'is-selected': item.area === area,
          'is-broken': item.area === 'settings' && broken
        }"
        type="button"
        :aria-label="item.label"
        :aria-pressed="item.area === area ? 'true' : 'false'"
        :title="
          item.area === 'settings' && broken
            ? 'Shortcut unavailable - click to change it'
            : item.label
        "
        @click="emit('select', item.area)"
      >
        <!--
          The glyph is the designer's own SVG, drawn through a mask so idle and
          selected take their colour from the tokens without the committed file
          being rewritten to say `currentColor`.
        -->
        <span
          class="nav-icon"
          :style="{ '--nav-icon': maskImageValue(SHELL_ICON_SRC[item.area]) }"
          aria-hidden="true"
        ></span>
      </button>
    </div>
    <!--
      The music button, at the BOTTOM of the column — which is the bottom of
      the shell, since this column is the only full-height chrome the shell
      has. `margin: auto 0` on the stack above already claims the free space,
      so this simply follows it and lands against the lower edge.

      One accessible name with the state on `aria-pressed`, and the tooltip
      saying what a press would DO: the same split the pin control uses, so a
      screen reader is never told the control changed identity.
    -->
    <button
      class="nav-music"
      type="button"
      aria-label="Background music"
      :aria-pressed="musicPlaying ? 'true' : 'false'"
      :title="musicPlaying ? 'Stop the background music' : 'Play the background music'"
      @click="emit('toggle-music')"
    >
      <span class="music-icon" :style="{ '--music-icon': musicIcon }" aria-hidden="true"></span>
    </button>
  </nav>
</template>

<style scoped>
/*
 * A 19px icon centred in the frame's outer margin, which the verified exports
 * draw at 37-38px. main reserves the same column inside the expanded window's
 * width; see SHELL_CHROME_WIDTH in main/shell/panelBounds.ts.
 */
.shell-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  width: 38px;
  height: 100%;
}
.nav-mark {
  display: block;
  flex: none;
  width: var(--size-icon);
  height: var(--size-icon);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.nav-mark-art {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  user-select: none;
}
.nav-mark:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * The stack is centred against the PANEL, not against what is left below the
 * mark: `margin: auto 0` puts the free space above and below it in equal
 * shares, and the mark stays pinned to the top.
 */
.nav-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-nav-gap);
  margin: auto 0;
}
.nav-button {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.nav-icon {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  background: var(--color-nav-idle);
  mask: var(--nav-icon) center / contain no-repeat;
}
.nav-button.is-selected .nav-icon {
  background: var(--color-cream);
}
/* The one state the source does not define but the shortcut failure needs. */
.nav-button.is-broken .nav-icon {
  background: var(--danger-line);
}
.nav-button:focus-visible,
.nav-music:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * Drawn at the areas' own size and idle colour, so it reads as part of the
 * same column rather than as a control bolted under it. The margin is what
 * keeps it off the very edge of the panel's padding.
 */
.nav-music {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-nav-gap);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.music-icon {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  background: var(--color-nav-idle);
  mask: var(--music-icon) center / contain no-repeat;
}
/* Playing is the selected state, exactly as a chosen area is. */
.nav-music[aria-pressed='true'] .music-icon {
  background: var(--color-cream);
}
</style>
