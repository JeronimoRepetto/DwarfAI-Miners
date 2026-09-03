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
import worker2IdleSheet from '../assets/art/dwarf-worker/idle/dwarf-worker2-idle-v2-Sheet.png'
import workerStartWorkingSheet from '../assets/art/dwarf-worker/working/dwarf-worker-start-working.png'
import workerWorkingSheet from '../assets/art/dwarf-worker/working/dwarf-worker-working.png'
import workerEndWorkingSheet from '../assets/art/dwarf-worker/working/dwarf-worker-end-working.png'

import interiorBronze from '../assets/art/inside-mines/inside-bronze-mine.jpg'
import interiorCopper from '../assets/art/inside-mines/inside-cropper-mine.jpg'
import interiorGold from '../assets/art/inside-mines/inside-gold-mine.jpg'
import interiorSilver from '../assets/art/inside-mines/inside-silver-mine.jpg'
import interiorUranium from '../assets/art/inside-mines/inside-uranium-mine.jpg'

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
import iconAdd from '../../../../docs/assets/icons/add.svg?url'
import iconDialog from '../../../../docs/assets/icons/dialog.svg?url'
import iconImportantDialog from '../../../../docs/assets/icons/important-dialog.svg?url'
import iconFilter from '../../../../docs/assets/icons/filter.svg?url'
import iconSleep from '../../../../docs/assets/icons/sleep.svg?url'

import trayIcon from '../../../../resources/tray-icon@2x.png'

/**
 * One packed animation strip. `idle` is the only name every rank is required to
 * have, because it is what a rank with no drawing for a state falls back to —
 * see dwarfSheets.ts, which is where that rule is spent.
 */
export type DwarfSheetName =
  'idle' | 'start-sleep' | 'sleeping' | 'end-sleep' | 'start-working' | 'working' | 'end-working'

export type DwarfSheetSrc = { idle: string } & Partial<Record<DwarfSheetName, string>>

/**
 * The hand-drawn dwarfs, one horizontal strip per animation (issues #74, #87).
 *
 * The filename `strart-sleep` is the ASSET's own typo, reproduced here exactly.
 * Renaming a committed file to tidy a spelling is a separate change from
 * teaching the panel to play it, and doing both at once makes neither
 * reviewable.
 *
 * A worker now has its working sequence too (#74's first delivery beyond
 * idle): picked up once, swings on a loop, set down once on the way out.
 * Waiting and walking art still arrives later and drops in here the same
 * way — no branch anywhere else moves.
 *
 * The worker2's idle (#157) lives in the WORKER's directory because that is
 * where the maintainer drew and delivered it; the path is the artist's filing,
 * not a claim that the two ranks share art. They do not — each rank's `idle` is
 * its own file, which is exactly what the fallback rule below depends on.
 */
export const DWARF_SHEET_SRC = {
  worker: {
    idle: workerIdleSheet,
    'start-working': workerStartWorkingSheet,
    working: workerWorkingSheet,
    'end-working': workerEndWorkingSheet
  },
  // Idle alone, and that is the whole inventory a rank is required to have: a
  // working worker2 plays its OWN idle until the working strip lands, never the
  // worker's (see dwarfSheets.ts on why a rank never borrows across ranks).
  worker2: {
    idle: worker2IdleSheet
  },
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
 * The pixel size every interior painting is produced at.
 *
 * A tower — three times taller than it is wide — which is exactly why
 * `sceneGeometry.ts` has to know the ratio: it decides where the painting is
 * drawn inside its column, and therefore where an extracted work point actually
 * lands in the box.
 *
 * All five share it (Cropper is 3620 tall, two pixels short, which is 0.06% and
 * below anything the projection can express). `interiorMap.ts` keeps a copy
 * because its coordinates are percentages OF this size, and
 * `sceneSizing.test.ts` holds the two equal.
 */
export const INTERIOR_ART_SIZE = { width: 1184, height: 3622 } as const

/**
 * Inside of a mine, one painting per tier — the production art the design's own
 * interior sheets are renders of, wired up by #137.
 *
 * `copper` reads `inside-cropper-mine.jpg` because the artwork spells the tier
 * that way; the canonical tier name is `copper` everywhere else in the codebase
 * (see foundations.md), and the mapping is done here rather than by renaming a
 * delivered painting to disagree with its own source.
 */
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

/**
 * The Mines panel's own glyphs (#135), from the same `docs/assets/icons`
 * directory the design source names for every other icon.
 *
 * `filter.svg` is the file behind BOTH readings of the control the browse
 * screen draws beside the search field: the source calls it the date-sort
 * control in prose and the file is named for a filter, and they are one glyph
 * and one button. It is imported under the name of what it DOES here rather
 * than the file's own, so the panel never grows a second sort affordance.
 *
 * Every one of these is drawn through a CSS mask, exactly as the shell icons
 * are, so the committed SVG keeps the designer's bytes while the colour comes
 * from the tokens — which matters more here than on the rail, because the mock
 * draws the message bubble in accent amber and the file's own fill is cream.
 */
export const SORT_ICON_SRC = iconFilter
export const ADD_ICON_SRC = iconAdd
export const DIALOG_ICON_SRC = iconDialog
export const SLEEP_ICON_SRC = iconSleep

/**
 * The question-put-to-the-user glyph (#153), and the one icon in this file that
 * is NOT drawn through a mask.
 *
 * `components.md` gives the other status icons a colour and marks this one
 * **Unspecified**, so the designer's own file decides: an alert octagon painted
 * `#ff0000` with the exclamation cut out of it, which is what the design's mine
 * mock shows. Recolouring it would be filling a gap the source deliberately
 * left, so it is rendered as an ordinary image and the gap stays visible.
 */
export const IMPORTANT_DIALOG_ICON_SRC = iconImportantDialog

/**
 * One committed glyph as a CSS value a `mask` can actually be drawn with.
 *
 * ## Why this exists (#153)
 *
 * Every icon in the shipped app rendered as a solid coloured square, and it was
 * one character. These SVGs are all under 4 KB, so the bundler inlines each as a
 * `data:image/svg+xml,...` URI — and its encoder rewrites the file's own double
 * quotes to single ones, so the URI arrives full of `'`. The components wrote
 * the mask as a bare `url(<that>)`, and **a CSS url-token may not contain a
 * quote**: the parser produces a bad-url-token, the custom property carrying it
 * is discarded, `var(--nav-icon)` never resolves, the whole `mask` shorthand
 * falls back to `none`, and the `background` underneath paints the full box.
 * Nothing errors and nothing warns; the glyph is simply a block.
 *
 * The dev server hands out `/@fs/...` paths with no quotes in them, which is why
 * the icons looked right until somebody ran a build.
 *
 * So the url is quoted here, once, and any double quote in the source is
 * percent-encoded so a future encoder cannot break out of the quoting the same
 * way the apostrophes broke out of none. Every masked glyph in the renderer
 * goes through this rather than interpolating a `url()` of its own.
 */
export function maskImageValue(src: string): string {
  return `url("${src.replaceAll('"', '%22')}")`
}

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
 * Cheaper than it was, and by more than the count suggests: eight files
 * (five before #74's working strips) instead of nine, and each of them a
 * handful of kilobytes of pixel art rather than a ~195 KB painted pose (see
 * docs/animation-loops.md).
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
