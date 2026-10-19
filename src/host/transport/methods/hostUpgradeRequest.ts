// B-M06 `host.upgrade.request` (14 §2.3, §3.4, §1.10; ADR-002 D5, D8 item 2; ADR-027 item 4; 07
// S12.13): a newer UI of the same generation, attached in compat mode, asks the Host to make way
// for the Host of its versioned copy. Only a `ui` connection may send it (roles.ts; a `notifier`
// gets FORBIDDEN); it is mutating, so a repeated `requestId` gets the first answer (ADR-003 item 6).
//
// - The `targetDir` rule (14 §1.10) runs inside the params schema, so a refused value is answered
//   INVALID_PARAMS by the dispatcher before the handler runs: the state does not change and no file
//   is written (the rule only reads: it resolves links). `targetDir` must be absolute, carry no
//   `..` segment, name a direct child of the ADR-002 D5 versioned-copy root called `targetVersion`,
//   and still be one after `realpath` (so a link out of the root is refused, as is a folder that
//   does not exist). A Host whose copy root cannot be named refuses every target.
// - Accepted: the Host enters `upgrade-pending` (`host.state` precedes the `res`, 14 §1.7) and
//   answers `{ state: 'upgrade-pending' }`; the drain starts only once that answer was written
//   (lifecycle/drain.ts), so the `res` always precedes `host.closing {reason:'upgrade'}`.
//
// The target itself is the UI's to start from (it spawns the new Host from its versioned copy once
// this Host has closed, ADR-002 D8 item 2): the Host never runs, copies or deletes it. Nothing here
// logs the path (14 §1.10 "names only").
import path from 'node:path'
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { Dispatcher } from '../dispatcher'
import type { UpgradeDrain } from '../lifecycle/drain'
import { METHOD_ROLES } from '../roles'

/** The 14 §1.10 rule for `host.upgrade.request.targetDir`, bound to this Host's copy root. */
export interface UpgradeTargetRule {
  accepts(target: { targetVersion: string; targetDir: string }): boolean
}

export interface UpgradeTargetRuleDeps {
  /** The ADR-002 D5 versioned-copy root (contracts `versionedCopyRoot`), or null when unknown. */
  root: string | null
  /** Resolves every link of an existing path; throws when it does not exist. */
  realpath: (target: string) => string
  /** The OS whose paths these are (host/platform/paths/versionedCopyRoot.ts reads it). */
  platform: 'win32' | 'darwin' | 'linux'
}

export function createUpgradeTargetRule(deps: UpgradeTargetRuleDeps): UpgradeTargetRule {
  const windows = deps.platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  // Windows compares paths without case, as its file systems do.
  const same = (a: string, b: string): boolean =>
    windows ? a.toLowerCase() === b.toLowerCase() : a === b
  const real = (target: string): string | null => {
    try {
      return deps.realpath(target)
    } catch {
      return null
    }
  }
  return {
    accepts({ targetVersion, targetDir }) {
      if (deps.root === null) return false
      if (!isFolderName(targetVersion)) return false
      if (!paths.isAbsolute(targetDir)) return false
      if (targetDir.split(/[\\/]/).includes('..')) return false
      const named = paths.normalize(targetDir)
      if (!same(paths.dirname(named), paths.normalize(deps.root))) return false
      if (!same(paths.basename(named), targetVersion)) return false
      const realRoot = real(deps.root)
      const realTarget = real(named)
      if (realRoot === null || realTarget === null) return false
      return (
        same(paths.dirname(realTarget), realRoot) && same(paths.basename(realTarget), targetVersion)
      )
    }
  }
}

export interface HostUpgradeRequestDeps {
  drain: UpgradeDrain
  target: UpgradeTargetRule
}

/** Serves `host.upgrade.request` on `dispatcher`. */
export function registerHostUpgradeRequest(
  dispatcher: Dispatcher,
  deps: HostUpgradeRequestDeps
): void {
  const paramsSchema = HOST_METHOD_SCHEMAS['host.upgrade.request'].params.refine((params) =>
    deps.target.accepts(params)
  )
  dispatcher.registerMutating(
    'host.upgrade.request',
    paramsSchema,
    METHOD_ROLES['host.upgrade.request'] ?? [],
    (_params, context): HostMethods['host.upgrade.request']['result'] => {
      deps.drain.enter(context.requestId)
      context.afterAnswer(() => deps.drain.start())
      return { state: 'upgrade-pending' }
    }
  )
}

/** One folder name: not empty, no separator, not `.` or `..`. */
function isFolderName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
}
