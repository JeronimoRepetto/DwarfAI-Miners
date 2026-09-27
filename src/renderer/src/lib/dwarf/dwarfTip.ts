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

export interface DwarfTipView {
  name: string
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
 * (describeSilence).
 */
export function compactSilence(silentForMs: number): string {
  const seconds = Math.floor(Math.max(0, silentForMs) / 1_000)
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h'
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
    name: dwarf.name,
    rank: dwarf.role === 'foreman' ? 'foreman' : 'worker',
    provider: providerLabel(dwarf.provider),
    tuning: [dwarf.model ?? 'model unknown', effort].filter(Boolean).join(' · '),
    silence:
      dwarf.silentForMs === undefined ? '' : 'silent ' + compactSilence(dwarf.silentForMs) + ' · ',
    status,
    statusText: portraitStatusText(status)
  }
}
