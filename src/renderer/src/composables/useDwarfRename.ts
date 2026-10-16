import type { DwarfNameRequest, DwarfNameResult } from '../types'
import { useMines } from './useMines'

/*
 * Whether a dwarf's name can be changed from the renderer today (BR-19; 21 §1 item 8, hidden until built).
 *
 * The rename rows `dwarf:setName` / `dwarf:resetName` stay `legacy` until the step-3a switch (ISSUE-001) routes their
 * Host successors A-N08 `renameDwarf` and A-N09 `resetDwarfName`, built by ISSUE-172 (14 §8 I-21; 21 §2 step 3a).
 * Today's runtime renames only the dwarfs on its own board, and `LegacyDwarfIdBridge` does not cover I-21, so a dwarf
 * the Host's board carries (its id a Host UUIDv7 since the cut-1 switch) has no destination that can rename it: its
 * Rename and Reset name are absent, never offered to fail. A board still fed by today's runtime keeps them.
 *
 * The Host board is the renderer's own read model (useMines, A-N01 / A-N02); its published `state.mines` is read so a
 * caller's computed follows every board change. ISSUE-001 deletes this gate with the rows it switches.
 *
 * The panel's two rename calls live here too (ADR-033 item 2; 05 §5.1 R13: `window.api` only in composables), passing
 * the today shapes of `dwarf:setName` / `dwarf:resetName` through unchanged.
 */
export function useDwarfRename() {
  const mines = useMines()
  return {
    canRename(dwarfId: string): boolean {
      void mines.state.mines
      return !mines.hostDwarfs().some((dwarf) => dwarf.id === dwarfId)
    },
    /** Save a custom name (I-21 `dwarf:setName`); main answers whether it was kept, and why not. */
    setName(request: DwarfNameRequest): Promise<DwarfNameResult> {
      return window.api.setDwarfName(request)
    },
    /** Back to the base name (I-21 `dwarf:resetName`), with the same verdict. */
    resetName(dwarfId: string): Promise<DwarfNameResult> {
      return window.api.resetDwarfName(dwarfId)
    }
  }
}
