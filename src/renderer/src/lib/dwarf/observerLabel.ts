import { isPanelObserved, type DwarfObserver } from '../../types'

/**
 * What to CALL the thing that observed a dwarf, on screen (#194).
 *
 * A provider is called by its own name, which is what the tooltip and the
 * sprite's label have always shown. The panel-held case needs a translation,
 * and only one word of it: the wire value is `'panel'`, which names the
 * observer precisely and reads wrongly in a label — a person looking at a
 * dwarf wants to know what it IS, and "panel" describes who is watching it.
 *
 * Pure and in `lib/` rather than inline in the two components that need it, for
 * the reason every other piece of copy here lives outside a template: two
 * spellings of the same word is how a tooltip and an aria-label come to
 * disagree about the same dwarf.
 */

/** The one word a process this panel is holding is called. */
export const HOSTED_OBSERVER_LABEL = 'hosted'

export function observerLabel(observer: DwarfObserver): string {
  return isPanelObserved(observer) ? HOSTED_OBSERVER_LABEL : observer
}
