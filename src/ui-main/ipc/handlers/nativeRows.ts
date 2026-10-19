// The handlers of the native rows (14 §2.1 A-21 `openExternalLink`, A-22 `copyText`, A-24 `chooseDwarfAttachments`,
// A-28 `getAppBuild`, A-29 `getFeatureFlags`; all KEEP, `ui-local`, owner `window`): a route target of the router
// (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload (ADR-019 items 7, 8;
// ISSUE-044), and arrives in today's shape. Each answers today's shape (ADR-033 item 6). A-X1 `pathForDroppedFile` has
// no handler: it is the preload's own helper (`PRELOAD_HELPERS`), and the paths it and A-24 yield reach the Host only
// through A-25 and A-23, which re-validate them (14 §1.10; ADR-019 item 9). The cut-0 switch (ISSUE-056) routes the
// rows here.
import type { IpcError } from '@dwarfai/contracts'
import type { AppInfo } from '../../window/application/appInfo'
import type { ServedNativeActions } from '../../window/application/nativeActions'
import type { RouteTarget } from '../router'

/** The seam A rows this module serves, by registry key (today's wire name, for these KEEP rows). */
export const NATIVE_ROWS = [
  'shell:openExternalLink',
  'shell:copyText',
  'dwarf:attachments:choose',
  'app:build',
  'app:features'
] as const

type NativeRow = (typeof NATIVE_ROWS)[number]

export interface NativeRowsDeps {
  actions: ServedNativeActions
  appInfo: AppInfo
}

export function createNativeRows({ actions, appInfo }: NativeRowsDeps): RouteTarget {
  // The gate parsed every payload with the row's schema: A-21 and A-22 receive a string, the others nothing.
  const handlers: Record<NativeRow, (payload: unknown) => unknown> = {
    'shell:openExternalLink': (url) => actions.openExternal(url as string),
    'shell:copyText': (text) => actions.copyText(text as string),
    'dwarf:attachments:choose': () => actions.chooseAttachments(),
    'app:build': () => appInfo.build(),
    'app:features': () => appInfo.featureFlags()
  }
  const served: readonly string[] = NATIVE_ROWS

  return {
    async serve(channel, payload) {
      if (!served.includes(channel)) {
        // Another `ui-local` row: not this module's, so refused, never guessed (14 §1.5).
        const error: IpcError = {
          code: 'METHOD_NOT_FOUND',
          message: `no ui-local handler for ${channel}`,
          retryable: false
        }
        return { ok: false, error }
      }
      return handlers[channel as NativeRow](payload)
    }
  }
}
