// layer: L2
import { describe, expect, it } from 'vitest'
import { createUiShellStart } from './shellStart'

/**
 * The shell start (21 §2 cut 5 preparation for ISSUE-243): what today's composition did at its own start and nothing
 * else does, run by UI main in today's order so the legacy runtime can go without a behaviour change.
 */
function world(options: { dock: boolean; autostart: boolean; identity?: boolean }) {
  const order: string[] = []
  const shell = createUiShellStart({
    ...(options.dock ? { dock: { hide: () => void order.push('dock hidden') } } : {}),
    loadEnvironmentFile: () => void order.push('.env read'),
    ...(options.autostart
      ? {
          candidateAutostart: async () => {
            order.push('login entry applied')
          }
        }
      : {}),
    ...(options.identity === true
      ? { setAppUserModelId: () => void order.push('app identity set') }
      : {})
  })
  return { order, shell }
}

describe('the shell start (21 §2 cut 5)', () => {
  it('[ADR-001] on macOS the start hides the Dock tile, then reads the .env file, then applies the candidate login entry', async () => {
    const { order, shell } = world({ dock: true, autostart: true })

    await shell.start()

    expect(order).toEqual(['dock hidden', '.env read', 'login entry applied'])
  })

  it('[ADR-001] without a Dock (Windows, Linux) the start still reads the .env file and applies the candidate login entry', async () => {
    const { order, shell } = world({ dock: false, autostart: true })

    await shell.start()

    expect(order).toEqual(['.env read', 'login entry applied'])
  })

  it('[ADR-001] where the candidate login entry is not composed the start reads the .env file and writes no entry', async () => {
    const { order, shell } = world({ dock: false, autostart: false })

    await shell.start()

    expect(order).toEqual(['.env read'])
  })

  // ADDED for ISSUE-243: today's composition set the app's identity (Electron's `app.setAppUserModelId`, the identity
  // Windows groups the app's windows and toasts under) right after this work, at every start; with today's runtime
  // deleted the shell start does it, last, so the start is unchanged.
  it('[ADR-001] the start sets the app identity last, after the .env file and the candidate login entry', async () => {
    const { order, shell } = world({ dock: true, autostart: true, identity: true })

    await shell.start()

    expect(order).toEqual(['dock hidden', '.env read', 'login entry applied', 'app identity set'])
  })
})
