// The jev driven ports (16 §4.9, verbatim from 05 §3.9) and the request/response types they carry.
// Type-only (R2). The request and answer shapes are the domain's (the domain builds and reads them,
// R1), re-exported here under the port's names (16 §6.1-§6.3).
import type { SecretValue } from '../../../kernel/ports/secretReader'
import type { SupplierEntry } from '../../suppliers'
import type { JevRouteAnswers, JevRouteFallback } from '../domain/routeDecision'
import type { JevModelAnswers } from '../domain/routeModel'
import type { JevModelRequest, JevRouteRequest } from '../domain/routeRequest'

export type { JevModelRequest, JevRouteRequest }

/** 16 §6.3: Jev's raw first-request answers, or a fallback; never a concrete model or effort. */
export type JevRouteResponse = JevRouteAnswers | JevRouteFallback

/** 16 §6.3: Jev's raw second-request answers keyed by candidate index, or a fallback. */
export type JevModelResponse = JevModelAnswers | JevRouteFallback

// verbatim: 16 §4.9 (05 §3.9), the two driven ports and the key note; `prettier-ignore` keeps the bytes
// prettier-ignore
export interface JevRouter {                                   // driven: TypeSafe SDK; never throws (a failure is a fallback response)
  route(req: JevRouteRequest, key: SecretValue, opts?: { signal?: AbortSignal }): Promise<JevRouteResponse>              // provider, tier, triviality, context, effort score
  routeModel(req: JevModelRequest, key: SecretValue, opts?: { signal?: AbortSignal }): Promise<JevModelResponse>        // second request: the model among the tier's candidates, keyed by index (never model identity)
}
// prettier-ignore
export interface RoutingCatalogSource { launchable(): Promise<SupplierEntry[]> } // bridge → suppliers
// The Jev key is read through the kernel SecretReader (§3 kernel ports); a 'timeout' read is 'jev-unreachable'.
// end verbatim: 16 §4.9
