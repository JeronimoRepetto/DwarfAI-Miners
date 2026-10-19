// Spike SP-16 probe (spikes/SP-16/keyringUnderElectron.os.test.ts): run by the Electron binary under
// ELECTRON_RUN_AS_NODE=1, the way the Host runs (ADR-002 D1). Prints one JSON line and exits.
//
//   <electron> keyringProbe.cjs <mode> <service> <repoRoot>
//
// Modes: `available` (does a Secret-Service-pinned read answer), `roundtrip` (set, read, list, delete), `expect-
// unavailable` (Linux with no Secret Service: the pinned entry must be refused), `write` / `read` / `remove` (one step
// each, for the cross-copy observation; the value comes in SP16_VALUE), `cleanup` (removes the probe's accounts).
//
// Only entries under <service>, a service unique to one test run, are touched. Values are drawn at run time or come
// from SP16_VALUE and are never printed: the report holds booleans, counts and error classes only.
'use strict'

// Built-ins through getBuiltinModule and the library through createRequire, as spikes/S-027-4/backgroundApp.cjs does.
const { randomBytes } = process.getBuiltinModule('node:crypto')
const path = process.getBuiltinModule('node:path')
const { createRequire } = process.getBuiltinModule('node:module')

const [mode, service, repoRoot] = process.argv.slice(2)
// As napiKeyringBinding.ts: on Linux every entry is pinned to the Secret Service (no kernel-keyring fallback).
const PINNED = { linux: { store: 'secret-service' } }
const ACCOUNTS = ['sp16-probe', 'sp16-unicode', 'sp16-cross']
// keyring-core's NoStorageAccess and PlatformFailure texts, as @napi-rs/keyring 2.1.0 words them (napiKeyringBinding).
const UNAVAILABLE_PREFIXES = ["Couldn't access platform storage", 'Platform failure']

const report = {
  mode,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  modules: process.versions.modules,
  loadedFrom: null,
  checks: {}
}

/** The error's class, never its whole text: the library's message prefix up to the first colon. */
const errorClass = (error) =>
  String(error && error.message ? error.message : error)
    .split(':')[0]
    .slice(0, 120)
const isUnavailable = (error) =>
  error instanceof Error && UNAVAILABLE_PREFIXES.some((prefix) => error.message.startsWith(prefix))

async function attempt(work) {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, error }
  }
}

async function roundTrip(keyring) {
  const { AsyncEntry, findCredentialsAsync } = keyring
  const checks = report.checks
  const value = randomBytes(24).toString('base64url')
  const entry = new AsyncEntry(service, 'sp16-probe', PINNED)
  const set = await attempt(() => entry.setPassword(value))
  checks.set = set.ok ? 'ok' : `error: ${errorClass(set.error)}`
  if (!set.ok) return
  checks.readBackEqual = (await entry.getPassword()) === value
  const listed = await findCredentialsAsync(service)
  checks.findCredentialsListsIt = listed.some((credential) => credential.account === 'sp16-probe')
  const unicode = `ñ-ü-日本-${randomBytes(6).toString('hex')}`
  const unicodeEntry = new AsyncEntry(service, 'sp16-unicode', PINNED)
  await unicodeEntry.setPassword(unicode)
  checks.unicodeRoundTrip = (await unicodeEntry.getPassword()) === unicode
  await unicodeEntry.deleteCredential()
  checks.deleteReturnsTrue = (await entry.deleteCredential()) === true
  checks.readAfterDeleteIsNull = ((await entry.getPassword()) ?? null) === null
  const second = await attempt(() => entry.deleteCredential())
  checks.secondDeleteReturnsFalse = second.ok && second.value === false
  const after = await findCredentialsAsync(service)
  checks.findCredentialsAfterDelete = after.some(
    (credential) => credential.account === 'sp16-probe'
  )
  checks.leftoverEntries = after.length
}

async function expectUnavailable(keyring) {
  const { AsyncEntry } = keyring
  const checks = report.checks
  const value = randomBytes(24).toString('base64url')
  const pinned = await attempt(() =>
    new AsyncEntry(service, 'sp16-probe', PINNED).setPassword(value)
  )
  checks.pinnedSetRejected = !pinned.ok
  checks.pinnedErrorIsUnavailable = !pinned.ok && isUnavailable(pinned.error)
  checks.pinnedError = pinned.ok ? null : errorClass(pinned.error)
  const read = await attempt(() => new AsyncEntry(service, 'sp16-probe', PINNED).getPassword())
  checks.pinnedReadRejectedOrNull = !read.ok || (read.value ?? null) === null
  // Recorded, not asserted: what an unpinned entry does here (the library's own fallback, the kernel keyring), the
  // behaviour the adapter's pin exists to avoid. Its value is removed at once.
  const unpinned = new AsyncEntry(service, 'sp16-probe')
  const fallback = await attempt(() => unpinned.setPassword(value))
  checks.unpinnedFallbackStores = fallback.ok
  checks.unpinnedFallbackError = fallback.ok ? null : errorClass(fallback.error)
  if (fallback.ok) await attempt(() => unpinned.deleteCredential())
}

async function main() {
  let keyring
  try {
    const fromRepo = createRequire(path.join(repoRoot, 'package.json'))
    const resolved = fromRepo.resolve('@napi-rs/keyring')
    keyring = fromRepo(resolved)
    report.loadedFrom = path.relative(repoRoot, resolved).split(path.sep).join('/')
    report.checks.load = 'ok'
  } catch (error) {
    report.checks.load = `error: ${errorClass(error)}`
    return
  }
  const { AsyncEntry } = keyring
  switch (mode) {
    case 'available': {
      const probe = await attempt(() =>
        new AsyncEntry(service, 'sp16-backend-probe', PINNED).getPassword()
      )
      report.available = probe.ok || !isUnavailable(probe.error)
      if (!probe.ok) report.checks.availableError = errorClass(probe.error)
      return
    }
    case 'roundtrip':
      return roundTrip(keyring)
    case 'expect-unavailable':
      return expectUnavailable(keyring)
    case 'write': {
      const write = await attempt(() =>
        new AsyncEntry(service, 'sp16-cross', PINNED).setPassword(process.env.SP16_VALUE ?? '')
      )
      report.checks.written = write.ok
      if (!write.ok) report.checks.error = errorClass(write.error)
      return
    }
    case 'read': {
      const read = await attempt(() => new AsyncEntry(service, 'sp16-cross', PINNED).getPassword())
      report.checks.readOk = read.ok
      report.checks.readEqual = read.ok && read.value === process.env.SP16_VALUE
      if (!read.ok) report.checks.error = errorClass(read.error)
      return
    }
    case 'remove':
    case 'cleanup': {
      let removed = 0
      for (const account of ACCOUNTS) {
        const gone = await attempt(() =>
          new AsyncEntry(service, account, PINNED).deleteCredential()
        )
        if (gone.ok && gone.value === true) removed += 1
      }
      report.checks.removed = removed
      return
    }
    default:
      report.checks.mode = `unknown mode ${mode}`
  }
}

main()
  .catch((error) => {
    report.checks.unexpected = errorClass(error)
  })
  .finally(() => {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  })
