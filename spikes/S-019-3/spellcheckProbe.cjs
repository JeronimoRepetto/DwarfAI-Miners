// Spike S-019-3 probe app (ADR-019 D1; spike register S-019-3), run by spellcheck.mjs with the repository's Electron:
//
//   electron spikes/S-019-3/spellcheckProbe.cjs <report file> <mode> <userData dir>
//
// Modes: `off` (webPreferences.spellcheck false), `on` (true, Electron's default dictionary download URL), `on-unreachable`
// (true, the download URL set to a closed local port, so no dictionary can be fetched) and `cached-unreachable` (as
// `on-unreachable`, reusing the userData folder an `on` run filled). The probe opens one window with a misspelled text
// in a focused textarea, records every request of its session and the dictionary download events, right-clicks the
// first misspelled word and records what Chromium reports for it (`misspelledWord`, `dictionarySuggestions`), then
// writes one JSON report and quits. It never runs the product.
// A main-process error must never open a modal on the desktop: it is written into the report and the probe exits.
const { writeFileSync } = process.getBuiltinModule('node:fs')
const { app, BrowserWindow, session } = process
  .getBuiltinModule('node:module')
  .createRequire(__filename)('electron')

const [reportFile, mode, userData] = process.argv.slice(-3)
app.setPath('userData', userData)

const report = {
  mode,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  requests: [],
  dictionaryEvents: [],
  languages: null,
  availableLanguages: null,
  contextMenu: null,
  errors: []
}

function finish() {
  if (report.finished) return
  report.finished = true
  writeFileSync(reportFile, JSON.stringify(report, null, 2))
  app.exit(0)
}

app.whenReady().then(async () => {
  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest((details, callback) => {
    report.requests.push(details.url)
    callback({})
  })
  for (const event of [
    'spellcheck-dictionary-initialized',
    'spellcheck-dictionary-download-begin',
    'spellcheck-dictionary-download-success',
    'spellcheck-dictionary-download-failure'
  ]) {
    ses.on(event, (_e, languageCode) => report.dictionaryEvents.push({ event, languageCode }))
  }
  if (mode === 'on-unreachable' || mode === 'cached-unreachable') {
    ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')
  }
  const spellcheck = mode !== 'off'
  if (spellcheck && process.platform !== 'darwin') {
    try {
      ses.setSpellCheckerLanguages(['en-US'])
    } catch (error) {
      report.errors.push(`setSpellCheckerLanguages: ${error.message}`)
    }
  }
  report.languages = ses.getSpellCheckerLanguages()
  report.availableLanguages = ses.availableSpellCheckerLanguages.length
  const win = new BrowserWindow({
    width: 600,
    height: 300,
    show: true,
    webPreferences: { spellcheck, sandbox: true, contextIsolation: true }
  })
  win.webContents.on('context-menu', (_e, params) => {
    report.contextMenu = {
      misspelledWord: params.misspelledWord,
      dictionarySuggestions: params.dictionarySuggestions
    }
  })
  const html =
    '<!doctype html><body style="margin:0"><textarea id="t" style="position:absolute;left:0;top:0;width:580px;height:100px;font:20px sans-serif">' +
    'Thiss sentense has misspeled wordz</textarea><script>const t=document.getElementById("t");t.focus();' +
    't.setSelectionRange(0,0)</script></body>'
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  win.focus()
  // Give the spellchecker time to load or download its dictionary and to mark the text.
  await new Promise((resolve) => setTimeout(resolve, 8000))
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, x: 20, y: 15, button: 'right', clickCount: 1 })
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  report.languagesAfter = ses.getSpellCheckerLanguages()
  finish()
})

for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    report.errors.push(`${event}: ${error?.stack ?? error}`)
    finish()
  })
}

setTimeout(() => {
  report.errors.push('timed out')
  finish()
}, 45000)
