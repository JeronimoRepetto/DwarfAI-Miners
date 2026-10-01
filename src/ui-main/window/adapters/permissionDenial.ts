/**
 * Permission denial (ADR-019 item 3; 18 C-05). A page never gets a permission: no camera or microphone, no
 * geolocation, no page notifications, no clipboard read, nothing. OS notifications are raised by Electron main
 * (ADR-018), never by a page, so the app needs no page permission at all and every request and check is refused.
 */

/** The two handlers of an Electron `Session` the denial installs. */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (permissionGranted: boolean) => void,
          details: unknown
        ) => void)
      | null
  ): void
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
          details: unknown
        ) => boolean)
      | null
  ): void
}

/** Installs both handlers on `session` (the default session every window uses): each answers "denied". */
export function denyEveryPermission(session: PermissionSession): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}
