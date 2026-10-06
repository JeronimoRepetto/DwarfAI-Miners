// layer: L2
import { describe, expect, it } from 'vitest'
import { FakeClipboard } from '../ports/fakes/FakeClipboard'
import { FakeExternalOpener } from '../ports/fakes/FakeExternalOpener'
import { FakeFilePicker } from '../ports/fakes/FakeFilePicker'
import { FakeFolderPicker } from '../ports/fakes/FakeFolderPicker'
import { createNativeActions, MINE_PATH_UNOPENABLE_REASON } from './nativeActions'

/**
 * The native actions of cut 0 over their port doubles (05 §3.14; 16 §4.14): today's answers of A-22 and A-24 (14
 * §2.1 KEEP; ADR-033 item 6), a cancelled picker answering `[]`, and a picker that yields paths only (ADR-019 item 9).
 */
// AMENDED for ISSUE-091 (was: no folder picker): the folder the person picks for A-30, `null` for a cancelled dialog.
function subject(picked: readonly string[] | null = null, folder: string | null = null) {
  const files = new FakeFilePicker(picked)
  const folders = new FakeFolderPicker(folder)
  const clipboard = new FakeClipboard()
  const opener = new FakeExternalOpener()
  const actions = createNativeActions({
    files,
    folders,
    clipboard,
    opener,
    parentWindow: () => ({ windowId: 7 })
  })
  return { files, folders, clipboard, opener, actions }
}

describe('native actions (05 §3.14; 14 §2.1 A-21, A-22, A-24)', () => {
  it('[ADR-019] chooseAttachments answers the picked paths, over the window the control was pressed in', async () => {
    const picked = ['/home/j/notes.md', '/home/j/shot.png']
    const { files, actions } = subject(picked)

    expect(await actions.chooseAttachments()).toEqual(picked)
    expect(files.parents).toEqual([{ windowId: 7 }])
  })

  it('[ADR-019] a cancelled FilePicker answers an empty list', async () => {
    const { actions } = subject(null)
    expect(await actions.chooseAttachments()).toEqual([])
  })

  it('[ADR-033] copyText writes the text exactly as written and answers copied', async () => {
    const { clipboard, actions } = subject()
    const text = '  Also check\nthat it sorts. '

    expect(await actions.copyText(text)).toEqual({ copied: true })
    expect(clipboard.written).toEqual([text])
  })

  it('[ADR-033] copyText of nothing writes nothing and answers not copied', async () => {
    const { clipboard, actions } = subject()

    expect(await actions.copyText('')).toEqual({ copied: false })
    expect(clipboard.written).toEqual([])
  })

  it('[ADR-033] a clipboard that throws answers not copied rather than rejecting across the bridge', async () => {
    const { clipboard, actions } = subject()
    clipboard.failWith = new Error('no clipboard owner')

    expect(await actions.copyText('hi')).toEqual({ copied: false })
  })

  it('[ADR-033] a clipboard write that fails after the call answers not copied', async () => {
    // Owner-approved amendment (2026-10-01, ISSUE-050): the platform clipboard is asynchronous, so a write can fail
    // after it was handed over; the copy then answers not copied, never a copy that did not happen.
    const { clipboard, actions } = subject()
    clipboard.failLater = new Error('clipboard refused the write')

    expect(await actions.copyText('hi')).toEqual({ copied: false })
  })

  it('[ADR-019] a link the opener refuses answers the legacy failure shape', async () => {
    const { opener, actions } = subject()
    opener.refuse = true

    expect(await actions.openExternal('javascript:alert(1)')).toEqual({
      opened: false,
      reason: 'That link could not be opened.'
    })
    expect(opener.opened).toEqual([])
  })

  it('[ADR-019, NFR-PLAT-09] chooseFolder answers the picked folder over the window the control was pressed in, and null when cancelled', async () => {
    const picked = subject(null, '/home/j/work/ore')
    expect(await picked.actions.chooseFolder()).toBe('/home/j/work/ore')
    expect(picked.folders.parents).toEqual([{ windowId: 7 }])

    const cancelled = subject(null, null)
    expect(await cancelled.actions.chooseFolder()).toBeNull()
  })

  it('[ADR-019] chooseFolder with no folder picker composed rejects rather than answering a cancel', async () => {
    const actions = createNativeActions({
      files: new FakeFilePicker(null),
      clipboard: new FakeClipboard(),
      opener: new FakeExternalOpener(),
      parentWindow: () => ({ windowId: 7 })
    })

    await expect(actions.chooseFolder()).rejects.toThrow('no folder picker')
  })

  it('[ADR-019] openPath opens the path and answers opened, and an OS error answers the fixed reason, never the OS text', async () => {
    const { opener, actions } = subject()

    expect(await actions.openPath('/home/j/work/ore/src/a.ts')).toEqual({ opened: true })
    opener.openPathError = 'Failed to open: access denied for C:\Users\j'
    expect(await actions.openPath('/home/j/work/ore/src/b.ts')).toEqual({
      opened: false,
      reason: MINE_PATH_UNOPENABLE_REASON
    })
    expect(MINE_PATH_UNOPENABLE_REASON).toBe('That file could not be opened.')
    expect(opener.openedPaths).toEqual(['/home/j/work/ore/src/a.ts', '/home/j/work/ore/src/b.ts'])
  })
})
