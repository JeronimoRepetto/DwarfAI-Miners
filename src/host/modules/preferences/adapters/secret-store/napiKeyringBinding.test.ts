import { describe, expect, it } from 'vitest'
import { KeyringUnavailable } from './keyringBinding'
import { NapiKeyringBinding, type KeyringLibrary } from './napiKeyringBinding'

// L3: the real binding over a scripted library, so its mapping is proven on every OS. The real
// library itself runs in the OS lane (OsKeyringSecretStore.os.test.ts). The library messages below
// are the keyring-core texts `@napi-rs/keyring` 2.1.0 throws as `GenericFailure` (read from its
// Windows binary; the length one observed in SP-16).

type Script = {
  constructorThrows?: Error
  rejectWith?: Error
  stored?: string | undefined
}

function library(script: Script): {
  library: KeyringLibrary
  created: Array<{ service: string; username: string; options: unknown }>
} {
  const created: Array<{ service: string; username: string; options: unknown }> = []
  const act = <T>(value: T): Promise<T> =>
    script.rejectWith ? Promise.reject(script.rejectWith) : Promise.resolve(value)
  class AsyncEntry {
    constructor(service: string, username: string, options?: unknown) {
      created.push({ service, username, options })
      if (script.constructorThrows) throw script.constructorThrows
    }
    getPassword(): Promise<string | undefined> {
      return act(script.stored)
    }
    setPassword(): Promise<void> {
      return act(undefined)
    }
    deleteCredential(): Promise<boolean> {
      return act(false)
    }
  }
  return { library: { AsyncEntry }, created }
}

const NO_STORAGE = new Error("Couldn't access platform storage: no secret service")
const PLATFORM = new Error('Platform failure: Windows ERROR_NO_SUCH_LOGON_SESSION')
const TOO_LONG = new Error(
  "Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars"
)

describe('NapiKeyringBinding', () => {
  it('[ADR-017, FM-115] every entry is pinned to the Secret Service on Linux, so no kernel-keyring fallback is ever used', async () => {
    const { library: lib, created } = library({ stored: undefined })
    const binding = new NapiKeyringBinding('DwarfAI-Miners', lib)

    await binding.read('DwarfAI-Miners', 'jev-key')
    await binding.write('DwarfAI-Miners', 'jev-key', 'v')
    await binding.remove('DwarfAI-Miners', 'jev-key')
    await binding.available()

    expect(created.length).toBeGreaterThanOrEqual(4)
    for (const entry of created) {
      expect(entry.service).toBe('DwarfAI-Miners')
      expect(entry.options).toStrictEqual({ linux: { store: 'secret-service' } })
    }
  })

  it('[ADR-017, FM-115] a store the library cannot open makes the backend unavailable and every call reject with KeyringUnavailable', async () => {
    const binding = new NapiKeyringBinding(
      'DwarfAI-Miners',
      library({ constructorThrows: NO_STORAGE }).library
    )

    expect(await binding.available()).toBe(false)
    await expect(binding.read('DwarfAI-Miners', 'jev-key')).rejects.toBeInstanceOf(
      KeyringUnavailable
    )
    await expect(binding.write('DwarfAI-Miners', 'jev-key', 'v')).rejects.toBeInstanceOf(
      KeyringUnavailable
    )
    await expect(binding.remove('DwarfAI-Miners', 'jev-key')).rejects.toBeInstanceOf(
      KeyringUnavailable
    )
  })

  it('[ADR-017, FM-115] a storage-access or platform failure at call time maps to KeyringUnavailable', async () => {
    for (const failure of [NO_STORAGE, PLATFORM]) {
      const binding = new NapiKeyringBinding(
        'DwarfAI-Miners',
        library({ rejectWith: failure }).library
      )
      expect(await binding.available()).toBe(false)
      await expect(binding.read('DwarfAI-Miners', 'jev-key')).rejects.toBeInstanceOf(
        KeyringUnavailable
      )
      await expect(binding.write('DwarfAI-Miners', 'jev-key', 'v')).rejects.toBeInstanceOf(
        KeyringUnavailable
      )
      await expect(binding.remove('DwarfAI-Miners', 'jev-key')).rejects.toBeInstanceOf(
        KeyringUnavailable
      )
    }
  })

  it('[ADR-017] any other library error passes through, for the adapter to turn into SecretStoreFailure', async () => {
    const binding = new NapiKeyringBinding(
      'DwarfAI-Miners',
      library({ rejectWith: TOO_LONG }).library
    )

    await expect(binding.write('DwarfAI-Miners', 'jev-key', 'v')).rejects.toBe(TOO_LONG)
    await expect(binding.read('DwarfAI-Miners', 'jev-key')).rejects.toBe(TOO_LONG)
  })

  it('[ADR-017] a missing entry reads as null and removing it resolves', async () => {
    const binding = new NapiKeyringBinding('DwarfAI-Miners', library({ stored: undefined }).library)

    expect(await binding.available()).toBe(true)
    expect(await binding.read('DwarfAI-Miners', 'jev-key')).toBeNull()
    await expect(binding.remove('DwarfAI-Miners', 'jev-key')).resolves.toBeUndefined()
  })
})
