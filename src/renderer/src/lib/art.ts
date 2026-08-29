/**
 * The painted art, resolved to bundled URLs.
 *
 * Every file here is produced by `pnpm art:build` from the source paintings
 * (see scripts/build-art.mjs) — never edit them by hand. Imports are explicit
 * rather than an `import.meta.glob`, so a missing or renamed asset fails at
 * build time instead of rendering as a broken image.
 */
import type { MineTier } from '../types'
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

/** Inside of a mine, one painting per tier. Each has a walkable floor at the bottom. */
export const INTERIOR_SRC: Record<MineTier, string> = {
  bronze: interiorBronze,
  copper: interiorCopper,
  silver: interiorSilver,
  gold: interiorGold,
  uranium: interiorUranium
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
