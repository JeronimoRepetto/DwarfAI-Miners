/*
 * What this build may show (ISSUE-267; ADR-034 item 2; BR-19; 21 §1 item 8, "hidden until built"): a
 * control whose destination is not built is absent — not disabled, not greyed, absent, taking no
 * space. The one source the nav, Settings and the Add panel read for it.
 *
 * Two inputs, neither written as a provider or a mode the renderer happens to know about:
 *
 * - The build's feature list, `SHIPPED_MODES`: the modes this build ships, build-time data
 *   (`builtModesOf` in contracts, 17 §1.9). A release build has the Panel alone until the Veta
 *   epic ships (ISSUE-294 adds Veta to the release list, ISSUE-311 Valle); the E2E build profile
 *   lists them earlier. Any Veta or Valle code stays unreachable in a release build because nothing
 *   here points at it (21 §7).
 * - The offered catalog main answers (A-36, `AgentProviderOption.launchable`): whether this build
 *   has a launch for a detected provider. A provider whose launch is not offered — Antigravity in
 *   a public build (20 §8 R-03), any provider whose driver is not built — is decided there and only
 *   read here, so no provider id is compared in the renderer (R12).
 */
import { builtModesOf, type UiPreferencesMap, type WindowMode } from '@dwarfai/contracts'
import type { AgentProviderOption } from '../../types'

/** A mode the window can show (06 §15), `hidden` aside. */
export type AppMode = Exclude<WindowMode, 'hidden'>
/** A side of the nav's mode lever: every mode but the Panel the lever sits in. */
export type LeverMode = Exclude<AppMode, 'panel'>
/** Settings › General "Mode at launch" (14 §3.9 `modeAtLaunch`). */
export type ModeAtLaunch = UiPreferencesMap['modeAtLaunch']

/** The build profile electron.vite.config.ts stamps from `DWARFAI_BUILD_PROFILE`; absent outside a build (tests). */
declare const __DWARFAI_BUILD_PROFILE__: string | undefined

/**
 * This build's feature list: the modes it ships, the one built-modes list UI main reads too (`builtModesOf`, 17
 * §1.9). A release build ships the Panel only until Veta ships (ADR-034); the E2E build profile lists Veta and Valle
 * so their L9 cases run.
 */
export const SHIPPED_MODES: readonly AppMode[] = builtModesOf(
  typeof __DWARFAI_BUILD_PROFILE__ === 'string' ? __DWARFAI_BUILD_PROFILE__ : undefined
)

/** The lever's sides, top to bottom as the design draws them: "▲ Valle", then "▼ Veta". */
const LEVER_ORDER: readonly LeverMode[] = ['valle', 'veta']
/** "Mode at launch"'s options after "Last used" and "Panel", in the order the modes ship. */
const LAUNCH_ORDER: readonly LeverMode[] = ['veta', 'valle']

/**
 * The lever's sides this build may draw; none means no lever at all. Between Veta and Valle the
 * lever is "▼ Veta" alone (ADR-034 item 2).
 */
export function leverModes(shipped: readonly AppMode[]): LeverMode[] {
  return LEVER_ORDER.filter((mode) => shipped.includes(mode))
}

/**
 * "Mode at launch"'s options; none means the row is not drawn. A choice between modes that do not
 * exist is a control that lies, so with the Panel alone there is no choice to offer.
 */
export function modeAtLaunchOptions(shipped: readonly AppMode[]): ModeAtLaunch[] {
  const others = LAUNCH_ORDER.filter((mode) => shipped.includes(mode))
  if (others.length === 0) return []
  return ['last-used', 'panel', ...others]
}

/**
 * The mode the app opens in from what is stored: `modeAtLaunch`, or `lastMode` when it says
 * "Last used" or nothing. A stored value naming a mode this build does not ship — written by a
 * later build, or by hand — resolves to the Panel (ADR-034 item 2).
 */
export function launchMode(
  stored: { lastMode?: AppMode; modeAtLaunch?: ModeAtLaunch },
  shipped: readonly AppMode[]
): AppMode {
  const named =
    stored.modeAtLaunch === undefined || stored.modeAtLaunch === 'last-used'
      ? stored.lastMode
      : stored.modeAtLaunch
  return named !== undefined && shipped.includes(named) ? named : 'panel'
}

/**
 * The providers this build offers to launch, in main's order: detected AND launchable (BR-19). The
 * Add panel's chips and Settings' default-provider select both read this, so a provider whose
 * launch is not offered is never a chip that is refused only once pressed.
 */
export function offeredProviders(providers: readonly AgentProviderOption[]): AgentProviderOption[] {
  return providers.filter((entry) => entry.installed && entry.launchable)
}
