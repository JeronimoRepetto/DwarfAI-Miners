<script setup lang="ts">
import { computed } from 'vue'
import { MCP_STATUS_LABEL, sessionStrip } from '../../lib/scene/sessionStrip'
import type { AgentModelCatalog, Dwarf, DwarfTuningRequest } from '../../types'

/**
 * The mine's session strip (issue #96): a held session's own model, context
 * window and MCP roster, for the SELECTED dwarf, along the interior's lower
 * edge above the materials strip — the placement the maintainer named on
 * 2026-09-07, in `docs/dwarfai-miners-design/screens/mine.md`.
 *
 * Since that file's own mutating amendment the model and effort are also
 * CHANGED here rather than only read: the control that changes the model
 * belongs on the same line as the reading that proves it changed.
 *
 * Everything about WHICH controls exist for which state, and what a reading
 * means, is `lib/scene/sessionStrip.ts`'s decision and is unit-tested there.
 * This component only draws the verdict and reports a use of it: nothing here
 * branches on `textDelivery`, `status`, a catalogue source or a token count.
 */
const props = defineProps<{
  /** The selected dwarf, or absent while nobody is selected. */
  dwarf?: Dwarf
  /**
   * Every provider's live model catalogue, as the shell asked for it (#239's
   * own channel, reused rather than asked a second time). Absent while the
   * answer has not arrived, which is a strip with no select on it — the model
   * still shows as plain text.
   */
  catalogs?: readonly AgentModelCatalog[]
  /**
   * The reason the last change was refused, when one was (issue #96). Held
   * ABOVE this component, beside the request it answers: a refusal belongs to
   * a click, not to the board, and nothing on a snapshot would ever carry it.
   */
  refusal?: string
}>()

const emit = defineEmits<{
  /**
   * Somebody used a control. The shell above makes the request and holds the
   * verdict — the same split every other action in the mine follows, and the
   * reason this component needs no `window.api` of its own.
   */
  tune: [request: DwarfTuningRequest]
}>()

const strip = computed(() => sessionStrip(props.dwarf, props.catalogs ?? []))

/**
 * Report a chosen value, unless it is the one already in force.
 *
 * The guard is not tidiness: a control request travels a live stream, and
 * asking a session to change to what it is already running would spend one on
 * nothing. A select can settle back on its own value — a refused change
 * re-renders it, and so does a reader opening the menu and picking the same
 * row again.
 */
function choose(kind: 'model' | 'effort', current: string, event: Event): void {
  const chosen = (event.target as HTMLSelectElement).value
  if (chosen === '' || chosen === current) return
  const dwarfId = props.dwarf?.id
  if (dwarfId === undefined) return
  emit(
    'tune',
    kind === 'model'
      ? { dwarfId, change: { kind: 'model', model: chosen } }
      : { dwarfId, change: { kind: 'effort', effort: chosen } }
  )
}
</script>

<template>
  <div
    v-if="strip.kind !== 'none'"
    class="session-strip"
    :class="{ 'is-unavailable': strip.kind === 'unavailable' }"
    :aria-disabled="strip.kind === 'unavailable' ? 'true' : undefined"
  >
    <p v-if="strip.kind === 'unavailable'" class="session-reason">{{ strip.reason }}</p>
    <template v-else-if="strip.kind === 'live'">
      <!--
        The model: a select where the provider answered live, and the plain
        name otherwise. One or the other, never both — the name IS the control
        when there is one (mine.md's own mutating amendment).
      -->
      <div v-if="strip.modelControl !== undefined" class="session-tuning">
        <select
          class="session-model-select"
          aria-label="Session model"
          :value="strip.modelControl.value"
          :disabled="strip.modelControl.disabledReason !== undefined"
          :title="strip.modelControl.disabledReason"
          @change="choose('model', strip.modelControl.value, $event)"
        >
          <option v-if="strip.modelControl.value === ''" value="" disabled>Model</option>
          <option
            v-for="option in strip.modelControl.options"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <span v-if="strip.modelControl.pendingNote !== undefined" class="session-model-pending">
          {{ strip.modelControl.pendingNote }}
        </span>
      </div>
      <div v-else-if="strip.model !== undefined" class="session-model">{{ strip.model }}</div>
      <!--
        Effort, only where the ACTIVE model's own catalogue entry named
        levels. There is deliberately no disabled-because-unsupported case
        here: a model that takes no effort gets no control at all, because the
        CLI accepts the setting and silently discards it.
      -->
      <div v-if="strip.effortControl !== undefined" class="session-tuning">
        <select
          class="session-effort-select"
          aria-label="Session effort"
          :value="strip.effortControl.value"
          :disabled="strip.effortControl.disabledReason !== undefined"
          :title="strip.effortControl.disabledReason"
          @change="choose('effort', strip.effortControl.value, $event)"
        >
          <option v-if="strip.effortControl.value === ''" value="" disabled>Effort</option>
          <option
            v-for="option in strip.effortControl.options"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <span v-if="strip.effortControl.pendingNote !== undefined" class="session-effort-pending">
          {{ strip.effortControl.pendingNote }}
        </span>
      </div>
      <div v-if="strip.context !== undefined" class="session-context" :title="strip.context.detail">
        <span class="session-context-label">{{ strip.context.label }}</span>
        <span class="session-context-track" aria-hidden="true">
          <span class="session-context-fill" :style="{ width: `${strip.context.percent}%` }"></span>
        </span>
      </div>
      <ul v-if="strip.mcpServers.length > 0" class="session-mcp">
        <li
          v-for="server in strip.mcpServers"
          :key="server.name"
          class="session-mcp-server"
          :data-status="server.status"
          :title="`${server.name}: ${MCP_STATUS_LABEL[server.status]}`"
        >
          <span class="session-mcp-dot" aria-hidden="true"></span>
          <span class="session-mcp-name">{{ server.name }}</span>
        </li>
      </ul>
      <!--
        A refused change states its reason here, in the same place and the
        same voice as the observed-session refusal above (mine.md). Last on
        the line so it never displaces a reading that is still true.
      -->
      <p v-if="refusal !== undefined && refusal !== ''" class="session-refusal" role="status">
        {{ refusal }}
      </p>
    </template>
  </div>
</template>

<style scoped>
/*
 * The design's own placement (mine.md, "Session strip", 2026-09-07): a
 * compact capsule along the interior's lower edge, above the materials strip
 * (VaultChip's `bottom: 6px` — see its own comment). Height, the bar's
 * thickness and the roster's wrap are all left Unspecified there and decided
 * here.
 */
.session-strip {
  position: absolute;
  z-index: 6;
  right: 8px;
  bottom: 32px;
  left: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid var(--color-cream);
  border-radius: var(--radius-default);
  background: var(--color-panel);
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
}
.session-strip.is-unavailable {
  justify-content: center;
}
.session-reason {
  margin: 0;
  color: var(--color-tooltip-text);
  text-align: center;
}
.session-model {
  color: var(--color-accent);
  font-weight: 700;
  white-space: nowrap;
}
/*
 * The two selects, and the pending note each may carry (mine.md's mutating
 * amendment): the strip's own tokens and no new ones. `--color-control` is
 * the enabled control background the foundations name; the accent carries the
 * value, exactly as the plain model name it replaces did. Width and chevron
 * are Unspecified in the source and decided here.
 */
.session-tuning {
  display: flex;
  align-items: center;
  gap: 4px;
}
.session-model-select,
.session-effort-select {
  max-width: 96px;
  padding: 1px 2px;
  border: 1px solid var(--color-cream);
  border-radius: var(--radius-default);
  background: var(--color-control);
  color: var(--color-accent);
  font-family: inherit;
  font-size: inherit;
  font-weight: 700;
}
.session-model-select:disabled,
.session-effort-select:disabled {
  border-color: var(--color-control);
  color: var(--color-tooltip-text);
  cursor: not-allowed;
  opacity: 0.6;
}
/*
 * A value asked for and not yet confirmed. Marked by the accent and by its
 * own wording ("pending", "requested") rather than by a new colour — and it
 * never replaces the value in the select, which goes on reading what the
 * session actually runs.
 */
.session-model-pending,
.session-effort-pending {
  color: var(--color-accent);
  font-style: italic;
  white-space: nowrap;
}
/* A refused change, in the same voice as the observed-session refusal. */
.session-refusal {
  flex-basis: 100%;
  margin: 0;
  color: var(--color-tooltip-text);
}
.session-context {
  display: flex;
  align-items: center;
  gap: 6px;
}
.session-context-label {
  color: var(--color-accent);
  white-space: nowrap;
}
/* The thin bar the design calls for, behind the compact used/max label. */
.session-context-track {
  position: relative;
  overflow: hidden;
  width: 60px;
  height: 4px;
  border-radius: var(--radius-default);
  background: var(--color-control);
}
.session-context-fill {
  display: block;
  height: 100%;
  background: var(--color-accent);
}
.session-mcp {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.session-mcp-server {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.session-mcp-dot {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
/*
 * The vocabulary's own colours (mine.md): `needs-auth` reuses the accent
 * rather than reading as a failure, because a proxy server resting there is
 * normal, not broken.
 */
.session-mcp-server[data-status='connected'] .session-mcp-dot {
  background: var(--color-marker-uranium);
}
.session-mcp-server[data-status='needs-auth'] .session-mcp-dot,
.session-mcp-server[data-status='pending'] .session-mcp-dot {
  background: var(--color-accent);
}
.session-mcp-server[data-status='failed'] .session-mcp-dot {
  background: var(--color-marker-copper);
}
.session-mcp-server[data-status='disabled'] .session-mcp-dot {
  background: var(--color-control);
}
</style>
