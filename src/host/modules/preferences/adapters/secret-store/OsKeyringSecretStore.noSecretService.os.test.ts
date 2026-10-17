import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { OsKeyringSecretStore } from './OsKeyringSecretStore'
import { drawRunService, redirectedKeyringBinding } from './testing/redirectedKeyringBinding'

// L8 (17 §1.8; FM-115): Linux with no Secret Service. The session bus address is pointed at a
// socket that does not exist, so the Secret Service cannot be reached whatever the machine runs.
// Unpinned, the library would fall back to the kernel keyring; the binding pins every entry to the
// Secret Service, so the store reports unavailable and writes nothing anywhere (ADR-017 item 5).
// Its own file, so the broken bus address lives in its own test process.

describe.runIf(process.platform === 'linux')(
  'OsKeyringSecretStore without a Secret Service',
  () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS
    const dataDirs: string[] = []

    beforeAll(() => {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(tmpdir(), 'dwarfai-no-such-bus')}`
      dataDirs.push(
        mkdtempSync(join(tmpdir(), 'dwarfai-host-')),
        mkdtempSync(join(tmpdir(), 'dwarfai-ui-'))
      )
    })

    afterAll(() => {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved
      for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
    })

    it('[C-23, FM-115] on Linux without a Secret Service the backend is unavailable and no file appears', async () => {
      const store = new OsKeyringSecretStore(
        redirectedKeyringBinding(drawRunService()),
        new RecordingDiagnosticsLog()
      )
      const value = randomBytes(24).toString('base64url')

      expect(await store.backend()).toBe('unavailable')
      await expect(store.set('jev-key', value)).rejects.toThrow(/SecretStoreUnavailable/)
      expect(await store.get('jev-key')).toBeNull()
      expect(await store.delete('jev-key')).toBe('unavailable')
      for (const dir of dataDirs) expect(readdirSync(dir)).toStrictEqual([])
    })
  }
)
