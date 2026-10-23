import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Installs one demo stub CLI in the profile, as the E2E worlds install theirs (`e2e/cut-3a/claudeStreamWorld.ts`):
 * `<profile>/stubs/<name>/` holds the `<name>.mjs` entry, the Windows `<name>.cmd` shim (read by the Host for its
 * quoted node entry, never run through cmd.exe, ADR-029 row 8), the POSIX `<name>` wrapper and `script.json`, the
 * scenario's turns for this provider at the chosen speed. Answers the folder, to put on the app's PATH.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

const STUBS = Object.freeze({
  claude: { module: 'claudeDemoStub.mjs', run: 'runClaudeDemoStub' },
  codex: { module: 'codexDemoStub.mjs', run: 'runCodexDemoStub' }
})

export function installStub(profileRoot, name, script) {
  const stub = STUBS[name]
  if (stub === undefined) throw new Error(`there is no demo stub named ${name}`)
  const dir = path.join(profileRoot, 'stubs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script, null, 2))
  writeFileSync(
    path.join(dir, `${name}.mjs`),
    [
      `import { ${stub.run} } from ${JSON.stringify(pathToFileURL(path.join(HERE, stub.module)).href)}`,
      `${stub.run}(import.meta.dirname)`,
      ''
    ].join('\n')
  )
  writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`)
  const posix = path.join(dir, name)
  writeFileSync(
    posix,
    `#!/bin/sh\ncase "$0" in\n  */*) dir=\${0%/*} ;;\n  *) dir=. ;;\nesac\nexec node "$dir/${name}.mjs" "$@"\n`
  )
  chmodSync(posix, 0o755)
  return dir
}
