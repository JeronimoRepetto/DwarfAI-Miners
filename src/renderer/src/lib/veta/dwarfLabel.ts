/*
 * A Veta dwarf's words and its hover label's place (US-VETA-005.AC01, AC08; 07 S24.19; ISSUE-290;
 * DS/docs/components.md, Mine chamber, Anatomy). Pure.
 *
 * - The one-line label reads "`<name>` · `<status>` · silent `<silence>`" and the dwarf's name for a screen reader
 *   "`<name>`, `<status>`, silent `<silence>`" (DS/docs/copy.md, Veta strip), the status words working, needs you,
 *   asleep and idle. The name is the custom name a person gave the dwarf, else its base name.
 * - The silence is the time since the dwarf's newest message the Host fed this window (its chat feed), written as the
 *   dwarf tooltip writes one ("8s", "3m", "2h"). The Host's dwarf view carries no silence figure, so a dwarf with no
 *   message yet has none, and an unmeasured silence prints nothing rather than a guess (the dwarf tooltip's rule; a
 *   package gap resolved in ISSUE-290).
 * - The label is centred on the dwarf, never on its chamber, on every edge: on a top or bottom edge its centre is the
 *   dwarf's centre along the chamber, 46 px beyond it so it clears the raised tab; on a side edge its centre is the
 *   dwarf's centre down the shaft, beyond the tab (its width + 10 px) where the dwarf is level with the tab and 8 px
 *   beyond the shaft elsewhere. The design places a shaft's label 10 px below the dwarf's top; the story asks for it
 *   centred on the dwarf, which is what this does.
 */
import { t, type DwarfStatus, type DwarfWire } from '@dwarfai/contracts'
import { compactSilence } from '../dwarf/dwarfTip'

/** A box in the chamber's own CSS pixels. */
export interface LabelBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where the tab rises, and so where the label stands: toward the screen. */
export type LabelSide = 'top' | 'bottom' | 'left' | 'right'

const STATUS_KEY = {
  working: 'veta.dwarf.status.working',
  asking: 'veta.dwarf.status.asking',
  asleep: 'veta.dwarf.status.asleep',
  idle: 'veta.dwarf.status.idle'
} as const satisfies Record<DwarfStatus, string>

/** The hover label and the screen reader's name of a dwarf whose silence is `silentForMs`, when measured. */
export function dwarfLabels(
  dwarf: Pick<DwarfWire, 'baseName' | 'customName' | 'status'>,
  silentForMs: number | undefined
): { tip: string; aria: string } {
  const name = dwarf.customName ?? dwarf.baseName
  const status = t(STATUS_KEY[dwarf.status])
  if (silentForMs === undefined) {
    return {
      tip: t('veta.dwarf.tip.unmeasured', { name, status }),
      aria: t('veta.dwarf.label.unmeasured', { name, status })
    }
  }
  const silence = compactSilence(silentForMs)
  return {
    tip: t('veta.dwarf.tip', { name, status, silence }),
    aria: t('veta.dwarf.label', { name, status, silence })
  }
}

/** The time since the newest of a dwarf's messages, at `now`; `undefined` with no message to measure from. */
export function silenceOf(
  messages: readonly { timestamp: string }[] | undefined,
  now: number
): number | undefined {
  let newest = Number.NEGATIVE_INFINITY
  for (const message of messages ?? []) {
    const at = Date.parse(message.timestamp)
    if (Number.isFinite(at) && at > newest) newest = at
  }
  return newest === Number.NEGATIVE_INFINITY ? undefined : Math.max(0, now - newest)
}

/** How far the label stands beyond a row chamber, past its raised tab. */
const ROW_BEYOND = 46
/** Beyond a shaft, and beyond its tab where the dwarf is level with it. */
const SHAFT_BEYOND = 8
const PAST_TAB = 10

/** The label's inline place in its chamber for the dwarf `dwarf`; `tab` is the chamber's tab box, if laid out. */
export function labelPlace(
  side: LabelSide,
  dwarf: LabelBox,
  tab: LabelBox | null
): Record<string, string> {
  if (side === 'top' || side === 'bottom') {
    const left = `${dwarf.x + dwarf.width / 2}px`
    const beyond = `calc(100% + ${ROW_BEYOND}px)`
    return side === 'top' ? { left, bottom: beyond } : { left, top: beyond }
  }
  const level = tab !== null && dwarf.y < tab.y + tab.height && tab.y < dwarf.y + dwarf.height
  const beyond = `calc(100% + ${level ? tab.width + PAST_TAB : SHAFT_BEYOND}px)`
  const top = `${dwarf.y + dwarf.height / 2}px`
  return side === 'left' ? { top, right: beyond } : { top, left: beyond }
}
