import type { DwarfProvider, FeedMessage, ProviderSnapshot } from '../domain/types'
import type { TextDeliveryTarget } from '../textDelivery/port'

/**
 * Port implemented by every AI CLI detector. scan() returns one snapshot per
 * live session; feed() is the click-to-focus fallback (recent transcript
 * messages for a dwarf discovered by the latest scan).
 */
export interface Provider {
  readonly kind: DwarfProvider
  scan(): Promise<ProviderSnapshot[]>
  /** Last `limit` messages of the dwarf's transcript; null for unknown ids. */
  feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null>
  /**
   * Path to the file backing feed(), used to open a terminal that tails the
   * transcript live when no window can be focused. Undefined for unknown ids.
   */
  transcriptPath?(dwarfId: string): string | undefined
  /**
   * Capability surface: how a typed message could reach this dwarf's live
   * session right now, or null when no channel exists (unknown id, or a
   * session type with no way in). Answered from data the latest scan already
   * read, so it stays a synchronous map lookup — the panel asks for every
   * dwarf on every poll to decide what actions to offer.
   */
  textDelivery?(dwarfId: string): TextDeliveryTarget | null
}
