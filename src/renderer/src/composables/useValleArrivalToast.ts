/*
 * The "started in" toast in Valle (07 S39.11; US-VETA-007.AC05, Valle's half; PO #48; BR-23; ISSUE-299): an observed
 * arrival (a `dwarf.arrived` frame the Host announces) in a known mine that is not on screen in Valle raises the
 * window's one toast, in the Panel's own words: "<dwarf> started in <mine>" (copy template `{d} started in {name}`,
 * PO decision 2026-09-28 #48, as `useMines` raises it in the Panel). A mine on screen shows the arrival itself; a
 * (re-)snapshot is no arrival (S34.12); a hidden Valle raises nothing.
 *
 * The facts, the on-screen set and the toast are injected (the house idiom over `vi.mock`); the root hands it the
 * window's one toast queue (`useToasts`, BR-23).
 */
import type { DwarfWire, MineId, MineWire } from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, type Ref } from 'vue'
import type { ValleReadModel } from '../lib/valle/valleReadModel'

export interface ValleArrivalToastDeps {
  /** The window's read model: its observed facts, and the mines it knows. */
  facts: Pick<ValleReadModel, 'onFacts'> & { mines: Readonly<Ref<readonly MineWire[]>> }
  /** The mines on screen in Valle now (S39.05). */
  onScreen(): readonly MineId[]
  /** Whether Valle is the shown mode window. */
  shown(): boolean
  /** The window's one toast (BR-23). */
  showToast(text: string): void
}

/** The toast of an announced arrival (copy template `{d} started in {name}`; PO decision 2026-09-28 #48). */
export function startedIn(dwarf: DwarfWire, mine: MineWire): string {
  return `${dwarf.customName ?? dwarf.baseName} started in ${mine.name}`
}

export function useValleArrivalToast(deps: ValleArrivalToastDeps): void {
  const stop = deps.facts.onFacts((facts) => {
    if (!deps.shown()) return
    for (const fact of facts) {
      if (fact.kind !== 'arrived' || !fact.announce) continue
      if (deps.onScreen().includes(fact.dwarf.mineId)) continue
      const mine = deps.facts.mines.value.find((known) => known.id === fact.dwarf.mineId)
      if (mine !== undefined) deps.showToast(startedIn(fact.dwarf, mine))
    }
  })
  if (getCurrentScope() !== undefined) onScopeDispose(stop)
}
