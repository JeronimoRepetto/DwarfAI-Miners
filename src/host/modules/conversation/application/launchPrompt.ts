// The launch prompt as the dwarf's first message (08 §0 `DwarfLaunched` → conversation `ingest`;
// US-LAUNCH-005.AC07): conversation owns the entry's key, so that it knows the entry again at ingest
// and merges the driver's echo of the same prompt into it (INV-60; GitHub #1430). The key is
// DwarfAI's own (`dwarfai:`), one per launch, so a repeated route inserts once (ADR-006).
import type { LaunchId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'

const PREFIX = 'dwarfai:launch:'
const SUFFIX = ':prompt'

/** The person's entry of a launch's prompt, ingested from the live stream when the dwarf launched. */
export function launchPromptEntry(launchId: LaunchId, prompt: string): ConversationEntry {
  return {
    sourceKey: `${PREFIX}${launchId}${SUFFIX}`,
    role: 'person',
    text: prompt,
    providerTime: null
  }
}

/** The launch whose prompt `entry` is, or null for any other entry. */
export function launchOfPrompt(entry: ConversationEntry): LaunchId | null {
  const { sourceKey } = entry
  if (entry.role !== 'person' || !sourceKey.startsWith(PREFIX) || !sourceKey.endsWith(SUFFIX)) {
    return null
  }
  const launchId = sourceKey.slice(PREFIX.length, sourceKey.length - SUFFIX.length)
  return launchId === '' ? null : (launchId as LaunchId)
}
