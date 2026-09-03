import type { AgentProviderOption } from '../../types'
import { OTHER_CHOICE, type LaunchChoice } from './launchState'

/**
 * The Add Panel's chip row (#86), and what a chip can honestly promise.
 *
 * `components.md` specifies the row as detected providers followed by an
 * always-available **Other**, and states outright that its six example labels
 * are illustrative because runtime detection controls which known providers
 * appear. So the row is built from what main detected and never from a list
 * written here — a hardcoded row would be a screenshot of the mockup rather
 * than a picture of this machine.
 */

/** The chip that is not a provider. Always last, always there. */
export const OTHER_CHIP_LABEL = 'Other'

/**
 * Why a custom command is not started — the ruling, not a gap (#168).
 *
 * This used to say "cannot be started yet", which was honest while neither
 * launch channel took a provider and there was nowhere for a user's command to
 * go. #168 built that somewhere, and the answer is still no. The reason has
 * nothing to do with the wire, which could carry a command string tomorrow:
 *
 * A launched command of the user's own writes no session store. Every dwarf on
 * the board is read out of one — Claude's transcripts, Codex's rollout files —
 * so a custom process is one the poll can never find, and the panel would sit
 * in its spawning state waiting for an arrival that cannot happen. Drawing it
 * anyway would need a third way of noticing a session, which is the second
 * observation path #86 refuses.
 *
 * `launchState.ts` reached this from the other side already: `OTHER_CHOICE` is
 * kept out of `DwarfProvider` because that union is who OBSERVED a dwarf, and
 * no observation ever comes back saying 'other'.
 *
 * The chip stays where the design draws it and its gate still works — hiding it
 * would answer a product question by deletion. Enter says this instead.
 *
 * The full ruling, including what would change it, is docs/custom-launch-command.md.
 */
export const OTHER_NOT_LAUNCHABLE =
  'A launch command of your own would start a process no dwarf could ever be drawn from — ' +
  'the panel observes agents through their own session files.'

/** Why a chip for something detection has since stopped reporting cannot be started. */
export const NOT_DETECTED = 'That provider is no longer detected on this machine.'

/** The design's own three states for a chip: before any choice, and after one. */
export type ChipState = 'default' | 'unselected' | 'selected'

export interface ProviderChip {
  choice: LaunchChoice
  label: string
  state: ChipState
}

function chipState(choice: LaunchChoice, chosen: LaunchChoice | null): ChipState {
  if (chosen === null) return 'default'
  return chosen === choice ? 'selected' : 'unselected'
}

/**
 * The row, in detection's order, with Other appended.
 *
 * Only INSTALLED providers become chips: `launch.md` says to show only detected
 * known-provider chips. An undetected one is not hidden by accident — main
 * reports it either way, so the panel knows the difference — it is simply not
 * something the design offers to start.
 */
export function providerChips(
  providers: readonly AgentProviderOption[],
  chosen: LaunchChoice | null
): ProviderChip[] {
  const chips: ProviderChip[] = providers
    .filter((entry) => entry.installed)
    .map((entry) => ({
      choice: entry.provider,
      label: entry.provider,
      state: chipState(entry.provider, chosen)
    }))
  chips.push({
    choice: OTHER_CHOICE,
    label: OTHER_CHIP_LABEL,
    state: chipState(OTHER_CHOICE, chosen)
  })
  return chips
}

/**
 * Why the chosen chip cannot start a session, or null when it can.
 *
 * A reason from main is repeated rather than reworded: the panel's job is to
 * render what main verified, and a second phrasing here would be a second place
 * for the two processes to disagree about what this app can do.
 */
export function launchRefusal(
  providers: readonly AgentProviderOption[],
  chosen: LaunchChoice | null
): string | null {
  if (chosen === null) return null
  if (chosen === OTHER_CHOICE) return OTHER_NOT_LAUNCHABLE
  const entry = providers.find((option) => option.provider === chosen)
  if (entry === undefined || !entry.installed) return NOT_DETECTED
  if (entry.launchable) return null
  return entry.reason ?? NOT_DETECTED
}
