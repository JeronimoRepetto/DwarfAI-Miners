import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvAppPaths, type HostProcessFacts } from './EnvAppPaths'

const HOST_DATA_DIR = join('users', 'someone', 'app-data', 'DwarfAI-Miners', 'host')
const EXEC_PATH = join('opt', 'DwarfAI-Miners', 'versions', '1.0.0', 'DwarfAI-Miners')
const RESOURCES_PATH = join('opt', 'DwarfAI-Miners', 'versions', '1.0.0', 'resources')

function facts(overrides: Partial<HostProcessFacts> = {}): HostProcessFacts {
  return {
    env: { DWARFAI_HOST_DATA_DIR: HOST_DATA_DIR },
    execPath: EXEC_PATH,
    resourcesPath: RESOURCES_PATH,
    isPackaged: true,
    ...overrides
  }
}

describe('EnvAppPaths', () => {
  it('[ADR-002] userDataDir is DWARFAI_HOST_DATA_DIR and missing env refuses construction with a typed error', () => {
    const created = EnvAppPaths.create(facts())
    expect(created.ok && created.value.userDataDir).toBe(HOST_DATA_DIR)
    expect(created.ok && created.value.execPath).toBe(EXEC_PATH)
    expect(created.ok && created.value.isPackaged).toBe(true)

    expect(EnvAppPaths.create(facts({ env: {} }))).toEqual({
      ok: false,
      error: 'host-data-dir-missing'
    })
    expect(EnvAppPaths.create(facts({ env: { DWARFAI_HOST_DATA_DIR: '' } }))).toEqual({
      ok: false,
      error: 'host-data-dir-missing'
    })
  })

  it('[ADR-002] resourcesPath is used only when packaged', () => {
    const packaged = EnvAppPaths.create(facts())
    const dev = EnvAppPaths.create(facts({ isPackaged: false }))
    const packagedWithout = EnvAppPaths.create(facts({ resourcesPath: undefined }))

    expect(packaged.ok && packaged.value.resourcesPath).toBe(RESOURCES_PATH)
    expect(dev.ok && dev.value.resourcesPath).toBeNull()
    expect(dev.ok && dev.value.isPackaged).toBe(false)
    expect(packagedWithout.ok && packagedWithout.value.resourcesPath).toBeNull()
  })

  it('[ADR-002] the values are fixed for the process life', () => {
    const env: Record<string, string | undefined> = { DWARFAI_HOST_DATA_DIR: HOST_DATA_DIR }
    const source = facts({ env })
    const created = EnvAppPaths.create(source)
    if (!created.ok) throw new Error('expected EnvAppPaths to be created')
    const paths = created.value

    env.DWARFAI_HOST_DATA_DIR = join('elsewhere', 'host')
    source.execPath = join('elsewhere', 'DwarfAI-Miners')

    expect(paths.userDataDir).toBe(HOST_DATA_DIR)
    expect(paths.execPath).toBe(EXEC_PATH)
    expect(Object.isFrozen(paths)).toBe(true)
    expect(() => {
      ;(paths as { userDataDir: string }).userDataDir = 'changed'
    }).toThrow(TypeError)
    expect(paths.userDataDir).toBe(HOST_DATA_DIR)
  })
})
