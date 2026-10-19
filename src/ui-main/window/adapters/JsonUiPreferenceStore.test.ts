// layer: L3
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultsOf } from '../domain/uiPreferenceValues'
import type { UiPreferenceLogRecord, UiPreferenceStoreMap } from '../ports/uiPreferenceStore'
import {
  NON_DEFAULT_VALUES,
  runUiPreferenceStoreContract,
  STORE_KEYS
} from '../testing/uiPreferenceStore.contract'
import {
  JsonUiPreferenceStore,
  nodeFs,
  TWO_CHOICE_TYPOGRAPHY_FILE,
  UI_PREFERENCE_FILES,
  type UiPreferenceFs
} from './JsonUiPreferenceStore'

/** Node's fs, except that an armed write puts only the first half of its bytes on disk, then fails (EIO). */
class InterruptibleFs implements UiPreferenceFs {
  armed = false
  readonly calls: string[] = []
  readFileSync(path: string, encoding: 'utf8'): string {
    return nodeFs.readFileSync(path, encoding)
  }
  writeFileSync(path: string, data: string, encoding: 'utf8'): void {
    this.calls.push(`write ${path}`)
    if (!this.armed) return nodeFs.writeFileSync(path, data, encoding)
    this.armed = false
    nodeFs.writeFileSync(path, data.slice(0, Math.floor(data.length / 2)), encoding)
    throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
  }
  renameSync(from: string, to: string): void {
    this.calls.push(`rename ${from} ${to}`)
    nodeFs.renameSync(from, to)
  }
  mkdirSync(path: string, options: { recursive: true }): unknown {
    return nodeFs.mkdirSync(path, options)
  }
}

describe('JsonUiPreferenceStore', () => {
  // A fresh temporary folder per test, removed afterwards (17 §1.3).
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  function tempDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-uiprefs-'))
    roots.push(root)
    return root
  }

  runUiPreferenceStoreContract(() => {
    const dir = tempDir()
    const fs = new InterruptibleFs()
    const logged: UiPreferenceLogRecord[] = []
    return {
      open: () => new JsonUiPreferenceStore({ dir, fs, log: (record) => logged.push(record) }),
      corrupt: (key) =>
        writeFileSync(join(dir, UI_PREFERENCE_FILES[key]), '{"musicAtStart', 'utf8'),
      interruptNextSave: () => {
        fs.armed = true
      },
      logged: () => logged
    }
  })

  function storeIn(dir: string, fs: UiPreferenceFs = nodeFs) {
    const logged: UiPreferenceLogRecord[] = []
    return { store: new JsonUiPreferenceStore({ dir, fs, log: (r) => logged.push(r) }), logged }
  }

  it('[ADR-024] a save writes the bytes to a sibling temp file, then renames it over the store file', () => {
    const dir = tempDir()
    const fs = new InterruptibleFs()
    storeIn(dir, fs).store.save('dockSide', 'left')

    const file = join(dir, UI_PREFERENCE_FILES.dockSide)
    expect(fs.calls).toEqual([`write ${file}.tmp`, `rename ${file}.tmp ${file}`])
    expect(readdirSync(dir)).toEqual([UI_PREFERENCE_FILES.dockSide])
  })

  it('[ADR-024, US-SHELL-006.AC02] a first start, with no folder and no file, loads every default without a log record, and the first save creates the folder', () => {
    const dir = join(tempDir(), 'not-yet-created')
    const { store, logged } = storeIn(dir)
    for (const key of STORE_KEYS) expect(store.load(key)).toEqual(defaultsOf(key))
    expect(logged).toEqual([])

    store.save('launchView', NON_DEFAULT_VALUES.launchView)
    expect(storeIn(dir).store.load('launchView')).toEqual(NON_DEFAULT_VALUES.launchView)
  })

  it('[ADR-024] a legacy preference file that conforms to the contract is read as it stands', () => {
    const dir = tempDir()
    // Today's documents, as the legacy stores write them (one per file, newline-terminated).
    const legacy: Record<keyof UiPreferenceStoreMap, unknown> = {
      audio: NON_DEFAULT_VALUES.audio,
      typography: NON_DEFAULT_VALUES.typography,
      launchView: NON_DEFAULT_VALUES.launchView,
      dockSide: { edge: 'left' },
      alwaysOnTop: { pinned: false },
      shortcut: { accelerator: 'Control+Alt+K' },
      // NEW with ISSUE-060, no store of today's: the document this store writes.
      startWithSystem: { on: false },
      // NEW with ISSUE-061, no store of today's: the document this store writes.
      resetEpochApplied: { epoch: 2 }
    }
    for (const key of STORE_KEYS) {
      writeFileSync(join(dir, UI_PREFERENCE_FILES[key]), `${JSON.stringify(legacy[key])}\n`)
    }

    const { store, logged } = storeIn(dir)
    for (const key of STORE_KEYS) expect(store.load(key)).toEqual(NON_DEFAULT_VALUES[key])
    expect(logged).toEqual([])
  })

  it('[ADR-024] a legacy preference file that does not conform starts that store from its defaults, logged, and nothing of it is imported', () => {
    const dir = tempDir()
    const nonConforming: Record<keyof UiPreferenceStoreMap, unknown> = {
      // A volume out of range: today's store would have clamped it, so it is not a value this store writes.
      audio: { ...NON_DEFAULT_VALUES.audio, musicVolume: 1.5 },
      // A preset drawn in faces that are not its own.
      typography: { style: 'readable', faces: NON_DEFAULT_VALUES.typography.faces },
      // A field the contract does not know.
      launchView: { ...NON_DEFAULT_VALUES.launchView, scroll: 3 },
      dockSide: { edge: 'top' },
      alwaysOnTop: { pinned: 'yes' },
      shortcut: { accelerator: 'K' },
      startWithSystem: { on: 'yes' },
      // An epoch is a whole count from 0.
      resetEpochApplied: { epoch: -1 }
    }
    for (const key of STORE_KEYS) {
      writeFileSync(join(dir, UI_PREFERENCE_FILES[key]), JSON.stringify(nonConforming[key]))
    }

    const { store, logged } = storeIn(dir)
    for (const key of STORE_KEYS) expect(store.load(key)).toEqual(defaultsOf(key))
    expect(logged).toEqual(
      STORE_KEYS.map((key) => ({
        level: 'warn',
        event: 'uiprefs.corrupt',
        subsystem: 'window',
        msg: key
      }))
    )
  })

  it('[US-SET-003.AC07] with no current typography file, the older two-choice file loads in the preset model and is left as it was', () => {
    const dir = tempDir()
    const older = `${JSON.stringify({ interfaceFont: 'roboto', messagingFont: 'roboto' })}\n`
    writeFileSync(join(dir, TWO_CHOICE_TYPOGRAPHY_FILE), older)

    const { store, logged } = storeIn(dir)
    expect(store.load('typography')).toEqual({
      style: 'readable',
      faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
    })
    expect(logged).toEqual([])
    // Loading never writes: the new file appears only when a style is stored.
    expect(existsSync(join(dir, UI_PREFERENCE_FILES.typography))).toBe(false)
  })
})
