// The built-modes list (17 §1.9 revised 2026-09-30; ADR-034 item 2; BR-19; 21 §1 item 8 "hidden until built"): the
// modes a build contains, as build-time data. Pure.
//
// The build picks its profile from `DWARFAI_BUILD_PROFILE` at build time (electron.vite.config.ts stamps it as
// `__DWARFAI_BUILD_PROFILE__`); UI main's mode windows (`BUILT_MODES`) and the renderer's controls (`SHIPPED_MODES`)
// both read this one list, so they never disagree.
//
// - `release`: what a person gets. A mode joins it only from the issue that ships it, in the same change as this
//   file's test: Veta joined with ISSUE-294, Valle with ISSUE-311; once Valle ships every mode is shown (ADR-034 item 2).
// - `e2e`: the E2E build profile, which listed Valle before it shipped so its L9 cases ran (17 §1.9). It lists every mode
//   now too, and stays where a later mode is listed first. No production test backdoor: nothing but the build decides.
// Any other value, or none, is `release` (fail closed).
import type { WindowMode } from './windowApi'

/** A mode a window shows (14 §3.9 `WindowMode` without `hidden`). */
export type BuiltMode = Exclude<WindowMode, 'hidden'>

/** The build profiles and the modes each contains. */
export const BUILD_PROFILES: Readonly<Record<'release' | 'e2e', readonly BuiltMode[]>> = {
  release: ['panel', 'veta', 'valle'],
  e2e: ['panel', 'veta', 'valle']
}

/** The modes a build of `profile` contains; an unknown or absent profile is a release build. */
export function builtModesOf(profile: string | undefined): readonly BuiltMode[] {
  return profile === 'e2e' ? BUILD_PROFILES.e2e : BUILD_PROFILES.release
}
