// R6-viewer-entry-not-imported (deviation 7 of .dependency-cruiser.cjs): nothing but the viewer's
// own tests imports its entry, not even the composition root.
import { viewer } from './modules/conversation/adapters/console/viewer/viewerMain'

export const host = viewer
