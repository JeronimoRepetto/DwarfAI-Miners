// What the Host needs of the console viewer (ADR-031 item 2; 16 §8.1 "Console viewer"): the name
// of the script electron.vite.viewer.config.ts emits beside the Host entry `out/host/main.js`, and
// the one argument it takes besides its own path. The viewer itself is viewerMain.ts, which nothing
// but its own tests imports (.dependency-cruiser.cjs R6-viewer-entry-not-imported), as the relay's
// relayEntry.ts / relayMain.ts split does (ADR-013).
import { dirname, join } from 'node:path'

/** The viewer script's file name, beside `out/host/main.js`. */
export const VIEWER_ENTRY_FILE = 'dwarfai-viewer.js'

/** The viewer script's path for the Host entry at `hostEntryPath` (`…/out/host/main.js`). */
export function viewerEntryPath(hostEntryPath: string): string {
  return join(dirname(hostEntryPath), VIEWER_ENTRY_FILE)
}
