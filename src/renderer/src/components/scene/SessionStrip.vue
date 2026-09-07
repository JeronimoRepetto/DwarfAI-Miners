<script setup lang="ts">
import { computed } from 'vue'
import { MCP_STATUS_LABEL, sessionStrip } from '../../lib/scene/sessionStrip'
import type { Dwarf } from '../../types'

/**
 * The mine's read-only session strip (issue #96): a held session's own model,
 * context window and MCP roster, for the SELECTED dwarf, along the interior's
 * lower edge above the materials strip — the placement the maintainer named
 * on 2026-09-07, in `docs/dwarfai-miners-design/screens/mine.md`.
 *
 * Everything about WHICH sessions can report any of this, and what a reading
 * means, is `lib/scene/sessionStrip.ts`'s decision and is unit-tested there.
 * This component only draws the verdict: nothing here branches on
 * `textDelivery`, `status` or a token count itself.
 */
const props = defineProps<{
  /** The selected dwarf, or absent while nobody is selected. */
  dwarf?: Dwarf
}>()

const strip = computed(() => sessionStrip(props.dwarf))
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
      <div v-if="strip.model !== undefined" class="session-model">{{ strip.model }}</div>
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
