/**
 * The painted art, resolved to bundled URLs.
 *
 * Every file here is produced by `pnpm art:build` from the source paintings
 * (see scripts/build-art.mjs) — never edit them by hand. Imports are explicit
 * rather than an `import.meta.glob`, so a missing or renamed asset fails at
 * build time instead of rendering as a broken image.
 */
import type { DwarfRole, Material, MineTier } from '../types'

import foremanEndSleepSheet from '../assets/art/dwarf-foreman/wait/dwarf-foreman-end-sleep-v2-Sheet.png'
import foremanIdleSheet from '../assets/art/dwarf-foreman/idle/dwarf-foreman-long-idle-v2-Sheet.png'
import foremanSleepingSheet from '../assets/art/dwarf-foreman/wait/dwarf-foreman-sleeping-v2-Sheet.png'
import foremanStartSleepSheet from '../assets/art/dwarf-foreman/wait/dwarf-foreman-strart-sleep-v2-Sheet.png'
import workerIdleSheet from '../assets/art/dwarf-worker/idle/dwarf-worker-idle-v2-Sheet.png'

import interiorBronze from '../assets/art/concept/interior-bronze.jpg'
import interiorCopper from '../assets/art/concept/interior-copper.jpg'
import interiorGold from '../assets/art/concept/interior-gold.jpg'
import interiorSilver from '../assets/art/concept/interior-silver.jpg'
import interiorUranium from '../assets/art/concept/interior-uranium.jpg'

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

import mapBg from '../assets/art/concept/map-bg.jpg'

/**
 * One packed animation strip. `idle` is the only name every rank is required to
 * have, because it is what a rank with no drawing for a state falls back to —
 * see dwarfSheets.ts, which is where that rule is spent.
 */
export type DwarfSheetName = 'idle' | 'start-sleep' | 'sleeping' | 'end-sleep'

export type DwarfSheetSrc = { idle: string } & Partial<Record<DwarfSheetName, string>>

/**
 * The hand-drawn dwarfs, one horizontal strip per animation (issues #74, #87).
 *
 * The filename `strart-sleep` is the ASSET's own typo, reproduced here exactly.
 * Renaming a committed file to tidy a spelling is a separate change from
 * teaching the panel to play it, and doing both at once makes neither
 * reviewable.
 *
 * What is missing is the point of the shape: a worker has one sheet because one
 * sheet has been drawn for him. Working, waiting and walking art arrives with
 * #74 and drops in here as data — no branch anywhere else moves.
 */
export const DWARF_SHEET_SRC = {
  worker: { idle: workerIdleSheet },
  foreman: {
    idle: foremanIdleSheet,
    'start-sleep': foremanStartSleepSheet,
    sleeping: foremanSleepingSheet,
    'end-sleep': foremanEndSleepSheet
  }
  // `satisfies` rather than an annotation: the contract is checked, and each
  // rank keeps the exact set of sheets it has, so reaching for one a rank has
  // not been drawn is a type error rather than an undefined at runtime.
} satisfies Record<DwarfRole, DwarfSheetSrc>

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
 * Pull every dwarf strip into the browser cache once, so the first frame of an
 * animation does not draw against an empty box. Safe to call from every
 * DwarfSprite instance; only the first call does any work.
 *
 * Cheaper than it was, and by more than the count suggests: five files instead
 * of nine, and each of them a handful of kilobytes of pixel art rather than a
 * ~195 KB painted pose (see docs/animation-loops.md).
 */
export function preloadDwarfArt(): void {
  if (preloaded || typeof Image === 'undefined') return
  preloaded = true
  for (const sheets of Object.values(DWARF_SHEET_SRC)) {
    for (const src of Object.values(sheets)) {
      new Image().src = src
    }
  }
}
