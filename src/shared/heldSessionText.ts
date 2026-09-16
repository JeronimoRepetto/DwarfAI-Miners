/**
 * How a held session is told about a file it will not receive the bytes of
 * (#408) — the one line `heldContentFor` (main, `textDelivery/attachmentDelivery.ts`)
 * writes ahead of a non-image attachment's path, and the one literal token the
 * renderer's echo reconciliation (`lib/message/echo.ts`, #424) removes to
 * prove a held session's own row accounts for that file.
 *
 * Shared for the reason `consoleText.ts`'s own rule already is: MAIN writes
 * this exact string into the message the SDK receives, and the RENDERER has
 * to recognise the very same string in the transcript row that message
 * becomes. The renderer cannot import from `main`, so the one literal both
 * sides need moved to the one place both can reach it — two copies is how one
 * of them drifts from the other.
 */
export const ATTACHED_FILE_PREFIX = 'Attached file: '
