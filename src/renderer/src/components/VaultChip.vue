<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { formatTokens, oreCount } from '../lib/economy'

/**
 * Vault/treasure counter: total ore + a compact token count. `floating`
 * (default) self-positions in a corner (the map view); `inline` sits as a
 * normal flex item (the mine-interior header).
 */
const props = withDefaults(
  defineProps<{ tokensObserved: number; variant?: 'floating' | 'inline' }>(),
  { variant: 'floating' }
)

/** How long the sparkle animation plays before the chip settles back down. */
const SPARKLE_MS = 900

const sparkling = ref(false)
let sparkleTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.tokensObserved,
  (next, previous) => {
    if (previous === undefined || next <= previous) return
    sparkling.value = true
    clearTimeout(sparkleTimer)
    sparkleTimer = setTimeout(() => {
      sparkling.value = false
    }, SPARKLE_MS)
  }
)

onBeforeUnmount(() => clearTimeout(sparkleTimer))
</script>

<template>
  <div
    class="vault-chip"
    :class="{ 'is-inline': variant === 'inline', 'is-sparkling': sparkling }"
    :aria-label="`Vault: ${oreCount(tokensObserved)} ore, ${formatTokens(tokensObserved)} tokens observed`"
  >
    <span class="vault-ore" aria-hidden="true">{{ oreCount(tokensObserved) }} ore</span>
    <span class="vault-tokens" aria-hidden="true">{{ formatTokens(tokensObserved) }}</span>
  </div>
</template>

<style scoped>
.vault-chip {
  position: absolute;
  z-index: 5;
  top: 10px;
  right: 12px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--ink);
  background: #15100be6;
  box-shadow: 0 2px 10px #0008;
  font-size: 11px;
  white-space: nowrap;
}
.vault-chip.is-inline {
  position: static;
  flex: none;
}
.vault-ore {
  font-weight: 700;
  color: var(--lantern);
}
.vault-tokens {
  color: var(--ink-faint);
  font-size: 10px;
}
.vault-chip.is-sparkling {
  animation: vault-sparkle 0.9s ease-out;
}
@keyframes vault-sparkle {
  0% {
    box-shadow: 0 2px 10px #0008;
  }
  35% {
    box-shadow:
      0 2px 10px #0008,
      0 0 14px 2px var(--lantern-soft);
  }
  100% {
    box-shadow: 0 2px 10px #0008;
  }
}
@media (prefers-reduced-motion: reduce) {
  .vault-chip.is-sparkling {
    animation: none;
  }
}
</style>
