// Spike S-018-1, packaged kit: the pure parts of `packagedTrayApp.mjs` (testing strategy 17 §4; ADR-018 item 5). The
// spike's electron-builder config, the signature summary, the run assessment and the report. Tested by
// `packagedTrayApp.os.test.mjs`.

const APP_ID_SUFFIX = '.spike.s0181'
const SIGN_MODES = ['developer-id', 'adhoc', 'unsigned']

/**
 * The electron-builder config of the packaged spike app, derived from the product's own (`package.json` `build`), so
 * the measured bundle is what the product build makes, with three differences: its own bundle id and name (it never
 * shares the product's notification permission, LaunchServices entry or data), the gated entry `packagedMain.cjs` as
 * `main` with only the spike's files, and no product hooks (afterPack/afterSign prune and list the product's files).
 *
 * `sign`:
 * - `developer-id`: the product's macOS signing (hardened runtime, its entitlements) with a Developer ID Application
 *   identity from the keychain, and the build fails when there is none (`forceCodeSigning`). The shipped app is
 *   signed this way (20 §, OD-2); notarization is skipped, since a locally built app is never quarantined.
 * - `adhoc`: a sealed ad-hoc signature (`identity: '-'`). Hardened runtime is off, because ad-hoc with hardened runtime
 *   needs `disable-library-validation`, an entitlement the product does not have and the spike must not add.
 * - `unsigned`: no signing step, the Electron binaries keep their linker signature (the npm-Electron state).
 */
export function builderConfig({ productionPackage, sign, outDir, entitlements }) {
  if (!SIGN_MODES.includes(sign)) throw new Error(`sign must be one of ${SIGN_MODES}`)
  const product = productionPackage.build
  const mac = {
    category: product.mac.category,
    target: 'dir',
    notarize: false,
    gatekeeperAssess: false
  }
  if (sign === 'developer-id') {
    Object.assign(mac, {
      type: 'distribution',
      hardenedRuntime: product.mac.hardenedRuntime,
      entitlements,
      entitlementsInherit: entitlements
    })
  } else {
    Object.assign(mac, { identity: sign === 'adhoc' ? '-' : null, hardenedRuntime: false })
  }
  return {
    appId: `${product.appId}${APP_ID_SUFFIX}`,
    productName: 'DwarfAI-S0181-Spike',
    executableName: 'dwarfai-s0181-spike',
    electronVersion: productionPackage.devDependencies.electron,
    directories: { output: outDir },
    extraMetadata: { main: 'packagedMain.cjs' },
    files: ['package.json', 'packagedMain.cjs', 'packagedGate.cjs', 'trayApp.cjs'],
    asar: true,
    npmRebuild: false,
    forceCodeSigning: sign !== 'unsigned',
    win: { signAndEditExecutable: false },
    mac
  }
}

/**
 * Replaces each machine value with its placeholder, also in its JSON-escaped spelling (privacy guard). A value marked
 * `{ wholeWord: true }` (the account name) is replaced only as a whole word, so `com.<name>…` ids keep their spelling.
 */
export function scrub(text, replacements) {
  let out = text
  for (const [value, placeholder, { wholeWord = false } = {}] of replacements) {
    if (!value) continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = wholeWord
        ? out.replace(
            new RegExp(`\\b${spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
            placeholder
          )
        : out.split(spelling).join(placeholder)
    }
  }
  return out
}

/** The JSON lines `trayApp.cjs` writes; any other line is skipped. */
export function parseEvents(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Not one of the app's lines.
    }
  }
  return events
}

const field = (text, name) => {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text)
  return match ? match[1].trim() : null
}

/**
 * What `codesign -dv --verbose=2` says about the bundle, without the signer's name or team id: the identifier, the
 * kind of signature (`adhoc`, `Developer ID Application`, …), the code directory flags, and whether the team id is
 * set, the Info.plist bound and the resources sealed (the record's hypothesis is about those three).
 */
export function signatureSummary(codesignText) {
  const authority = field(codesignText, 'Authority')
  const teamIdentifier = field(codesignText, 'TeamIdentifier')
  const flags = /flags=(\S+)/.exec(field(codesignText, 'CodeDirectory v') ?? '')
  return {
    identifier: field(codesignText, 'Identifier'),
    kind: authority ? authority.replace(/:.*$/, '') : field(codesignText, 'Signature'),
    flags: flags ? flags[1] : null,
    teamIdentifierSet: teamIdentifier !== null && teamIdentifier !== 'not set',
    infoPlistBound: field(codesignText, 'Info.plist') !== 'not bound',
    // `Sealed Resources=none`, or `Sealed Resources version=2 rules=… files=…` when sealed.
    sealedResources: /^Sealed Resources version=/m.test(codesignText)
  }
}

/**
 * The click run's verdict, with the npm harness's checks (`trayNotification.os.test.ts`): no window after the idle
 * time, the click reached the tray process with no window open, no error, a clean end. Launched through
 * LaunchServices (`open`), the app's exit code is not observable, so the clean end is its `done` event alone.
 */
export function assessRun(run, { exitCodeKnown = true } = {}) {
  const find = (name) => run.events.find((event) => event.event === name)
  const reasons = []
  if (find('idle')?.windows !== 0) reasons.push('a window was open after the idle time')
  const click = find('click')
  if (!click) reasons.push('the click did not reach the tray process')
  else if (click.windows !== 0) reasons.push('a window was open when the click arrived')
  if (find('error')) reasons.push('the app reported an error')
  if (exitCodeKnown ? run.exitCode !== 0 : find('done') === undefined)
    reasons.push('the app did not end cleanly')
  return { passed: reasons.length === 0, reasons }
}

/**
 * The report: the npm harness's shape (`trayNotification.os.test.ts`), plus `packaged`, what was measured (bundle id,
 * signing mode and summary, launch) and, for a click run, its assessment.
 */
export function buildReport({ platform, osRelease, mode, idleMs, waitMs, runs, packaged }) {
  const clickRun = runs.find((run) => run.mode === 'click')
  return {
    spike: 'S-018-1',
    platform,
    osRelease,
    mode,
    idleMs,
    waitMs,
    desktop: null,
    runs,
    packaged: {
      ...packaged,
      assessment: clickRun
        ? assessRun(clickRun, { exitCodeKnown: packaged.launch !== 'open' })
        : null
    }
  }
}
