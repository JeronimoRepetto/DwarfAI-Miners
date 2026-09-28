<script setup lang="ts">
/*
 * A guild page (#635), `organisms/guild-page` in the design: Lab, Market or Laboral Union in its
 * unavailable state — the page header, and the area's painting under the 50% veil with its plate
 * saying it is not open yet. There is nothing to press, because the design offers nothing to do.
 * It is only ever shown once the guild flag reveals the areas; the words are lib/shell/guildPage's.
 */
import { computed } from 'vue'
import PageHeader from './PageHeader.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import { UNAVAILABLE_ART_SRC } from '../../lib/art'
import { GUILD_PAGE_HEADLINE, guildPageCopy } from '../../lib/shell/guildPage'
import type { UnavailableArea } from '../../lib/shell/shellNav'

const props = defineProps<{ area: UnavailableArea }>()

const copy = computed(() => guildPageCopy(props.area))
const art = computed(() => ({ backgroundImage: `url("${UNAVAILABLE_ART_SRC[props.area]}")` }))
</script>

<template>
  <section class="dm-guild" :aria-label="copy.name">
    <PageHeader :title="copy.name" />
    <div class="dm-guild__well">
      <div class="dm-guild__art" :style="art">
        <div class="dm-guild__veil">
          <div class="dm-guild__plate m-mat m-raised">
            <PixelIcon :name="copy.icon" :scale="2" />
            <h2>{{ GUILD_PAGE_HEADLINE }}</h2>
            <p>{{ copy.text }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The design's guild-page.css, rule for rule and in its order. */
.dm-guild {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 4px;
  height: 100%;
  min-height: 0;
}
.dm-guild__well {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 0;
  margin: 2px;
  overflow: hidden;
  background: var(--rock-lo);
  container-type: size;
}
/* The painting at its own shape, as large as the well allows: 1126 by 1397. */
.dm-guild__art {
  position: relative;
  width: min(100cqw, 100cqh * 0.806);
  aspect-ratio: 1126 / 1397;
  background-size: 100% 100%;
}
.dm-guild__veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--veil);
}
.dm-guild__plate {
  --mat-fill: var(--wood);
  --mat-edge: var(--parchment);
  display: grid;
  justify-items: center;
  gap: 8px;
  max-width: 300px;
  padding: 16px 18px;
  text-align: center;
}
.dm-guild__plate h2 {
  margin: 0;
  font: var(--fs-headline) / 1.1 var(--f-display);
  color: var(--gold);
}
.dm-guild__plate p {
  margin: 0;
  font: var(--fs-body) / 1.35 var(--f-meta);
  color: var(--parchment);
}
</style>
