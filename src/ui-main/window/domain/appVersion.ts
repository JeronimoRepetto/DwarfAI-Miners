// App versions as the build stamps them (`package.json` `version`, SemVer 2.0.0). Pure: the Host launcher orders its
// versioned copies by them (ADR-027 item 2; hostLauncher/versionedCopyGc.ts), and the second-launch use case asks
// whether a launch is of a newer build than the running instance (AMENDMENT-25; window/application/secondLaunch.ts).

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** SemVer precedence; a name that is not a version sorts below every version, by its characters. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (left === null || right === null) {
    if (left !== null) return 1
    if (right !== null) return -1
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (let part = 1; part <= 3; part += 1) {
    const diff = Number(left[part]) - Number(right[part])
    if (diff !== 0) return Math.sign(diff)
  }
  return comparePrerelease(left[4], right[4])
}

/**
 * Whether a launch of version `launched` is of a newer build than the running `running` (AMENDMENT-25). Only a
 * well-formed version can be newer: a launch that carries none, or one that is not a version, never is.
 */
export function isNewerAppVersion(launched: string | undefined, running: string): boolean {
  return launched !== undefined && VERSION.test(launched) && compareVersions(launched, running) > 0
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  // A release is newer than any of its prereleases.
  if (a === undefined) return 1
  if (b === undefined) return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y))
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}
