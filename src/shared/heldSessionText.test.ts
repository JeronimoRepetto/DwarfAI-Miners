import { describe, expect, it } from 'vitest'
import { ATTACHED_FILE_PREFIX } from './heldSessionText'

/*
 * #424. `attachmentDelivery.ts`'s `heldContentFor` (main) writes this exact
 * line ahead of a non-image attachment's path, and the renderer's echo
 * reconciliation (`lib/message/echo.ts`) has to recognise the very same
 * string in the transcript row that message becomes — the same reason
 * `consoleText.ts`'s own rule is shared rather than duplicated (#419).
 */
describe('ATTACHED_FILE_PREFIX', () => {
  it('is the exact line a held session is told about a file it will not receive the bytes of', () => {
    expect(ATTACHED_FILE_PREFIX).toBe('Attached file: ')
  })
})
