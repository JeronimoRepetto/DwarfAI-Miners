import { SqliteWriteError } from '../adapters/sqliteWritable'
import type {
  Dwarf,
  DwarfNameRequest,
  DwarfNameResult,
  Mine,
  MineHistorySpeaker
} from '../domain/types'
import { customNameFor } from '../../shared/dwarfName'
import type { DwarfNameStore, PersistedDwarfName } from './dwarfNameStore'

/**
 * The names a person gave dwarfs, as main holds them (#635, decision log "Dwarf names").
 *
 * Main owns the names: it keeps them (DwarfNameStore), re-validates every write whatever the
 * renderer already did, and stamps them onto the board it publishes, so every window follows
 * through the existing push. A name is display only. `Dwarf.name` stays the provider's base name,
 * and it is the only name anything bound for a provider reads.
 *
 * NEVER LOGGED. A custom name is user data: no log line here carries one, raw or cleaned, nor the
 * error a write threw, whose message a driver is free to fill with the values it was bound.
 */

/**
 * Longest text a save may hand main, in UTF-16 code units. The field stops at 24 characters, and
 * even 24 characters each carrying a pile of combining marks fits well inside this; anything past
 * it is not a name the field could have sent, so it is refused rather than segmented.
 */
export const DWARF_NAME_INPUT_LIMIT = 1024

export const DWARF_NAME_NOT_ON_BOARD = 'This dwarf is no longer here, so its name cannot change.'
export const DWARF_NAME_NOT_SAVED = 'The name could not be saved.'
export const DWARF_NAME_TOO_LONG = 'That name is too long.'

/**
 * The `dwarf:setName` boundary's shape check: a dwarf id that is a non-empty string and a name
 * that is a string, rebuilt so nothing else crosses. What a name may hold is `cleanDwarfName`'s to
 * decide, later. A missing or non-string name is REFUSED, never read as a reset: only a real empty
 * string removes a custom name (screens/message.md), so a malformed call cannot erase one.
 */
export function parseDwarfNameRequest(payload: unknown): DwarfNameRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || record.dwarfId === '') return null
  if (typeof record.name !== 'string') return null
  return { dwarfId: record.dwarfId, name: record.name }
}

export interface DwarfNamesOptions {
  store: DwarfNameStore
  now: () => number
  /** One line, never a name. */
  warn: (message: string) => void
}

export class DwarfNames {
  private readonly names = new Map<string, PersistedDwarfName>()
  private loading: Promise<boolean> | null = null
  /** Writes land in the order they were asked for, so a quick rename then reset ends reset. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: DwarfNamesOptions) {}

  /**
   * Read the names kept by earlier runs, once. Resolves true when that put a name on any dwarf.
   * A store that will not answer costs this run its earlier names and nothing else: the dwarfs
   * show their base names, and a new name can still be given.
   */
  load(): Promise<boolean> {
    this.loading ??= this.options.store.list().then(
      (kept) => {
        for (const name of kept) {
          if (!this.names.has(name.dwarfId)) this.names.set(name.dwarfId, name)
        }
        return kept.length > 0
      },
      (error: unknown) => {
        this.options.warn(
          `[dwarfNames] Could not read the kept names (${failureOf(error)}); dwarfs show their base names`
        )
        return false
      }
    )
    return this.loading
  }

  /** The custom name kept for one dwarf id, or undefined when it shows its base name. */
  nameOf(dwarfId: string): string | undefined {
    return this.names.get(dwarfId)?.customName
  }

  /**
   * Save what the person left in the field for `dwarf`, whose `name` must be its base name as the
   * board holds it. The text is cleaned here (customNameFor); empty, or equal to the base name,
   * removes the custom name.
   */
  set(dwarf: Pick<Dwarf, 'id' | 'provider' | 'name'>, raw: string): Promise<DwarfNameResult> {
    if (raw.length > DWARF_NAME_INPUT_LIMIT) {
      return Promise.resolve({ saved: false, reason: DWARF_NAME_TOO_LONG })
    }
    return this.write(dwarf.id, () => {
      const next = customNameFor(raw, dwarf.name)
      return next === undefined
        ? undefined
        : {
            dwarfId: dwarf.id,
            provider: dwarf.provider,
            customName: next,
            setAt: this.options.now()
          }
    })
  }

  /** Take a dwarf's custom name away; it shows its base name again. */
  reset(dwarfId: string): Promise<DwarfNameResult> {
    return this.write(dwarfId, () => undefined)
  }

  private write(
    dwarfId: string,
    nextFor: () => PersistedDwarfName | undefined
  ): Promise<DwarfNameResult> {
    const done = this.writes.then(async (): Promise<DwarfNameResult> => {
      // A save never races the load: a name read after it would overwrite the one just given.
      await this.load()
      const next = nextFor()
      if (next?.customName === this.nameOf(dwarfId)) return savedAs(next?.customName)
      try {
        if (next === undefined) await this.options.store.remove(dwarfId)
        else await this.options.store.put(next)
      } catch (error) {
        this.options.warn(
          `[dwarfNames] Could not save a name for ${dwarfId} (${failureOf(error)}); it keeps the one it had`
        )
        return { saved: false, reason: DWARF_NAME_NOT_SAVED }
      }
      if (next === undefined) this.names.delete(dwarfId)
      else this.names.set(dwarfId, next)
      return savedAs(next?.customName)
    })
    // The chain never holds a rejection, so one write that threw cannot stop every later one.
    this.writes = done.catch(() => undefined)
    return done
  }
}

function savedAs(customName: string | undefined): DwarfNameResult {
  return customName === undefined ? { saved: true } : { saved: true, customName }
}

/** The kind of failure, never its message. */
function failureOf(error: unknown): string {
  return error instanceof SqliteWriteError ? error.failure : 'unexpected error'
}

/**
 * The board with each dwarf's custom name beside its base name, and none on a dwarf whose name was
 * reset. Hands back the very same array when no dwarf's name changed, which is how a caller knows
 * there is nothing to republish; an unchanged mine keeps its own object too.
 */
export function stampCustomNames(
  mines: Mine[],
  nameOf: (dwarfId: string) => string | undefined
): Mine[] {
  let changed = false
  const stamped = mines.map((mine) => {
    let mineChanged = false
    const dwarfs = mine.dwarfs.map((dwarf) => {
      const customName = nameOf(dwarf.id)
      if (customName === dwarf.customName) return dwarf
      mineChanged = true
      return withCustomName(dwarf, customName)
    })
    if (!mineChanged) return mine
    changed = true
    return { ...mine, dwarfs }
  })
  return changed ? stamped : mines
}

/** The mine history's speakers with their custom names, by the dwarf id each one shares. */
export function stampSpeakerNames(
  speakers: MineHistorySpeaker[],
  nameOf: (dwarfId: string) => string | undefined
): MineHistorySpeaker[] {
  return speakers.map((speaker) => withCustomName(speaker, nameOf(speaker.id)))
}

function withCustomName<T extends { customName?: string }>(
  named: T,
  customName: string | undefined
): T {
  if (customName !== undefined) return { ...named, customName }
  if (named.customName === undefined) return named
  const rest = { ...named }
  delete rest.customName
  return rest
}
