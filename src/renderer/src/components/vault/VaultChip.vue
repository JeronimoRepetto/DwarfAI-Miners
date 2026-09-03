<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NUGGET_SRC } from '../../lib/art'
import { formatTokens } from '../../lib/vault/economy'
import { orePileLabel, vaultLabel } from '../../lib/presentation'
import { formatUnits, vaultRows } from '../../lib/vault/vault'
import type { MaterialTotals } from '../../types'

/**
 * Vault/treasure counter: the per-material breakdown plus a compact token
 * count.
 *
 * ## The two variants, and why each places ITSELF (#153)
 *
 * `floating` (default) is the map's upper-right overlay; `strip` is the mine
 * interior's, along the bottom edge of the painting. Both place themselves, and
 * that is the correction: the interior used to pass an `inline` variant that
 * declared `position: static` and then position the chip from OUTSIDE — and
 * `.vault-chip.is-inline`, two classes with a scope attribute, out-specified
 * MineScene's own one-class `.interior-vault`. The strip fell back into normal
 * flow and floated at the interior's TOP, which is what the maintainer saw. A
 * component that declines to place itself and leaves its owner to try is a
 * specificity race nobody wins twice.
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
    variant?: 'floating' | 'strip'
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
    :class="[`is-${variant}`, { 'is-sparkling': sparkling }]"
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
/*
 * The map's upper-right overlay in the redesign (#90) — the collected raw
 * materials, exactly where `screens/map.md` puts them. Restyled to the design's
 * own frame (12px radius, 2px #fae2b6, 10px pixel type) and nothing else: the
 * per-material breakdown behind it is #22's rule and is untouched.
 */
.vault-chip {
  position: absolute;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border: var(--border-highlight);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: #0a0806e6;
  box-shadow: var(--elevation-5);
  font-size: var(--text-meta);
  white-space: nowrap;
}
/* The map's own upper-right overlay, where screens/map.md puts the totals. */
.vault-chip.is-floating {
  top: 0;
  right: 0;
}
/*
 * The mine interior's own strip, along the BOTTOM edge of the painting exactly
 * where the design's mine export draws it (#153) — a centred capsule rather than
 * a corner chip, with fully rounded ends the shared 12px radius would not close
 * on a strip this short.
 */
.vault-chip.is-strip {
  right: 8px;
  bottom: 6px;
  left: 8px;
  justify-content: center;
  padding: 2px 6px;
  border: 0;
  border-radius: 999px;
  background: #0a0806cc;
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
  /* The amber the design gives titles and dividers, so the numbers stay the
     warm thing in the chip; the ore itself is coloured by paint. */
  color: var(--color-accent);
}
.vault-empty {
  color: var(--color-tooltip-text);
}
.vault-tokens {
  color: var(--color-tooltip-text);
}
.vault-chip.is-sparkling {
  animation: vault-sparkle 0.9s ease-out;
}
@keyframes vault-sparkle {
  0% {
    box-shadow: var(--elevation-5);
  }
  35% {
    box-shadow:
      var(--elevation-5),
      0 0 14px 2px var(--color-rail);
  }
  100% {
    box-shadow: var(--elevation-5);
  }
}
@media (prefers-reduced-motion: reduce) {
  .vault-chip.is-sparkling {
    animation: none;
  }
}
</style>
