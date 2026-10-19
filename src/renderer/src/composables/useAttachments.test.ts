// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import type { DwarfAttachmentPick } from '../types'
import { useAttachments } from './useAttachments'

/*
 * THE MESSAGE PANEL'S ATTACHMENT CALLS (ADR-033 item 2; 05 §5.1 R13; 14 §2.1 A-24, A-25, A-X1).
 *
 * Composables are the renderer's only IPC layer, so the panel's file picker, its dropped-file path helper and the
 * attachment description live here, tested against the generated fake `window.api` (ADR-033 item 7). The shapes are
 * the rows' own; the Host re-validates every path it is asked to describe (ADR-019 item 9).
 */
describe('useAttachments', () => {
  type Api = Window['api']
  const NOTES = '/work/notes.txt'
  const HUGE = '/work/huge.bin'

  const notesPick: DwarfAttachmentPick = {
    path: NOTES,
    attachment: { path: NOTES, name: 'notes.txt', kind: 'file', bytes: 120 }
  }
  const hugePick: DwarfAttachmentPick = { path: HUGE, refusal: 'file-too-large' }

  function install(over: Partial<Api>): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: createFakeWindowApi(over)
    })
  }

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('[ADR-033] useAttachments picks files through chooseDwarfAttachments and describes them through describeDwarfAttachments, returning each refusal per item', async () => {
    const chooseDwarfAttachments = vi.fn().mockResolvedValue([NOTES, HUGE])
    const describeDwarfAttachments = vi.fn().mockResolvedValue([notesPick, hugePick])
    install({
      chooseDwarfAttachments: chooseDwarfAttachments as unknown as Api['chooseDwarfAttachments'],
      describeDwarfAttachments:
        describeDwarfAttachments as unknown as Api['describeDwarfAttachments']
    })
    const attachments = useAttachments()

    const chosen = await attachments.choose()
    const picks = await attachments.describe(chosen)

    expect(chooseDwarfAttachments).toHaveBeenCalledTimes(1)
    expect(chosen).toEqual([NOTES, HUGE])
    expect(describeDwarfAttachments).toHaveBeenCalledWith([NOTES, HUGE])
    expect(picks).toEqual([notesPick, hugePick])
    expect(picks.map((pick) => pick.refusal ?? null)).toEqual([null, 'file-too-large'])
  })

  it('[ADR-033] a dropped file is resolved through pathForDroppedFile before it is described', async () => {
    const order: string[] = []
    const pathForDroppedFile = vi.fn((file: File) => {
      order.push(`path:${file.name}`)
      return file.name === 'page-image.png' ? '' : `/work/${file.name}`
    })
    const describeDwarfAttachments = vi.fn((paths: readonly string[]) => {
      order.push(`describe:${paths.join(',')}`)
      return Promise.resolve([notesPick])
    })
    install({
      pathForDroppedFile: pathForDroppedFile as unknown as Api['pathForDroppedFile'],
      describeDwarfAttachments:
        describeDwarfAttachments as unknown as Api['describeDwarfAttachments']
    })
    const attachments = useAttachments()
    const notes = new File(['n'], 'notes.txt')
    // A File with no path — a drag out of a web page — answers '' and is dropped, never guessed at.
    const fromPage = new File(['p'], 'page-image.png')

    const paths = attachments.droppedPaths([notes, fromPage])
    const picks = await attachments.describe(paths)

    expect(pathForDroppedFile).toHaveBeenCalledWith(notes)
    expect(pathForDroppedFile).toHaveBeenCalledWith(fromPage)
    expect(paths).toEqual([NOTES])
    expect(order).toEqual(['path:notes.txt', 'path:page-image.png', `describe:${NOTES}`])
    expect(picks).toEqual([notesPick])
  })
})
