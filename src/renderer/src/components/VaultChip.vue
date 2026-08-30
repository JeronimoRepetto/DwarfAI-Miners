<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NUGGET_SRC } from '../lib/art'
import { formatTokens } from '../lib/economy'
import { orePileLabel, vaultLabel } from '../lib/presentation'
import { formatUnits, vaultRows } from '../lib/vault'
import type { MaterialTotals } from '../types'

/**
 * Vault/treasure counter: the per-material breakdown plus a compact token
 * count. `floating` (default) self-positions in a corner (the map view);
 * `inline` sits as a normal flex item (the mine-interior header).
 *
 * The breakdown is one labelled entry PER MATERIAL and never a single combined
 * figure. That is the whole point of #22: materials do not convert into one
 * another, so a merged count would only mean something if a coal nugget could
 * be traded for a gold one. The chip used to show exactly such a number — every
 * token divided by one flat rate — and it is what this replaces.
 *
 * The token count beside it is not a merge: tokens are the single raw substance
 * every pile is drawn from, and `tokensObserved` is the LIVE gauge over the
 * crews visible this instant, which is a different fact from the cumulative
 * piles. The accessible name spells both out so the two are never blurred.
 */
const props = withDefaults(
  defineProps<{
    tokensObserved: number
    /**
     * The vault to break down: this mine's in the mine view, the whole ledger's
     * in the map view. Optional because the wire field is (see Mine.materials)
     * — a snapshot published before the ledger loaded simply has no vault yet.
     */
    materials?: MaterialTotals
    variant?: 'floating' | 'inline'
  }>(),
  { materials: undefined, variant: 'floating' }
)

/** How long the sparkle animation plays before the chip settles back down. */
const SPARKLE_MS = 900

const sparkling = ref(false)
let sparkleTimer: ReturnType<typeof setTimeout> | undefined

const rows = computed(() => vaultRows(props.materials))
const label = computed(() => vaultLabel(props.materials, props.tokensObserved))

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
    :title="label"
    :aria-label="label"
  >
    <!--
      One entry per material, poorest first. Each carries its own painted nugget
      and its own count, and its own hover line naming the ore — the same
      wording the cave's mounds use, so the chip and the deposit agree.
    -->
    <span v-if="rows.length === 0" class="vault-empty" aria-hidden="true">no ore yet</span>
    <span
      v-for="row in rows"
      :key="row.material"
      class="vault-material"
      :data-material="row.material"
      :title="orePileLabel(row.material, row.tokens)"
      aria-hidden="true"
    >
      <img class="vault-nugget" :src="NUGGET_SRC[row.material]" alt="" draggable="false" />
      <span class="vault-units">{{ formatUnits(row.units) }}</span>
    </span>
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
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
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
.vault-material {
  display: flex;
  align-items: center;
  gap: 2px;
}
.vault-nugget {
  display: block;
  width: 13px;
  height: auto;
  filter: drop-shadow(0 1px 1px #000000b3);
  user-select: none;
}
.vault-units {
  font-weight: 700;
  /* The lantern amber the old single ore count used, kept so the numbers still
     read as the warm thing in the chip; the ore itself is coloured by paint. */
  color: var(--lantern);
}
.vault-empty {
  color: var(--ink-faint);
  font-size: 10px;
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
