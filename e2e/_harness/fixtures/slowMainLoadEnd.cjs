'use strict'
// A harness self-test's injected delay (harness.e2e.ts), preloaded with `launchApp`'s `mainPreloads`. The app's page
// fires its `load` event, and only then, from inside that event, starts a hidden sub-frame (slowFrame.html) that takes
// 1.5 s to load. So the renderer's `load` comes while main's `webContents.isLoading()` still answers true, as on a slow
// CI runner (run 37036544456: Playwright saw `load` about 110 ms before main's `did-stop-loading`), but deterministic.
//
// How: a session preload (Electron's `registerPreloadScript`) runs in the page before its own scripts and adds the
// sub-frame from the top frame's `load` listener. It is written into the test profile, beside the main-process error
// log, with the frame's URL in it (a sandboxed preload has no path of its own). Test-only; no production code loads
// it. It never throws into the app.
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url')

try {
  const { app, session } = process.getBuiltinModule('node:module').createRequire(__filename)(
    'electron'
  )
  const errorsFile = process.env.DWARFAI_E2E_MAIN_ERRORS
  if (errorsFile) {
    const framePreload = path.join(path.dirname(errorsFile), 'slow-frame-preload.js')
    const frameUrl = pathToFileURL(path.join(__dirname, 'slowFrame.html')).href
    fs.writeFileSync(
      framePreload,
      `if (window === window.top) {
  window.addEventListener('load', () => {
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = ${JSON.stringify(frameUrl)}
    document.body.appendChild(frame)
  }, { once: true })
}
`
    )
    app.once('ready', () => {
      try {
        session.defaultSession.registerPreloadScript({
          type: 'frame',
          id: 'dwarfai-e2e-slow-frame',
          filePath: framePreload
        })
      } catch {
        // An Electron without session preloads: the case then sees no delay.
      }
    })
  }
} catch {
  // Without Electron there is nothing to inject.
}
