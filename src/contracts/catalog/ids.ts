// Re-exports the catalog provider ids of `ids.mjs` (05 §2.1): one source of data, typed by `ids.d.mts`.
import { CATALOG_PROVIDER_IDS } from './ids.mjs'

export { CATALOG_PROVIDER_IDS }

/** A provider id the catalog lists: an open string, never a closed enum (ADR-009 D2, BR-10, INV-40). */
export type CatalogProviderId = (typeof CATALOG_PROVIDER_IDS)[number]
