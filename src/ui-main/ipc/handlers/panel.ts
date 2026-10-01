// The handlers of the Panel window rows (14 §2.1 A-01…A-05, A-08, A-09; all KEEP, `ui-local`, owner `window`): a route
// target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload
// (ADR-019 items 7, 8; ISSUE-044) and arrives in today's shape. A-01 and A-02 are one-way and answer nothing; A-04
// answers the always-on-top it stored and A-09 the layout the window really took (ADR-024 item 9). A-P1 is pushed by
// the use case to the Panel window on every change of its visibility (`window/application/panelWindow.ts`). A-05 also
// feeds the `PresenceTracker` (later: EPIC-07 ISSUE-111). The rows stay `legacy` in the route table until the cut-0
// switch (ISSUE-056) routes them here.
import type { IpcError } from '@dwarfai/contracts'
import type { PanelWindowUseCases } from '../../window/application/panelWindow'
import type { PanelLayoutRequest } from '../../window/ports/panelWindowController'
import type { RouteTarget } from '../router'

/** The seam A rows this module serves, by registry key (today's wire name, for these KEEP rows). */
export const PANEL_ROWS = [
  'panel:hide',
  'panel:raise',
  'panel:getAlwaysOnTop',
  'panel:setAlwaysOnTop',
  'panel:visible:get',
  'panel:layout:get',
  'panel:layout:set'
] as const

type PanelRow = (typeof PANEL_ROWS)[number]

export function createPanelRows(panel: PanelWindowUseCases): RouteTarget {
  const handlers: Record<PanelRow, (payload: unknown) => unknown> = {
    'panel:hide': () => {
      panel.hide()
      return undefined
    },
    'panel:raise': () => {
      panel.raise()
      return undefined
    },
    'panel:getAlwaysOnTop': () => panel.alwaysOnTop(),
    'panel:setAlwaysOnTop': (p) => panel.setAlwaysOnTop(p as boolean),
    'panel:visible:get': () => panel.visible(),
    'panel:layout:get': () => panel.layout(),
    'panel:layout:set': (p) => panel.setLayout(p as PanelLayoutRequest)
  }
  const served: readonly string[] = PANEL_ROWS

  return {
    serve(channel, payload) {
      if (!served.includes(channel)) {
        // Another `ui-local` row: not this module's, so refused, never guessed (14 §1.5).
        const error: IpcError = {
          code: 'METHOD_NOT_FOUND',
          message: `no ui-local handler for ${channel}`,
          retryable: false
        }
        return Promise.resolve({ ok: false, error })
      }
      return Promise.resolve(handlers[channel as PanelRow](payload))
    }
  }
}
