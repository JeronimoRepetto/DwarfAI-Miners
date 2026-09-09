/**
 * What the panel says when the folder somebody picked turns out to be a
 * worktree of a project (#348).
 *
 * Pure and framework-free, like `addProject.ts` under browse/: the dialog is a
 * shell around one sentence, and the sentence is the part worth holding to a
 * test — it names three things off the wire and has to stay grammatical when
 * one of them is missing.
 */
import type { DwarfWorkplace, MineWorktreeOf } from '../types'

/**
 * The folder's own name, as the dialog calls it.
 *
 * Both separators, because a path reaches this panel from whichever OS the app
 * is running on and main does not rewrite them. A path with no segment left —
 * a filesystem root — keeps its own characters rather than becoming a blank
 * where a folder belongs.
 */
export function worktreeFolderName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}

/**
 * The dialog's body: which folder was picked, which project it belongs to, and
 * where that folder currently stands.
 *
 * A branch when it has one, and the short commit when its HEAD is detached —
 * a sha is not a name anybody navigates by, but it is the only thing a
 * detached worktree can be told apart by, and saying nothing would leave the
 * person choosing between two folders with no way to tell which is which.
 * Neither, where HEAD said something this app does not recognise: the clause
 * is dropped rather than filled with a guess.
 */
export function worktreeQuestionBody(worktreeOf: MineWorktreeOf): string {
  const place =
    worktreeOf.branch !== undefined
      ? `, on branch ${worktreeOf.branch}`
      : worktreeOf.commit !== undefined
        ? `, at commit ${worktreeOf.commit}`
        : ''
  return (
    `${worktreeFolderName(worktreeOf.worktree)} is a worktree of ${worktreeOf.root}${place}. ` +
    "Its sessions already show up in that project's mine."
  )
}

/**
 * How the message panel's header names the worktree one dwarf is in (#348).
 *
 * The branch, because that is what a person running several agents on one
 * codebase is actually keeping apart; the FOLDER when the worktree's HEAD is
 * detached, because the wire carries no commit for a dwarf and a folder name
 * is a name somebody navigates by where a short sha is not.
 *
 * Empty for a dwarf with no workplace at all — which is most of them, and
 * means the mine's own folder. The header draws nothing rather than a
 * placeholder: an empty label beside a name would look like a fact that failed
 * to load.
 */
export function dwarfWorkplaceLabel(workplace: DwarfWorkplace | undefined): string {
  if (workplace === undefined) return ''
  return workplace.branch ?? worktreeFolderName(workplace.path)
}
