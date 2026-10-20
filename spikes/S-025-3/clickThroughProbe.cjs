'use strict'
// Spike S-025-3 (ADR-025 D4; spike register S-025-3): a throwaway Electron app that shows one transparent, frameless,
// always-on-top window with an opaque island in its middle and transparent corners around it, so a person can check on
// each Linux session type (and on Windows and macOS, for comparison):
//
// - compositing: are the transparent corners see-through, or drawn black or grey?
// - forwarding: with setIgnoreMouseEvents(true, { forward: true }), does the page still receive mouse moves?
// - click-through: does a click on a transparent corner reach the window underneath?
//
// The procedure is `linux-sessions.md`.
//
//   pnpm exec electron spikes/S-025-3/clickThroughProbe.cjs [--seconds <n>] [--no-forward]
//
// The window starts ignoring the mouse with `forward: true` (`--no-forward` drops it). The page reports each mouse move
// and click through its console; while the pointer is over the island the probe stops ignoring the mouse, so the
// island is clickable, and starts again when the pointer leaves (the ADR-025 D4 hit-testing). The probe prints one JSON
// line per event and a summary when it quits (default after 90 s). It never takes the focus by itself; a failure is
// printed and ends the process with a non-zero code, never a dialog.

const { app, BrowserWindow, screen } = process
  .getBuiltinModule('node:module')
  .createRequire(__filename)('electron')
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

const emit = (event, data) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`)
const fail = (where, error) => {
  emit('error', { where, message: String((error && error.message) || error) })
  process.exit(70)
}
process.on('uncaughtException', (error) => fail('uncaughtException', error))

const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const seconds = Number(argument('--seconds') || 90)
const forward = !process.argv.includes('--no-forward')

// A throwaway profile: the probe never touches a real app's data.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dwarfai-s0253-')))

// The island is the middle 160 x 80 of a 320 x 200 window; the rest is transparent.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#island{position:absolute;left:80px;top:60px;width:160px;height:80px;border-radius:40px;background:#d9a441;
color:#1e1e1e;font:13px sans-serif;display:flex;align-items:center;justify-content:center}</style></head>
<body><div id="island">S-025-3 island</div><script>
const island = document.getElementById('island')
const report = (event, extra) => console.log('s0253:' + JSON.stringify(Object.assign({ event }, extra)))
document.addEventListener('mousemove', (e) => {
  const r = island.getBoundingClientRect()
  const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  report('move', { x: e.clientX, y: e.clientY, overIsland: over })
})
document.addEventListener('mousedown', (e) => report('click', { x: e.clientX, y: e.clientY, onIsland: e.target === island }))
</script></body></html>`)}`

app
  .whenReady()
  .then(async () => {
    const area = screen.getPrimaryDisplay().workArea
    const size = { width: 320, height: 200 }
    const win = new BrowserWindow({
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: Math.round(area.y + (area.height - size.height) / 2),
      ...size,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    let ignoring = true
    const summary = {
      movesWhileIgnoring: 0,
      movesWhileAccepting: 0,
      clicksOnIsland: 0,
      clicksElsewhere: 0
    }
    const setIgnoring = (value) => {
      ignoring = value
      if (value) win.setIgnoreMouseEvents(true, forward ? { forward: true } : undefined)
      else win.setIgnoreMouseEvents(false)
      emit('ignoreMouseEvents', { ignoring: value, forward: value ? forward : null })
    }
    // Electron passes one details object (`message`) on current versions and positional arguments on older ones.
    win.webContents.on('console-message', (details, _level, positional) => {
      const text = typeof details.message === 'string' ? details.message : positional
      if (typeof text !== 'string' || !text.startsWith('s0253:')) return
      const data = JSON.parse(text.slice('s0253:'.length))
      if (data.event === 'move') {
        if (ignoring) summary.movesWhileIgnoring += 1
        else summary.movesWhileAccepting += 1
        if (data.overIsland === ignoring) setIgnoring(!data.overIsland)
      } else if (data.event === 'click') {
        if (data.onIsland) summary.clicksOnIsland += 1
        else summary.clicksElsewhere += 1
        emit('click', data)
      }
    })
    await win.loadURL(PAGE)
    setIgnoring(true)
    win.showInactive()
    emit('shown', {
      platform: process.platform,
      osRelease: os.release(),
      electron: process.versions.electron,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      waylandDisplay: Boolean(process.env.WAYLAND_DISPLAY),
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
      forward,
      bounds: win.getBounds()
    })
    setTimeout(() => {
      emit('summary', { ...summary, boundsAtEnd: win.getBounds() })
      app.exit(0)
    }, seconds * 1000)
  })
  .catch((error) => fail('whenReady', error))
