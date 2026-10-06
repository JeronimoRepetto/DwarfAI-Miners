// The snapshot's `dwarfs` section (14 §4.1, frozen; ADR-003 item 7): the present crew of every
// mine on the board as `DwarfWire` — `resuming` and `unrecovered` dwarfs included, a departed one
// never — read from the mines and crew public queries within the one event-loop turn the snapshot
// is built in (14 §4.2). `ui` only. Registered before the boot binds the endpoint by host/wiring/routes/crew.ts
// (ISSUE-094), forwarding to the modules boot step 4 wires, it is advertised as `section:dwarfs`
// in every `hello.ok` (14 §4.4). Live updates:
// `dwarf.arrived`, `dwarf.changed`, `dwarf.departed` (frames/board.ts).
//
// A dwarf absent from a later snapshot disappears without a walk-out in the UI: `dwarf.departed`
// is the only walk-out trigger (14 §4.3 rule 6), so nothing here marks a departure.
//
// Order: the mines in board order (sections/mines.ts), each mine's crew in `crewOf` order.
import type { CrewQueries } from '../../../modules/crew'
import type { MinesQueries } from '../../../modules/mines'
import { toDwarfWire } from '../../mappers/wire'
import type { SectionProvider, SectionRegistry } from '../sectionRegistry'

export interface DwarfsSectionDeps {
  mines: Pick<MinesQueries, 'list'>
  crew: Pick<CrewQueries, 'crewOf'>
}

/** The `dwarfs` provider over `deps`. */
export function dwarfsSection(deps: DwarfsSectionDeps): SectionProvider<'dwarfs'> {
  return () =>
    deps.mines
      .list({ sortBy: 'name', direction: 'asc' })
      .flatMap((mine) => deps.crew.crewOf(mine.mineId))
      .filter((dwarf) => !dwarf.departed)
      .map((dwarf) => toDwarfWire(dwarf))
}

/** Registers the `dwarfs` section (`ui` only), so it is advertised as `section:dwarfs`. */
export function registerDwarfsSection(sections: SectionRegistry, deps: DwarfsSectionDeps): void {
  sections.registerSection('dwarfs', ['ui'], dwarfsSection(deps))
}
