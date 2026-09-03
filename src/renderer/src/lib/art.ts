/**
 * The painted art, resolved to bundled URLs.
 *
 * Every file here is produced by `pnpm art:build` from the source paintings
 * (see scripts/build-art.mjs) — never edit them by hand. Imports are explicit
 * rather than an `import.meta.glob`, so a missing or renamed asset fails at
 * build time instead of rendering as a broken image.
 */
import type { DwarfRole, Material, MineTier } from '../types'
import type { MapTimeVariant } from './map/mapTime'
import type { ShellArea } from './shell/shellNav'

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

import mapDay from '../assets/art/map/map-bg-day.jpg'
import mapMorning from '../assets/art/map/map-bg-sunerise.jpg'
import mapNight from '../assets/art/map/map-bg-nigth.jpg'
import mapSunset from '../assets/art/map/map-bg-suneset.jpg'
import labArt from '../assets/art/lab/lab.jpg'
import marketArt from '../assets/art/market/market.jpg'

/*
 * The shell's own icons, imported from `docs/assets/icons` — the path the
 * design source names, and the only copy of them in the tree. They are drawn
 * through a CSS mask rather than inlined, so the committed SVG stays byte-for-
 * byte the designer's file while idle and selected take their colour from the
 * design tokens.
 */
import iconLab from '../../../../docs/assets/icons/lab.svg?url'
import iconMap from '../../../../docs/assets/icons/map.svg?url'
import iconMarket from '../../../../docs/assets/icons/market.svg?url'
import iconMine from '../../../../docs/assets/icons/mine.svg?url'
import iconSettings from '../../../../docs/assets/icons/settings.svg?url'
import iconClose from '../../../../docs/assets/icons/close.svg?url'

import trayIcon from '../../../../resources/tray-icon@2x.png'

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

/**
 * The pixel size every map painting is delivered at, measured off the four
 * committed files rather than assumed.
 *
 * Here for the same reason `INTERIOR_ART_SIZE` is: the map is drawn with
 * `object-fit: cover` into a resizable panel, so this ratio is what decides how
 * much of the painting survives the crop — and therefore where a spawn point
 * authored on the painting actually lands in the box (see mapProjection.ts).
 *
 * All four variants share it, which is what lets one authored coordinate serve
 * every hour of the day, exactly as the design says it should.
 */
export const MAP_ART_SIZE = { width: 1856, height: 2304 } as const

/**
 * The world map, one painting per time of day (#136).
 *
 * THREE OF THE FOUR FILENAMES CARRY A TYPO — `sunerise`, `suneset`, `nigth` —
 * and they are reproduced here exactly, the way `strart-sleep` is above. The
 * files are the delivered art; renaming a committed asset to tidy a spelling is
 * a separate change from wiring it up, and doing both at once makes neither
 * reviewable. Which is why every import is spelled out rather than globbed: a
 * typo in this list fails the build instead of drawing nothing at 3am.
 *
 * The variant a moment resolves to is `mapVariantAt` in lib/map/mapTime.ts;
 * this table only says which file each name means.
 */
export const MAP_BG_SRC: Record<MapTimeVariant, string> = {
  morning: mapMorning,
  day: mapDay,
  sunset: mapSunset,
  night: mapNight
}

/**
 * The shell navigation icons, keyed by the area each one selects.
 *
 * Every file is the design's own SVG at the path the source names; nothing here
 * is a substitute or a hand-drawn stand-in. Explicit imports for the same reason
 * the paintings use them: a renamed icon fails the build rather than rendering
 * as an empty 19px square nobody notices.
 */
export const SHELL_ICON_SRC: Record<ShellArea, string> = {
  settings: iconSettings,
  map: iconMap,
  mines: iconMine,
  lab: iconLab,
  market: iconMarket
}

/** The design's own close glyph, used by the panel's round close control. */
export const CLOSE_ICON_SRC = iconClose

/** The app mark, centred at the top of the rail and of the navigation column. */
export const TRAY_ICON_SRC = trayIcon

/** The base images behind the two panels the design ships as unavailable. */
export const UNAVAILABLE_ART_SRC = {
  lab: labArt,
  market: marketArt
} as const

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
