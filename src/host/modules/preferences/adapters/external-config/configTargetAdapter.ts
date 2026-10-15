// The per-target half of the one config writer (ADR-016 item 6; 16 §7.1, §7.5): what a target
// knows about its own file format. The engine (`configWriterEngine.ts`) owns every file I/O, the
// backup, the atomic write, the re-read, the read-back and the ledger; a target adapter only
// parses and renders bytes, so it is pure and testable without a disk. Internal to the
// preferences adapters: `ClaudeHooksConfigWriter` (ISSUE-220) and `OpenCodePluginConfigWriter`
// (ISSUE-227) implement it.
import type { ChannelToken, ConfigTarget } from '../../ports/externalConfigWriter'

/** What the ownership probe found in DwarfAI's slot of the file (ADR-016 item 6.2). */
export type OwnershipProbe =
  /** No entry of DwarfAI's there: it may be written. */
  | 'absent'
  /** DwarfAI's own entry, matched by the exact ownership probe: it may be replaced or removed. */
  | 'owned'
  /** Something DwarfAI did not write holds the slot (a file DwarfAI did not create): never touched. */
  | 'foreign'

/** What a render replaces: an enable also replaces an old-app entry (AMENDMENT-7), a rewrite does not. */
export type RenderScope = 'with-old-app' | 'owned-only'

export interface ConfigTargetAdapter<D> {
  readonly target: ConfigTarget
  /** The file DwarfAI writes into (16 §7.1), absolute. */
  readonly path: string
  /** `config_writes.owned_marker`: the ownership probe's needle (the hook command prefix, the header). */
  readonly ownedMarker: string
  /**
   * Step 1: parses the file preserving unknown content (`null` = the file does not exist);
   * `malformed` when it cannot be parsed, and then nothing is written (13 FM-127).
   */
  read(bytes: Uint8Array | null): { ok: true; value: D } | { ok: false; error: 'malformed' }
  /** Step 2: the exact ownership probe. */
  probeOwned(doc: D): OwnershipProbe
  /** The legacy probe (16 §7.1, AMENDMENT-7): the exact entry the old app wrote is there. */
  probeLegacy(doc: D): boolean
  /**
   * The file's next bytes with DwarfAI's entry carrying `token`, an old-app entry replaced, and
   * every foreign byte identical. Called only after `probeOwned` returned `absent` or `owned`.
   * `owned-only` (07 S14.10, a rewrite onto a new ingress port): an old-app entry is kept as it is,
   * since only a consent replaces it (16 §7.1 "Old-app entries"; ADR-016 item 5).
   */
  render(doc: D, token: ChannelToken, scope?: RenderScope): Uint8Array
  /**
   * Whether DwarfAI's own entry, found by `probeOwned`, is what `render` would write now apart from
   * its token: for `claude-hooks`, whether it names the persisted ingress port (07 S14.10,
   * ADR-016 item 3). A target without anything that moves leaves it out, and its entry is current.
   */
  isCurrent?(doc: D): boolean
  /**
   * The file's bytes without DwarfAI's entry or an old-app entry, every foreign byte identical;
   * `null` when the file was DwarfAI's alone and is deleted.
   */
  removeOwned(doc: D): Uint8Array | null
}
