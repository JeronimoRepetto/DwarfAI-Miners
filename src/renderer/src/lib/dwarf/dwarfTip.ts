/*
 * The dwarf tooltip's lines (#635), `molecules/dwarf-tooltip` in the design: name, rank and
 * provider, model and effort, silence and status. Shared by the sprite and its roster portrait, so
 * both always say the same thing. Today's tooltip content, laid out as the design's card
 * (screens/mine.md, W3·3); the card draws, this decides the words.
 */
import { describeEffort } from '../delivery/effort'
import { sceneDwarfStatus, type SceneDwarfStatus } from '../scene/sceneDwarf'
import { portraitStatusText } from './portrait'
import { isPanelObserved, type Dwarf, type DwarfObserver } from '../../types'
import { HOSTED_OBSERVER_LABEL } from './observerLabel'
import { dwarfDisplayName } from './displayName'

export interface DwarfTipView {
  /** The name the app calls the dwarf by: its custom name when it has one (dwarfDisplayName). */
  name: string
  /**
   * The base name, the line under a custom name (#635; components.md, Dwarf tooltip, Custom name):
   * the tooltip is one of the two places it stays visible once a dwarf is renamed. Absent while
   * the dwarf has no custom name, since the name above already is the base name.
   */
  baseName?: string
  rank: 'worker' | 'foreman'
  provider: string
  /** "{model} · {effort} effort" (copy.md), or what of it is known. */
  tuning: string
  /** "silent {silence} · ", or nothing where the provider keeps no silence figure. */
  silence: string
  status: SceneDwarfStatus
  statusText: string
}

/*
 * The tools' own names, as people know them (copy.md, "Name things by what people recognise").
 * A session this panel holds is "hosted", the word observerLabel gives it.
 */
const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity'
}

export function providerLabel(observer: DwarfObserver): string {
  if (isPanelObserved(observer)) return HOSTED_OBSERVER_LABEL
  return PROVIDER_LABEL[observer] ?? observer
}

/*
 * A silence as the design writes it ("12s", "2m", "2h"): the largest whole unit, rounded down,
 * because claiming more silence than was observed argues on the pessimistic side
 * (describeSilence). `days` goes one unit further ("2d", and a week is "7d", nothing larger), for
 * the MessagePanel's idle time (MESSAGE-QUESTIONS 10); the dwarf tooltip keeps hours as its
 * largest unit, since no doc gives it days.
 */
export function compactSilence(
  silentForMs: number,
  { days = false }: { days?: boolean } = {}
): string {
  const seconds = Math.floor(Math.max(0, silentForMs) / 1_000)
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (!days || hours < 24) return hours + 'h'
  return Math.floor(hours / 24) + 'd'
}

/*
 * An unknown fact prints nothing rather than a guess, as today's tooltip did (#47): no silence
 * where the provider keeps no transcript, no effort where none was reported, and a model admitted
 * unknown rather than left blank.
 */
export function dwarfTip(dwarf: Dwarf): DwarfTipView {
  const status = sceneDwarfStatus(dwarf)
  const effort =
    dwarf.effort === undefined
      ? undefined
      : describeEffort(dwarf.provider, dwarf.effort).toLowerCase() + ' effort'
  return {
    name: dwarfDisplayName(dwarf),
    ...(dwarf.customName === undefined ? {} : { baseName: dwarf.name }),
    rank: dwarf.role === 'foreman' ? 'foreman' : 'worker',
    provider: providerLabel(dwarf.provider),
    tuning: [dwarf.model ?? 'model unknown', effort].filter(Boolean).join(' · '),
    silence:
      dwarf.silentForMs === undefined ? '' : 'silent ' + compactSilence(dwarf.silentForMs) + ' · ',
    status,
    statusText: portraitStatusText(status)
  }
}
