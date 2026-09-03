<script setup lang="ts">
/**
 * The design's dwarf status icons (#153), floated over the sprite.
 *
 * `components.md` names three and gives two of them a colour: a 19px
 * message/dialog glyph, cream on a worker and white on a foreman; a 19px
 * important-dialog glyph for a question put to the user, colour **Unspecified**;
 * and a 15px cream sleep glyph for rest. `screens/mine.md` says the same three
 * in prose, and `assets/mine/mine-agent-statuses.png` is the acceptance image.
 *
 * What this replaces is three improvisations that were never in the design: a
 * truncated parchment speech balloon, a hand-typed `z z z`, and a
 * provider-coloured dot. All three are gone.
 *
 * ## The one colour the source refuses to name
 *
 * The important-dialog glyph is drawn as an ordinary image rather than through
 * the mask every other glyph uses, and that is the point: the design marks its
 * colour Unspecified, so the designer's own file decides rather than a value
 * invented here. `important-dialog.svg` is an alert octagon painted `#ff0000`
 * with the exclamation cut out of it, which is exactly what the mock shows. The
 * gap is real and stays surfaced rather than being filled quietly.
 */
import {
  DIALOG_ICON_SRC,
  IMPORTANT_DIALOG_ICON_SRC,
  SLEEP_ICON_SRC,
  maskImageValue
} from '../../lib/art'
import type { DwarfRole } from '../../types'

const props = defineProps<{
  role: DwarfRole
  /** True while this dwarf's latest message is being shown (see lib/overlay/bubbles.ts). */
  talking: boolean
  /**
   * True when this dwarf's agent has asked its user something nothing has
   * answered. The provider's own structured record of an ask, never prose that
   * reads like a question — the same fact the browse card raises (#125).
   */
  asking: boolean
  /** True when the dwarf is resting rather than working. */
  resting: boolean
  /** Accessible name for the message control, e.g. "Read the full message from Gimli". */
  expandLabel: string
  /** Mirrored onto aria-expanded so assistive tech tracks the message panel. */
  expanded: boolean
}>()

const emit = defineEmits<{ expand: [] }>()

const dialogMask = maskImageValue(DIALOG_ICON_SRC)
const sleepMask = maskImageValue(SLEEP_ICON_SRC)
</script>

<template>
  <div class="dwarf-status" role="status">
    <!--
      The message glyph is the control that opens the full message, exactly as
      the balloon it replaces was: `.stop` keeps the click off the document-level
      close handlers, so reading a message never toggles the dwarf's own menu.
    -->
    <button
      v-if="props.talking"
      class="status-dialog"
      :class="props.role === 'foreman' ? 'is-foreman' : 'is-worker'"
      type="button"
      :style="{ '--status-icon': dialogMask }"
      :aria-label="props.expandLabel"
      :aria-expanded="props.expanded"
      @click.stop="emit('expand')"
    ></button>
    <img
      v-if="props.asking"
      class="status-important"
      :src="IMPORTANT_DIALOG_ICON_SRC"
      alt=""
      title="Waiting for an answer"
      draggable="false"
    />
    <span
      v-if="props.resting"
      class="status-sleep"
      :style="{ '--status-icon': sleepMask }"
      title="Resting"
      aria-hidden="true"
    ></span>
  </div>
</template>

<style scoped>
.dwarf-status {
  display: flex;
  gap: 3px;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
/* Everything in the row is inert except the message control. */
.status-dialog {
  padding: 0;
  border: 0;
  cursor: pointer;
  pointer-events: auto;
  background: var(--color-cream);
  width: var(--size-icon);
  height: var(--size-icon);
  mask: var(--status-icon) center / contain no-repeat;
  filter: drop-shadow(0 1px 2px #000c);
}
/* The component table's own rule: cream on a worker, white on a foreman. */
.status-dialog.is-worker {
  background: var(--color-cream);
}
.status-dialog.is-foreman {
  background: var(--color-white);
}
.status-dialog:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/* The designer's own file, unrecoloured — see the header. */
.status-important {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  filter: drop-shadow(0 1px 2px #000c);
  user-select: none;
}
/* The source gives the sleep marker its own, smaller size. */
.status-sleep {
  display: block;
  width: var(--size-sleep-icon);
  height: var(--size-sleep-icon);
  background: var(--color-cream);
  mask: var(--status-icon) center / contain no-repeat;
  filter: drop-shadow(0 1px 2px #000c);
}
</style>
