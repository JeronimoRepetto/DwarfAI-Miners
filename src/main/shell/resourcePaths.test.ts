import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveResourcePath } from './resourcePaths'

describe('resolveResourcePath', () => {
  it('resolves inside process.resourcesPath once packaged', () => {
    const resourcesPath = join('opt', 'DwarfAI-Miners', 'resources')
    const result = resolveResourcePath('tray-icon.png', {
      isPackaged: true,
      resourcesPath,
      appPath: join(resourcesPath, 'app.asar')
    })
    expect(result).toBe(join(resourcesPath, 'tray-icon.png'))
  })

  it('resolves under the project resources/ dir in dev', () => {
    const appPath = join('home', 'j', 'agent-name')
    const result = resolveResourcePath('tray-icon.png', {
      isPackaged: false,
      resourcesPath: '',
      appPath
    })
    expect(result).toBe(join(appPath, 'resources', 'tray-icon.png'))
  })

  it('ignores resourcesPath entirely when not packaged', () => {
    const appPath = join('home', 'j', 'agent-name')
    const result = resolveResourcePath('app-icon.png', {
      isPackaged: false,
      resourcesPath: join('some', 'unrelated', 'path'),
      appPath
    })
    expect(result).toBe(join(appPath, 'resources', 'app-icon.png'))
  })
})
