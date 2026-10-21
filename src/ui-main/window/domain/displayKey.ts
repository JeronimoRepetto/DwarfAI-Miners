// The stable key of a display (ADR-024 item 5; INV-118; 06 §15 `VetaDock[displayKey]`): Veta's place is stored per
// display under it, so it must outlive what Electron renumbers. Pure: no Electron, no I/O.
//
// - The key is the display's label where it has one, its native resolution, its scale factor and its position relative
//   to the primary display, joined by `|`. Never `display.id`, whose stability across reboots is UNVERIFIED (S-024-1):
//   the id is read by nothing here.
// - A stored key is matched fuzzily against the displays now connected (ADR-024 item 5): the same key first; else the
//   one display with the same non-empty label and native resolution (its scale or its place beside the primary display
//   changed); else, for an unlabelled display, the one with the same native resolution and position (its scale
//   changed). Anything less certain is no match, so Veta never lands on another display by guess: it falls back to the
//   default place on the primary display (S21.03, S21.13).
// - S-024-1 is `partial` (spike-results/S-024-1.md): only a Windows same-boot baseline is recorded. Which facts survive
//   a reboot, a driver update and a dock/undock per OS is pending; when the record names them, the inputs here follow
//   it (ISSUE-286 spike gate).
import type { DisplayKey, Rect } from '../ports/windowFactory'

/** The facts Electron reports for a display that the key may read (`id` is listed only to be ignored). */
export interface DisplayFacts {
  readonly id: number
  readonly label: string
  readonly bounds: Rect
  /** In DIP; the native resolution is this times `scaleFactor`. */
  readonly size: { readonly width: number; readonly height: number }
  readonly scaleFactor: number
}

/** The key's four parts, in order. */
interface KeyParts {
  readonly label: string
  readonly native: string
  readonly scale: string
  readonly position: string
}

const SEPARATOR = '|'

/** ADR-024 item 5: label (when non-empty), native resolution, scale factor, position relative to the primary display. */
export function displayKeyOf(display: DisplayFacts, primary: DisplayFacts): DisplayKey {
  const native = `${Math.round(display.size.width * display.scaleFactor)}x${Math.round(display.size.height * display.scaleFactor)}`
  const position = `${display.bounds.x - primary.bounds.x},${display.bounds.y - primary.bounds.y}`
  return [display.label, native, `@${display.scaleFactor}`, position].join(SEPARATOR)
}

/** The parts of a key; the label may itself hold the separator, so the three fixed parts are read from the right. */
function partsOf(key: DisplayKey): KeyParts | null {
  const parts = key.split(SEPARATOR)
  if (parts.length < 4) return null
  const [native, scale, position] = parts.slice(-3) as [string, string, string]
  return { label: parts.slice(0, -3).join(SEPARATOR), native, scale, position }
}

/** The one display a predicate picks, or null when none or several do. */
function only<T>(candidates: readonly T[]): T | null {
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * The key of the connected display a stored key names (ADR-024 item 5), or null when none is certainly it.
 * `displays` are the displays now connected, each with its current key.
 */
export function matchDisplayKey(
  stored: DisplayKey,
  displays: readonly { readonly displayKey: DisplayKey }[]
): DisplayKey | null {
  if (displays.some((display) => display.displayKey === stored)) return stored
  const want = partsOf(stored)
  if (want === null) return null
  const connected = displays.flatMap((display) => {
    const parts = partsOf(display.displayKey)
    return parts === null ? [] : [{ key: display.displayKey, parts }]
  })
  const found =
    want.label !== ''
      ? only(
          connected.filter((d) => d.parts.label === want.label && d.parts.native === want.native)
        )
      : only(
          connected.filter(
            (d) =>
              d.parts.label === '' &&
              d.parts.native === want.native &&
              d.parts.position === want.position
          )
        )
  return found?.key ?? null
}
