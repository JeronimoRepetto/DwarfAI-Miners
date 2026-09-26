/*
 * The icon registry (#635): one place every glyph in the panel is drawn from, so the design lead's
 * drawn set can replace the provisional one without touching a caller. Callers only ever ask for a
 * name; registering a drawn file under that name replaces the placeholder everywhere at once
 * (foundations.md, "Iconography").
 *
 * Its subject is every icon the panel shows, which is why it is its own directory beside
 * lib/art.ts rather than inside any one screen's: the nav, the button and every later atom draw
 * from it. Not to be confused with the application icon scripts/build-icons.mjs makes for the
 * taskbar, tray and installer.
 */
import { ICON_GRIDS, type IconName } from './iconGrids'

/**
 * Each palette key and the class that paints it; PixelIcon's stylesheet maps each class to its
 * token and nowhere else spells a colour. The upper-case keys take a `2` so no two classes differ
 * only by case.
 */
export const ICON_PALETTE = {
  o: 'o',
  h: 'h',
  p: 'p',
  q: 'q',
  y: 'y',
  b: 'b',
  B: 'B2',
  g: 'g',
  G: 'G2',
  s: 's',
  m: 'm',
  S: 'S2',
  w: 'w',
  r: 'r',
  R: 'R2',
  n: 'n',
  i: 'i',
  k: 'k'
} as const

const TRANSPARENT = '.'
const OUTLINE = 'o'

/** One horizontal run of one key: a rect of height 1 on the 16x16 grid. */
export interface IconRun {
  x: number
  y: number
  width: number
  className: string
}

/** What a name draws: its grid as runs, or a drawn file registered over it. */
export type DrawnIcon = { kind: 'cells'; runs: IconRun[] } | { kind: 'image'; src: string }

// A transparent cell beside a fill, up, down, left or right, becomes outline; so a grid needs only
// its fills, and every icon gets the same dark outline as the art.
export function outlined(fills: readonly string[]): string[] {
  const isFill = (x: number, y: number): boolean => {
    const key = fills[y]?.[x]
    return key !== undefined && key !== TRANSPARENT && key !== OUTLINE
  }
  return fills.map((row, y) =>
    [...row]
      .map((key, x) =>
        key === TRANSPARENT &&
        (isFill(x, y - 1) || isFill(x, y + 1) || isFill(x - 1, y) || isFill(x + 1, y))
          ? OUTLINE
          : key
      )
      .join('')
  )
}

export function iconRuns(grid: readonly string[]): IconRun[] {
  const runs: IconRun[] = []
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const key = row[x]!
      let end = x + 1
      while (row[end] === key) end++
      if (key !== TRANSPARENT) {
        const name = ICON_PALETTE[key as keyof typeof ICON_PALETTE]
        if (name === undefined) throw new Error('icon: no palette key ' + key)
        runs.push({ x, y, width: end - x, className: 'c-' + name })
      }
      x = end
    }
  })
  return runs
}

export interface IconRegistry {
  /** Replaces a placeholder with a drawn 16x16 file, exported at 1x. */
  register(name: IconName, drawn: { src: string }): void
  lookup(name: IconName): DrawnIcon
}

export function createIconRegistry(grids: Record<IconName, readonly string[]>): IconRegistry {
  const files = new Map<IconName, string>()
  const cells = new Map<IconName, IconRun[]>()
  return {
    register(name, drawn) {
      files.set(name, drawn.src)
    },
    lookup(name) {
      const src = files.get(name)
      if (src !== undefined) return { kind: 'image', src }
      const grid = grids[name]
      if (grid === undefined) throw new Error('icon: the registry holds no icon named ' + name)
      let runs = cells.get(name)
      if (runs === undefined) {
        runs = iconRuns(grid)
        cells.set(name, runs)
      }
      return { kind: 'cells', runs }
    }
  }
}

/** The app's one registry, holding the provisional set. */
export const icons = createIconRegistry(ICON_GRIDS)
