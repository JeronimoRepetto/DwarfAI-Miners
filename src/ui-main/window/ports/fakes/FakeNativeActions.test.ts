import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_LINK_REFUSED_REASON,
  MINE_PATH_UNOPENABLE_REASON
} from '../../application/nativeActions'
import { FakeNativeActions } from './FakeNativeActions'

describe('FakeNativeActions', () => {
  it('[ADR-019] a picker answers the chosen paths, and a cancelled one answers []', async () => {
    const chosen = new FakeNativeActions({ attachments: ['C:/work/a.txt', 'C:/work/b.png'] })
    const cancelled = new FakeNativeActions({ attachments: null })

    expect(await chosen.chooseAttachments()).toEqual(['C:/work/a.txt', 'C:/work/b.png'])
    expect(await cancelled.chooseAttachments()).toEqual([])
    expect(chosen.pickerOpened).toBe(1)
  })

  it('[ADR-019] copyText records what was copied, and copies nothing for empty text or a failing clipboard', async () => {
    const actions = new FakeNativeActions()

    expect(await actions.copyText('hello')).toEqual({ copied: true })
    expect(await actions.copyText('')).toEqual({ copied: false })
    actions.clipboardFails = true
    expect(await actions.copyText('lost')).toEqual({ copied: false })

    expect(actions.copied).toEqual(['hello'])
  })

  it('[ADR-019] openExternal records what was opened, and a refused link answers the fixed reason', async () => {
    const actions = new FakeNativeActions()

    expect(await actions.openExternal('https://example.org/')).toEqual({ opened: true })
    actions.refuseLinks = true
    expect(await actions.openExternal('https://example.org/x')).toEqual({
      opened: false,
      reason: EXTERNAL_LINK_REFUSED_REASON
    })

    expect(actions.opened).toEqual(['https://example.org/'])
  })

  it('[ADR-019] chooseFolder answers the chosen folder and counts the picker, and a cancelled one answers null', async () => {
    const chosen = new FakeNativeActions({ folder: 'C:/work/ore' })
    const cancelled = new FakeNativeActions()

    expect(await chosen.chooseFolder()).toBe('C:/work/ore')
    expect(await cancelled.chooseFolder()).toBeNull()
    expect(chosen.folderPickerOpened).toBe(1)
  })

  it('[ADR-019] openPath records what was opened, and an OS that will not open it answers the fixed reason', async () => {
    const actions = new FakeNativeActions()

    expect(await actions.openPath('C:/work/ore/a.ts')).toEqual({ opened: true })
    actions.refusePaths = true
    expect(await actions.openPath('C:/work/ore/b.ts')).toEqual({
      opened: false,
      reason: MINE_PATH_UNOPENABLE_REASON
    })

    expect(actions.openedPaths).toEqual(['C:/work/ore/a.ts'])
  })
})
