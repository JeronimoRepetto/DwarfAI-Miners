// layer: L2
import { describe, expect, it } from 'vitest'
import { FakeClipboard } from '../ports/fakes/FakeClipboard'
import { FakeExternalOpener } from '../ports/fakes/FakeExternalOpener'
import { FakeFilePicker } from '../ports/fakes/FakeFilePicker'
import { createNativeActions } from './nativeActions'

/**
 * The native actions of cut 0 over their port doubles (05 §3.14; 16 §4.14): today's answers of A-22 and A-24 (14
 * §2.1 KEEP; ADR-033 item 6), a cancelled picker answering `[]`, and a picker that yields paths only (ADR-019 item 9).
 */
function subject(picked: readonly string[] | null = null) {
  const files = new FakeFilePicker(picked)
  const clipboard = new FakeClipboard()
  const opener = new FakeExternalOpener()
  const actions = createNativeActions({
    files,
    clipboard,
    opener,
    parentWindow: () => ({ windowId: 7 })
  })
  return { files, clipboard, opener, actions }
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

  it('[ADR-033] copyText writes the text exactly as written and answers copied', () => {
    const { clipboard, actions } = subject()
    const text = '  Also check\nthat it sorts. '

    expect(actions.copyText(text)).toEqual({ copied: true })
    expect(clipboard.written).toEqual([text])
  })

  it('[ADR-033] copyText of nothing writes nothing and answers not copied', () => {
    const { clipboard, actions } = subject()

    expect(actions.copyText('')).toEqual({ copied: false })
    expect(clipboard.written).toEqual([])
  })

  it('[ADR-033] a clipboard that throws answers not copied rather than rejecting across the bridge', () => {
    const { clipboard, actions } = subject()
    clipboard.failWith = new Error('no clipboard owner')

    expect(actions.copyText('hi')).toEqual({ copied: false })
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
})
