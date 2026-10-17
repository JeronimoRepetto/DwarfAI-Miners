// `CatalogMergeAdapter` (21 §3.1, A-36, steps 3a–4b): from 3a the renderer asks A-36 with the 14 shape
// (`{ refresh?: boolean }` → `IpcResult<SupplierEntryView[]>`) for every provider, and A-37 has no handler. While some
// providers' launchers are still today's, this adapter answers one entry per provider from the source its route
// qualifier names (21 §2 cut 3 common rules): the Host's `suppliers.launchable` entries (B-M37, relayed unchanged) for
// the moved providers, and today's launchable providers converted to `SupplierEntryView` for the others.
//
// - A legacy provider's entry is today's A-36 entry with `launchable: true` (an absent provider is not launchable, as
//   the Host's `launchable()` leaves one out, ADR-009 D5): its name is today's product name (`PRODUCT_NAME`), its
//   models and their efforts come from today's model catalog, read inside the adapter through `models` (a model's own
//   effort levels, else its catalog's), and its permission modes are the ones today's launch accepts for it
//   (`parseLaunchPermissionMode`). It is `publicLaunch: 'enabled'` (every build before cut 5 is internal, OQ-66) and
//   `answerChannel: 'available'` (today's runtime answers its asks: its held channel or `LegacyAskRelay`).
// - A Host entry of a provider not moved, and a legacy entry of a moved one, never reach the answer: one entry per
//   provider, never two.
// - The Host is asked only when some provider moved; its call error is the answer (14 §1.5). Today's provider list or
//   catalog that is not today's shape, or a throw, reads as empty: no entry, or an entry with no models.
//
// Composed only by `src/ui-main/index.ts` (R16) where a route of the table names it; deleted after 4b (later:
// ISSUE-240).
//
// Candidate decision (21 §6): no candidate exists; new code.
import {
  suppliersLaunchableParamsSchema,
  todayShapeOf,
  type IpcError,
  type IpcResult,
  type ModelOptionView,
  type ProviderId,
  type SupplierEntryView
} from '@dwarfai/contracts'
import { parseLaunchPermissionMode } from '../../main/domain/codexPermissions'
import { PRODUCT_NAME } from '../../main/domain/launchProviders'
import type { DwarfProvider } from '../../main/domain/types'
import { CODEX_PERMISSION_MODES } from '../../shared/contracts'
import type { HostClient } from '../../ui-main/window/ports/hostClient'

/** The name the route table lists and A-36's `legacy` + `target` route names (21 §3.1). */
export const CATALOG_MERGE_ADAPTER = 'CatalogMergeAdapter'

const PROVIDERS = 'agent:providers' // A-36
const MODELS = 'agent:models' // A-37: today's catalog

/** The row it converts (21 §3.1). */
export const CATALOG_MERGE_CHANNELS: readonly string[] = [PROVIDERS]

export interface CatalogMergeAdapterDeps {
  /** Today's runtime: its A-36 handler, today's shape. */
  legacy: { serve(channel: string, payload: unknown): Promise<unknown> }
  /** Today's model catalog (`AgentModelCatalogList`), read once per answer. */
  models: { read(): Promise<unknown> }
  /** The HostClient, for the moved providers' entries; absent when no Host is attached. */
  client: Pick<HostClient, 'call'> | undefined
  /** The providers whose A-36 route qualifier names the Host (21 §1 item 2). */
  movedProviders: ReadonlySet<string>
}

export interface CatalogMergeAdapter {
  serve(channel: string, payload: unknown): Promise<IpcResult<SupplierEntryView[]>>
}

interface TodayProvider {
  provider: DwarfProvider
  launchable: boolean
}
interface TodayCatalog {
  provider: string
  models: Array<{ value: string; label?: string; effortLevels?: string[] }>
  efforts: string[]
}

const TODAY_PROVIDERS = todayShapeOf(PROVIDERS)?.response
const TODAY_CATALOG = todayShapeOf(MODELS)?.response

function callError(code: IpcError['code'], message: string, retryable = false): IpcResult<never> {
  return { ok: false, error: { code, message, retryable } }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : { code: 'INTERNAL', message: 'the supplier relay failed', retryable: false }
}

/** `answer` parsed with `schema`, or `null`. */
function parsedOr<T>(
  answer: unknown,
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } } | undefined
): T | null {
  const parsed = schema?.safeParse(answer)
  return parsed?.success === true ? (parsed.data as T) : null
}

/** The permission modes today's launch accepts for `provider`. */
function todayModes(provider: DwarfProvider): string[] {
  return CODEX_PERMISSION_MODES.filter(
    (mode) => parseLaunchPermissionMode(provider, { permissionMode: mode }) !== null
  )
}

function legacyEntry(
  provider: DwarfProvider,
  catalog: TodayCatalog | undefined
): SupplierEntryView {
  const models: ModelOptionView[] = (catalog?.models ?? []).map((model) => ({
    value: model.value,
    ...(model.label === undefined ? {} : { label: model.label }),
    efforts: [...(model.effortLevels ?? catalog?.efforts ?? [])]
  }))
  const modes = todayModes(provider)
  return {
    providerId: provider as ProviderId,
    label: PRODUCT_NAME[provider],
    models,
    permissionModes: modes,
    offeredModes: [...modes],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }
}

export function createCatalogMergeAdapter(deps: CatalogMergeAdapterDeps): CatalogMergeAdapter {
  const { legacy, models, client, movedProviders } = deps

  async function hostEntries(params: {
    refresh?: boolean
  }): Promise<IpcResult<SupplierEntryView[]>> {
    if (movedProviders.size === 0) return { ok: true, value: [] }
    if (client === undefined) return callError('HOST_UNAVAILABLE', 'no Host is attached', true)
    try {
      const entries = await client.call('suppliers.launchable', params)
      return {
        ok: true,
        value: entries.filter((entry) => movedProviders.has(entry.providerId))
      }
    } catch (error: unknown) {
      return { ok: false, error: ipcErrorOf(error) }
    }
  }

  async function legacyEntries(): Promise<SupplierEntryView[]> {
    const list = parsedOr<{ providers: TodayProvider[] }>(
      await legacy.serve(PROVIDERS, undefined).catch(() => undefined),
      TODAY_PROVIDERS
    )
    const today = (list?.providers ?? []).filter(
      (entry) => entry.launchable && !movedProviders.has(entry.provider)
    )
    if (today.length === 0) return []
    const catalog = parsedOr<{ catalogs: TodayCatalog[] }>(
      await models.read().catch(() => undefined),
      TODAY_CATALOG
    )
    return today.map((entry) =>
      legacyEntry(
        entry.provider,
        catalog?.catalogs.find((item) => item.provider === entry.provider)
      )
    )
  }

  return {
    async serve(channel, payload) {
      if (channel !== PROVIDERS) return callError('METHOD_NOT_FOUND', `no route for ${channel}`)
      const params = suppliersLaunchableParamsSchema.safeParse(payload)
      if (!params.success) return callError('INVALID_PARAMS', 'the params do not match A-36')
      const [host, others] = await Promise.all([hostEntries(params.data), legacyEntries()])
      if (!host.ok) return host
      return { ok: true, value: [...host.value, ...others] }
    }
  }
}
