// The provider-qualified rows of a step-3 table as the root composes them (ISSUE-188; the worlds of the 3b and 3d router
// cases, shared): the Host's handlers over a recording HostClient whose board holds the given dwarfs, the provider
// qualifiers, and the router on an `ipcMain` stand-in. Test-only (R14): production never imports it. AMENDED for
// ISSUE-240, the 4b deletion (was: also the shape adapters over a recording today's runtime): `PerProviderShapeAdapter`
// and `CatalogMergeAdapter` left the tree, so a route that names a shape adapter is not composed here.
import type { SnapshotPage, StepId } from '@dwarfai/contracts'
import {
  composeConversationAndLaunchRows,
  composeProviderRouting,
  composeStopDwarf
} from '../../index'
import type { HostEvent } from '../../window/ports/hostClient'
import type { ChannelRoute } from '../channelRoute'
import { composeRouteTargets } from '../composeRouteTargets'
import { createRouter } from '../router'

export const WORLD_APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const FROM_PANEL = { sender: { id: 7 }, senderFrame: { url: WORLD_APP_ENTRY } }
const SENDERS = { appEntry: WORLD_APP_ENTRY, isModeWindow: (id: number) => id === 7 }
export const WORLD_MINE = '01920000-0000-7000-8000-000000000601'
/** The LaunchId the deleted `PerProviderShapeAdapter` minted for a launch it handed to today's runtime. */
export const WORLD_MINTED = '01920000-0000-7000-8000-0000000006a1'

/** A present Host dwarf of `providerId` (14 §3.6 `DwarfWire`). */
export function dwarfWire(id: string, providerId: string, owned: boolean) {
  return {
    id,
    mineId: WORLD_MINE,
    providerId,
    baseName: 'Nori',
    customName: null,
    rank: 'foreman',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned,
    arrivedAt: 1_700_000_000_600
  }
}

/** A `SupplierEntryView` (14 §3.6) as the Host's `suppliers.launchable` answers it. */
export function hostEntry(providerId: string, publicLaunch: 'enabled' | 'gated' = 'enabled') {
  return {
    providerId,
    label: providerId,
    models: [{ value: 'default', efforts: ['high'] }],
    permissionModes: ['default'],
    offeredModes: ['default'],
    installed: true,
    publicLaunch,
    answerChannel: 'available'
  }
}

export interface ProviderRowsWorldOptions {
  table: readonly ChannelRoute[]
  release: StepId
  /** The dwarfs on the Host board (`dwarfWire`). */
  dwarfs: readonly unknown[]
  /** The Host's answer to each method the rows relay. */
  hostReplies: Record<string, unknown>
  /** Today's runtime's answer to each row it serves. */
  today: Record<string, unknown>
}

export function providerRowsWorld(options: ProviderRowsWorldOptions) {
  const { table, release, dwarfs, hostReplies, today } = options
  const hostCalls: Array<[string, unknown]> = []
  const legacyServed: Array<[string, unknown]> = []
  const client = {
    call: (method: string, params: unknown) => {
      if (method !== 'strangler.dwarfIdentities') hostCalls.push([method, params])
      return Promise.resolve(method === 'strangler.dwarfIdentities' ? [] : hostReplies[method])
    },
    subscribe: (handler: (event: HostEvent) => void) => {
      handler({
        kind: 'snapshot',
        snapshot: {
          seq: 1,
          chunks: [{ section: 'dwarfs', data: dwarfs }]
        } as unknown as SnapshotPage
      })
      return () => {}
    }
  }
  const legacy = {
    serve: (channel: string, payload: unknown) => {
      legacyServed.push([channel, payload])
      return Promise.resolve(today[channel])
    }
  }
  const typedClient = client as unknown as Parameters<
    typeof composeConversationAndLaunchRows
  >[0]['client']
  const rows = composeConversationAndLaunchRows({
    routes: table,
    client: typedClient,
    consoles: { raiseConsole: () => Promise.resolve('raised') }
  })
  const stop = composeStopDwarf({
    routes: table,
    release,
    client: client as unknown as Parameters<typeof composeStopDwarf>[0]['client'],
    legacy: {
      liveLaunches: () => Promise.resolve([]),
      endLaunch: () => Promise.resolve('ended'),
      launchIdOfDwarf: () => undefined
    },
    bridge: { toLegacy: () => Promise.resolve(null) }
  })
  const routing = composeProviderRouting({
    routes: table,
    client: client as unknown as Parameters<typeof composeProviderRouting>[0]['client']
  })
  const parts = [rows, stop?.part].filter(
    (part): part is NonNullable<typeof part> => part !== undefined
  )
  const handlers = new Map<string, (event: typeof FROM_PANEL, payload: unknown) => unknown>()
  createRouter({
    routes: table.filter((r) => r.shapeAdapter === undefined),
    legacy,
    host: composeRouteTargets(parts),
    uiLocal: { serve: () => Promise.reject(new Error('no ui-local row under test')) },
    qualifiers: routing.qualifiers,
    senders: SENDERS
  }).register({
    handle: (wire, listener) => void handlers.set(wire, listener),
    on: (wire, listener) => void handlers.set(wire, listener)
  })
  const invoke = (wire: string, payload: unknown) => {
    const listener = handlers.get(wire)
    if (listener === undefined) throw new Error(`no listener for ${wire}`)
    return listener(FROM_PANEL, payload)
  }
  const dispose = () => {
    stop?.dispose()
    routing.dispose()
  }
  return { invoke, hostCalls, legacyServed, dispose }
}
