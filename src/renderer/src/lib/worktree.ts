/**
 * What the panel says when the folder somebody picked turns out to be a
 * worktree of a project (#348).
 *
 * Pure and framework-free, like `addProject.ts` under browse/: the dialog is a
 * shell around its words, and the words are the part worth holding to a test —
 * they name the folder and the mine off the wire.
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
 * The worktree dialog's three lines (#348), the words of the story (US-MINES-004.AC07, PO decision
 * 2026-09-28 #41; the design has no component of its own for this dialog, so the story's copy is
 * the source): the title names the folder picked and the mine it belongs to, the body says where
 * its dwarfs will work, and the primary action adds that mine.
 *
 * The mine is named the way the Host names a mine it declares: the last segment of its main
 * working tree's path (mines/application/declare.ts). The wire carries that path and no name, and
 * the main tree may have no mine yet; both cases read the same name.
 */
export function worktreeMineName(worktreeOf: MineWorktreeOf): string {
  return worktreeFolderName(worktreeOf.root)
}

/** "<folder> is a worktree of <mine>". */
export function worktreeQuestionTitle(worktreeOf: MineWorktreeOf): string {
  return `${worktreeFolderName(worktreeOf.worktree)} is a worktree of ${worktreeMineName(worktreeOf)}`
}

/** "Its dwarfs will work in <mine>.": the same whatever the worktree's HEAD says. */
export function worktreeQuestionBody(worktreeOf: MineWorktreeOf): string {
  return `Its dwarfs will work in ${worktreeMineName(worktreeOf)}.`
}

/** The primary action, "Add <mine>". */
export function worktreeQuestionAccept(worktreeOf: MineWorktreeOf): string {
  return `Add ${worktreeMineName(worktreeOf)}`
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
