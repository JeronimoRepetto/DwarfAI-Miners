import type { DwarfProvider, FeedMessage, ProviderSnapshot } from '../domain/types'

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
}
