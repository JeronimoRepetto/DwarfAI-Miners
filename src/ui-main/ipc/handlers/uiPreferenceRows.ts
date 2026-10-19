// The handlers of the UI preference rows (14 §2.1 A-06, A-07, A-45, A-46, A-56, A-57; all KEEP, `ui-local`, owner
// `window`): a route target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and
// payload (ADR-019 items 7, 8; ISSUE-044) and arrives in today's shape. Each getter answers the stored value, each
// invoke setter the value it stored (ADR-024 item 9); A-57 is one-way and answers nothing. A-P6 is pushed by the use
// case to every mode window when A-46 stored a typography (`window/application/uiPreferences.ts`). The cut-0 switch
// (ISSUE-056) routes the rows here.
import type { IpcError } from '@dwarfai/contracts'
import type { StoredUiPreferences } from '../../window/application/uiPreferences'
import type { UiPreferenceStoreMap } from '../../window/ports/uiPreferenceStore'
import type { RouteTarget } from '../router'

/** The seam A rows this module serves, by registry key (today's wire name, for these KEEP rows). */
export const UI_PREFERENCE_ROWS = [
  'audio:preferences:get',
  'audio:preferences:set',
  'typography:preferences:get',
  'typography:preferences:set',
  'launch-view:get',
  'launch-view:set'
] as const

type UiPreferenceRow = (typeof UI_PREFERENCE_ROWS)[number]

export function createUiPreferenceRows(preferences: StoredUiPreferences): RouteTarget {
  const handlers: Record<UiPreferenceRow, (payload: unknown) => unknown> = {
    'audio:preferences:get': () => preferences.get('audio'),
    'audio:preferences:set': (p) => preferences.set('audio', p as UiPreferenceStoreMap['audio']),
    'typography:preferences:get': () => preferences.get('typography'),
    'typography:preferences:set': (p) =>
      preferences.set('typography', p as UiPreferenceStoreMap['typography']),
    'launch-view:get': () => preferences.get('launchView'),
    'launch-view:set': (p) => {
      preferences.set('launchView', p as UiPreferenceStoreMap['launchView'])
      return undefined
    }
  }
  const served: readonly string[] = UI_PREFERENCE_ROWS

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
      return Promise.resolve(handlers[channel as UiPreferenceRow](payload))
    }
  }
}
