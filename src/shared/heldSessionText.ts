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

/**
 * What `heldMessageEntries` (main, `sessionLaunch/heldSession.ts`) writes into
 * a held turn's own row in place of an image content block, and the one
 * literal the renderer's echo reconciliation removes to prove that row
 * accounts for the image (#424).
 *
 * A plain word rather than a pattern: the held stream carries no per-image
 * counter the way a console's own `[Image #N]` placeholder does (measured —
 * `heldContentFor` sends an image as bytes with no accompanying text at all,
 * and Claude Code's own counter is a console-only artifact), so there is
 * nothing here to number.
 */
export const HELD_IMAGE_PLACEHOLDER = '[Image]'
