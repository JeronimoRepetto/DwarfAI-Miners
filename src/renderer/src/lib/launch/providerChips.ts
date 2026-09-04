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

/*
 * ## Other launches, and what it does not promise (#194)
 *
 * This file used to hold `OTHER_NOT_LAUNCHABLE`, the refusal #168 ruled and
 * `docs/custom-launch-command.md` argued at length: a launched command of the
 * user's own writes no session store, every dwarf is read out of one, so a
 * custom process is one the poll can never find and the panel would sit in its
 * spawning state forever. The reasoning was sound and the conclusion was
 * reversed by the maintainer on 2026-09-04. The panel observes terminals AND is
 * a terminal itself: a process the panel HOLDS needs no session file to be
 * observed, because the panel is its stdio. The constant is gone rather than
 * softened, and the doc carries the reversal.
 *
 * So there is no refusal here for Other any more. What there is instead is a
 * shorter list of things it does not promise, and they are refusals main gives
 * with the command in hand rather than gates a chip can hold:
 *
 * - the command runs with NO shell, so pipes, redirects, chains and variables
 *   are refused by name rather than passed on as literal arguments;
 * - its dwarf has no transcript, so tier, subagents, model, tokens, blocked
 *   reasons and reactions are all absent — not pending, absent;
 * - stdio pipes, not a pty: a program that only draws a TUI produces escape
 *   sequences here rather than a screen. A real pty is the maintainer's
 *   explicit second step, with its own issue.
 *
 * `launchState.ts`'s rule survives all of this untouched, which is worth
 * noticing: `OTHER_CHOICE` is still not a `DwarfProvider`, because no
 * observation ever comes back saying 'other'. It comes back saying 'panel'.
 */

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
 *
 * Null for Other since #194 — see the block above. Every honest refusal for a
 * custom command needs the command, and main is where it is read.
 */
export function launchRefusal(
  providers: readonly AgentProviderOption[],
  chosen: LaunchChoice | null
): string | null {
  if (chosen === null) return null
  // Other has no chip-level refusal left (#194). What can go wrong with a
  // command is only knowable once there IS one — an unrunnable program, shell
  // syntax, a `.cmd` that cannot be spawned without a shell — and main answers
  // all of it with the string in hand. A refusal invented here would either
  // repeat a check main is about to make properly or refuse something that
  // works.
  if (chosen === OTHER_CHOICE) return null
  const entry = providers.find((option) => option.provider === chosen)
  if (entry === undefined || !entry.installed) return NOT_DETECTED
  if (entry.launchable) return null
  return entry.reason ?? NOT_DETECTED
}
