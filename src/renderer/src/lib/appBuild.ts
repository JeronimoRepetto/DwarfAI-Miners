import type { AppBuild } from '../types'

/**
 * The running version as the titlebar prints it (issue #79).
 *
 * Bare for an installed build, because the bug-report template asks for the
 * version "from the installer filename" and that is the string it wants — what
 * the panel shows goes straight into the field, with nothing to convert.
 *
 * The `-dev` suffix is the whole reason this is a function and not an
 * interpolation. An installed build and one started from the checkout report
 * the SAME version, so the number alone looks like an answer while settling
 * nothing, and that is exactly how the wrong build got diagnosed. A suffix
 * rather than a badge because a monitor's titlebar has no room for a second
 * element and nothing here may compete with the mine for attention.
 */
export function versionLabel(build: AppBuild): string {
  return build.packaged ? build.version : `${build.version}-dev`
}

/**
 * The hover line, where those five characters are spelled out in words. Same
 * treatment the pin and the gear already get: the quiet mark on screen, the
 * sentence behind it that makes the mark actionable.
 */
export function versionTitle(build: AppBuild): string {
  return build.packaged
    ? `Version ${build.version} (installed)`
    : `Version ${build.version} (development build, run from a checkout)`
}
