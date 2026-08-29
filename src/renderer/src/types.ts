/** Status of a single dwarf (one running agent process/session). */
export type DwarfStatus = 'digging' | 'idle' | 'resting'

/** One AI coding agent visualized as a dwarf at work. */
export interface Dwarf {
  id: string
  name: string
  status: DwarfStatus
  /** Unix ms timestamp of the last observed activity. */
  lastActivityAt: number
}

export function defaultDwarf(): Dwarf {
  return { id: '', name: 'Dwarf', status: 'idle', lastActivityAt: 0 }
}

/** One mine: an agent provider (Claude Code, Codex, ...) hosting zero or more dwarfs. */
export interface Mine {
  id: string
  provider: string
  label: string
  dwarfs: Dwarf[]
}

export function defaultMine(): Mine {
  return { id: '', provider: '', label: 'Mine', dwarfs: [] }
}

/** Root state for the mines store. */
export interface MinesState {
  mines: Mine[]
}

export function defaultMinesState(): MinesState {
  return { mines: [] }
}
