// The snapshot section providers (14 §4.1, §4.4, frozen): each section the Host serves is registered
// once with the roles that may read it and the provider that builds its data. A registered name is
// advertised in `hello.ok.capabilities` as `section:<name>` (ISSUE-023 capabilities.ts), and only a
// registered name may be requested (INVALID_PARAMS otherwise, 14 §4.4).
//
// At cut 0 only the Host's own `meta` is registered (host/wiring/hostDispatcher.ts); each module
// section joins with its module, from the composition root (later: EPIC-05, EPIC-06, EPIC-08,
// EPIC-10, EPIC-13).
//
// A provider is synchronous by type: it returns its section's data, never a promise, because the
// whole snapshot is built within one event-loop turn at one `seq` (14 §4.2). It never puts a
// secret, a token, a draft or a raw provider payload in its data (14 §4.1).
import type { SnapshotSection, SnapshotSectionData } from '@dwarfai/contracts'
import type { ChannelRole } from '../roles'

/** Builds one section's data, synchronously, from the Host's state right now. */
export type SectionProvider<S extends SnapshotSection> = () => SnapshotSectionData<S>

export interface RegisteredSection {
  readonly name: SnapshotSection
  readonly roles: readonly ChannelRole[]
  readonly provider: () => unknown
}

/**
 * 14 §4.2: the fixed chunk order — `meta`, `preferences`, `mines`, `dwarfs`, `asks`, `launches`,
 * `recovery`, then `tails` and `marks` interleaved per dwarf — so a UI paints the board before the
 * chats arrive. The notifier's names sections follow the board sections they name (`mine-names`
 * after `mines`, `dwarf-names` after `dwarfs`'s place); a notifier reads nothing else.
 */
export const SNAPSHOT_CHUNK_ORDER: readonly SnapshotSection[] = Object.freeze([
  'meta',
  'preferences',
  'mines',
  'dwarfs',
  'mine-names',
  'dwarf-names',
  'asks',
  'launches',
  'recovery',
  'tails',
  'marks'
])

export class SectionRegistry {
  private readonly sections = new Map<SnapshotSection, RegisteredSection>()

  /** Registers `name`; registering one name twice is a wiring defect and throws. */
  registerSection<S extends SnapshotSection>(
    name: S,
    roles: readonly ChannelRole[],
    provider: SectionProvider<S>
  ): void {
    if (this.sections.has(name)) throw new Error(`snapshot section registered twice: ${name}`)
    this.sections.set(name, { name, roles: [...roles], provider })
  }

  /** Every registered name, for `hello.ok.capabilities`. */
  names(): SnapshotSection[] {
    return [...this.sections.keys()]
  }

  /** The registered section `name`, or undefined when no provider serves it. */
  get(name: string): RegisteredSection | undefined {
    return this.sections.get(name as SnapshotSection)
  }
}
