import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE_NAME } from '@dwarfai/contracts'

/**
 * The text of the userData config file (`config-v1.json`, `contracts/config`), the I/O half of the feature flags'
 * config layer (A-29), read once when UI main starts. No file is the common case, since most installs never write
 * one, and any other read failure reads the same way: "nothing configured" is not worth a failed start (today's
 * `createConfigFileStore.load`). The pure parser then decides what the text means.
 */
export function readUserDataConfigFile(userDataDir: string): string | null {
  try {
    return readFileSync(join(userDataDir, CONFIG_FILE_NAME), 'utf8')
  } catch {
    return null
  }
}
