/**
 * The painted art, resolved to bundled URLs.
 *
 * Every file here is produced by `pnpm art:build` from the source paintings
 * (see scripts/build-art.mjs) — never edit them by hand. Imports are explicit
 * rather than an `import.meta.glob`, so a missing or renamed asset fails at
 * build time instead of rendering as a broken image.
 */
import type { Material, MineTier } from '../types'
import type { DwarfFrame } from './presentation'

import dwarfForemanCheck from '../assets/art/dwarf-foreman-check.png'
import dwarfForemanIdle from '../assets/art/dwarf-foreman-idle.png'
import dwarfIdle from '../assets/art/dwarf-idle.png'
import dwarfPick1 from '../assets/art/dwarf-pick-1.png'
import dwarfPick2 from '../assets/art/dwarf-pick-2.png'
import dwarfRest1 from '../assets/art/dwarf-rest-1.png'
import dwarfRest2 from '../assets/art/dwarf-rest-2.png'
import dwarfWalk1 from '../assets/art/dwarf-walk-1.png'
import dwarfWalk2 from '../assets/art/dwarf-walk-2.png'

import interiorBronze from '../assets/art/interior-bronze.jpg'
import interiorCopper from '../assets/art/interior-copper.jpg'
import interiorGold from '../assets/art/interior-gold.jpg'
import interiorSilver from '../assets/art/interior-silver.jpg'
import interiorUranium from '../assets/art/interior-uranium.jpg'

import moundBronze from '../assets/art/mound-bronze.png'
import moundCopper from '../assets/art/mound-copper.png'
import moundGold from '../assets/art/mound-gold.png'
import moundSilver from '../assets/art/mound-silver.png'
import moundUranium from '../assets/art/mound-uranium.png'

import nuggetBronze from '../assets/art/nugget-bronze.png'
import nuggetCoal from '../assets/art/nugget-coal.png'
import nuggetCopper from '../assets/art/nugget-copper.png'
import nuggetGold from '../assets/art/nugget-gold.png'
import nuggetIron from '../assets/art/nugget-iron.png'
import nuggetSilver from '../assets/art/nugget-silver.png'
import nuggetUranium from '../assets/art/nugget-uranium.png'

import mapBg from '../assets/art/map-bg.jpg'

/** Every dwarf pose. All nine share one canvas, so frames swap without shifting. */
export const DWARF_FRAME_SRC: Record<DwarfFrame, string> = {
  idle: dwarfIdle,
  'pick-1': dwarfPick1,
  'pick-2': dwarfPick2,
  'walk-1': dwarfWalk1,
  'walk-2': dwarfWalk2,
  'rest-1': dwarfRest1,
  'rest-2': dwarfRest2,
  'foreman-idle': dwarfForemanIdle,
  'foreman-check': dwarfForemanCheck
}

/** Mine entrance on the map, one painting per tier. */
export const MOUND_SRC: Record<MineTier, string> = {
  bronze: moundBronze,
  copper: moundCopper,
  silver: moundSilver,
  gold: moundGold,
  uranium: moundUranium
}

/**
 * The pixel size every interior painting is produced at (see
 * scripts/build-art.mjs). Tall portrait art shown in a squarer, resizable
 * panel, which is exactly why `sceneGeometry.ts` has to know the ratio: it is
 * what decides how much of the painting survives the `object-fit: cover` crop,
 * and therefore where an authored anchor actually lands in the box.
 *
 * All five interiors share these dimensions; `sceneLayout.test.ts` leans on
 * that when it checks the authored anchors against the crop.
 */
export const INTERIOR_ART_SIZE = { width: 1289, height: 1600 } as const

/** Inside of a mine, one painting per tier. Each has a walkable floor at the bottom. */
export const INTERIOR_SRC: Record<MineTier, string> = {
  bronze: interiorBronze,
  copper: interiorCopper,
  silver: interiorSilver,
  gold: interiorGold,
  uranium: interiorUranium
}

/**
 * Every material with a painted nugget.
 *
 * Materials and tiers are NOT the same list, which is why this is keyed by
 * Material and not by MineTier: coal belongs to no tier at all (it is the
 * material of every token burned before the app existed), and iron belongs to
 * no tier YET. Iron was painted before bronze arrived and is already keyed and
 * committed, so keeping it here means a future tier below bronze costs no new
 * art — carrying one unused 19 KB painting is cheaper than pretending an asset
 * in the tree does not exist, and far cheaper than repainting it later.
 */
export type NuggetMaterial = Material | 'iron'

/**
 * Ore nuggets, one painting per material, 96px wide and trimmed to its own
 * content box rather than to a shared canvas: a pile stacks them shoulder to
 * shoulder, and shared padding would hold them apart with invisible margins.
 */
export const NUGGET_SRC: Record<NuggetMaterial, string> = {
  coal: nuggetCoal,
  iron: nuggetIron,
  bronze: nuggetBronze,
  copper: nuggetCopper,
  silver: nuggetSilver,
  gold: nuggetGold,
  uranium: nuggetUranium
}

/** The moonlit valley the mounds stand on. */
export const MAP_BG_SRC = mapBg

let preloaded = false

/**
 * Pull every dwarf frame into the browser cache once, so the first frame swap
 * of an animation does not flash an empty sprite. Safe to call from every
 * DwarfSprite instance; only the first call does any work.
 */
export function preloadDwarfArt(): void {
  if (preloaded || typeof Image === 'undefined') return
  preloaded = true
  for (const src of Object.values(DWARF_FRAME_SRC)) {
    new Image().src = src
  }
}
