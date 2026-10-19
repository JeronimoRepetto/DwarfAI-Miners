// ISSUE-240 (TC-240-03): `PerProviderShapeAdapter`, `CatalogMergeAdapter` and `LegacyLaunchObservation` left the tree
// with the 4b deletion. Only the composition roots may import src/legacy-bridge, so an import of a deleted adapter's
// path from anywhere else fails lint (R16).
import { createCatalogMergeAdapter } from '../../legacy-bridge/shape/CatalogMergeAdapter'

export const host = createCatalogMergeAdapter
