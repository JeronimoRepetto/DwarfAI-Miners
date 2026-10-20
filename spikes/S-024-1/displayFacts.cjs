'use strict'
// Spike S-024-1 (ADR-024 D5; spike register S-024-1): what Electron reports about each display, so a person can take
// a snapshot before and after a reboot, a display-driver update and a dock/undock and see which facts stayed the same.
// The facts that stay the same are the candidates for Veta's `displayKey`. The procedure is `display-facts.md`.
//
//   pnpm exec electron spikes/S-024-1/displayFacts.cjs --label <step> --out <file.json>
//   node spikes/S-024-1/displayFacts.cjs compare <before.json> <after.json>
//
// Under Electron it opens no window: it reads `screen.getAllDisplays()` once the app is ready, writes the JSON and
// quits. Under Node it only compares two snapshots. A failure is printed and ends the process with a non-zero code;
// it never opens a dialog.

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')

/** The facts read from one Electron `Display`. */
function displayFacts(display, primaryId) {
  return {
    id: String(display.id),
    label: display.label,
    primary: display.id === primaryId,
    internal: display.internal,
    bounds: display.bounds,
    workArea: display.workArea,
    size: display.size,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    displayFrequency: display.displayFrequency,
    colorDepth: display.colorDepth,
    detected: display.detected
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function snapshot() {
  const { app, screen } = process.getBuiltinModule('node:module').createRequire(__filename)(
    'electron'
  )
  const out = argument('--out')
  const label = argument('--label') || 'snapshot'
  const fail = (error) => {
    process.stderr.write(`S-024-1 snapshot failed: ${String((error && error.message) || error)}\n`)
    process.exit(70)
  }
  process.on('uncaughtException', fail)
  if (!out) fail(new Error('--out <file.json> is required'))
  // A throwaway profile: the snapshot never touches a real app's data.
  app.setPath(
    'userData',
    fs.mkdtempSync(process.getBuiltinModule('node:path').join(os.tmpdir(), 'dwarfai-s0241-'))
  )
  app
    .whenReady()
    .then(() => {
      const primaryId = screen.getPrimaryDisplay().id
      const record = {
        label,
        takenAt: new Date().toISOString(),
        platform: process.platform,
        osRelease: os.release(),
        electron: process.versions.electron,
        sessionType: process.env.XDG_SESSION_TYPE || null,
        displays: screen.getAllDisplays().map((display) => displayFacts(display, primaryId))
      }
      fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)
      process.stdout.write(`S-024-1: ${record.displays.length} display(s) written to ${out}\n`)
      app.exit(0)
    })
    .catch(fail)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Pairs the displays of two snapshots by id, then by label, and lists which facts changed. */
function compare(beforeFile, afterFile) {
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))
  const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'))
  const unmatched = [...after.displays]
  const take = (predicate) => {
    const index = unmatched.findIndex(predicate)
    return index >= 0 ? unmatched.splice(index, 1)[0] : undefined
  }
  const rows = before.displays.map((display) => {
    const byId = take((candidate) => candidate.id === display.id)
    const match = byId || take((candidate) => candidate.label === display.label)
    if (!match) return { before: display.id, label: display.label, matchedBy: 'none' }
    const changed = Object.keys(display).filter((key) => !same(display[key], match[key]))
    return {
      before: display.id,
      after: match.id,
      label: display.label,
      matchedBy: byId ? 'id' : 'label',
      changed
    }
  })
  const result = {
    from: before.label,
    to: after.label,
    rows,
    newDisplays: unmatched.map((display) => ({ id: display.id, label: display.label }))
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  snapshot()
} else if (process.argv[2] === 'compare' && process.argv[3] && process.argv[4]) {
  compare(process.argv[3], process.argv[4])
} else {
  process.stderr.write(
    'usage: pnpm exec electron spikes/S-024-1/displayFacts.cjs --label <step> --out <file.json>\n' +
      '       node spikes/S-024-1/displayFacts.cjs compare <before.json> <after.json>\n'
  )
  process.exit(64)
}
