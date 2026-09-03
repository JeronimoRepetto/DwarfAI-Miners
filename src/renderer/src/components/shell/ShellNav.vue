<script setup lang="ts">
import { SHELL_ICON_SRC, TRAY_ICON_SRC, maskImageValue } from '../../lib/art'
import { SHELL_NAV, type ShellArea } from '../../lib/shell/shellNav'

/**
 * The shell navigation stack (#90): the app mark at the top of the panel's
 * outer edge, and below it the five areas, vertically centred against the panel.
 *
 * Thin by construction — it renders the area it is given and asks for the one
 * that was pressed. The view itself belongs to `useView`, and whether an area
 * can be reached at all belongs to the shell.
 */
defineProps<{
  area: ShellArea
  /**
   * Whether the global panel shortcut failed to register (#17). Flagged here
   * because the settings button is now the only entry point to the panel that
   * would explain it — and a failure nobody meets until they open settings is
   * a failure nobody looks for.
   */
  broken: boolean
}>()

const emit = defineEmits<{
  select: [area: ShellArea]
  /**
   * The app mark was pressed: put the whole shell back in the rail (#153).
   *
   * Its own event rather than an area, because it is not one — the design's
   * navigation stack selects between five screens and the mark above it is not
   * a sixth. Decides nothing here for the same reason the rail's arrow does not:
   * the window is main's, and what gets drawn is the layout that comes back.
   */
  collapse: []
}>()
</script>

<template>
  <nav class="shell-nav" aria-label="DwarfAI-Miners sections">
    <!--
      The app mark, and the control that collapses the whole shell back into
      the rail (#153). It was inert until the acceptance run; the arrow used to
      do this and now closes only the secondary panel.
    -->
    <button
      class="nav-mark"
      type="button"
      aria-label="Collapse DwarfAI-Miners into the rail"
      title="Collapse DwarfAI-Miners"
      @click="emit('collapse')"
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
.nav-button:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
