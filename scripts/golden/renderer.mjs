/*
 * The reference renderer, driven through the design repository's own capture code at run time:
 * `tools/lib/cdp.js` launches the browser with the flags in `tools/lib/capture.js`, the page gets
 * that file's viewport, media, time zone and locale, and `tools/snap-runtime.js` is injected
 * before any page script so timers, Date and Math.random hold still exactly as they did when the
 * references were taken. Nothing of it is copied here.
 *
 * The references were taken by one browser build, recorded in `docs/reference/capture.json`. A
 * browser that has updated itself renders text edges and blends differently, so a mismatch FAILS
 * naming both builds rather than grading against the wrong renderer (PO ruling G-01,
 * 2026-09-26). `GOLDEN_BROWSER` pins a browser executable, for keeping the recorded build around.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const BROWSER_ENV = 'GOLDEN_BROWSER'

// settle()'s own drain loop (#635): a mount can still be waiting on a microtask chain that only
// queues its virtual animation frame *after* that microtask resolves — DwarfMessagePanel's
// showLatest scrolls to the newest message one frame after the panel is built — so advancing the
// clock once and calling it done can capture a page whose rAF-gated write never landed
// (organisms/message-panel#conversation and #asking measured 31.7% differing on exactly this).
// Capped so a page that genuinely never settles fails loudly naming the state, instead of being
// captured half-drained.
export const SETTLE_DRAIN_LIMIT = 20

// The drain loop's stopping rule, pure so it is provable without a real browser page: quiescent
// once the stage's own signature has held steady across a pass — one probe alone, even one that
// looks at rest, proves nothing about stability, since the pending callback that just ran may be
// the one write being waited for. Whether a virtual timer is still queued is deliberately not part
// of this: window.__snapRuntime's clock() counts every scheduled timer, including an ordinary
// setInterval a component is entitled to keep running forever (DwarfMessagePanel's own idle-time
// ticker), so "nothing pending" would never become true for such a state and the loop would always
// run out its cap. The signature is the thing a capture actually grades.
export function settleDrainOutcome({ pass, signature, previousSignature }) {
  if (previousSignature !== null && signature === previousSignature) {
    return { done: true, exceeded: false }
  }
  if (pass >= SETTLE_DRAIN_LIMIT) return { done: true, exceeded: true }
  return { done: false, exceeded: false }
}

export function rendererMismatch(actual, recorded) {
  if (actual.product === recorded.product && actual.userAgent === recorded.userAgent) return null
  return (
    'golden: the browser is ' +
    actual.product +
    ' (' +
    actual.userAgent +
    '), but the references were taken with ' +
    recorded.product +
    ' (' +
    recorded.userAgent +
    '), per docs/reference/capture.json. Retake the references on this browser in the design ' +
    'repository, or pin the recorded one with ' +
    BROWSER_ENV +
    '=<path to its executable>.'
  )
}

export function recordedRenderer(designRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(designRoot, 'docs', 'reference', 'capture.json'), 'utf8')
  )
}

export async function openRenderer(designRoot, env = process.env) {
  const load = createRequire(import.meta.url)
  const cdp = load(path.join(designRoot, 'tools', 'lib', 'cdp.js'))
  const capture = load(path.join(designRoot, 'tools', 'lib', 'capture.js'))
  const runtime = fs.readFileSync(path.join(designRoot, 'tools', 'snap-runtime.js'), 'utf8')
  const pinned = (env[BROWSER_ENV] ?? '').trim()
  if (pinned && !fs.existsSync(pinned)) {
    throw new Error('golden: ' + BROWSER_ENV + ' names ' + pinned + ', which does not exist.')
  }
  const browser = await cdp.launch(cdp.findBrowser(pinned || null))
  const { product, userAgent } = await browser.send('Browser.getVersion')
  return { browser, capture, runtime, version: { product, userAgent } }
}

export async function openPage({ browser, capture, runtime }) {
  const page = await browser.page()
  const errors = []
  page.on((method, p) => {
    if (method === 'Runtime.exceptionThrown') {
      errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)
    }
  })
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: capture.VIEWPORT.width,
    height: capture.VIEWPORT.height,
    deviceScaleFactor: capture.DEVICE_SCALE_FACTOR,
    mobile: false
  })
  await page.send('Emulation.setEmulatedMedia', {
    media: capture.MEDIA,
    features: capture.MEDIA_FEATURES
  })
  await page.send('Emulation.setTimezoneOverride', { timezoneId: capture.TIMEZONE })
  await page.send('Emulation.setLocaleOverride', { locale: capture.LOCALE })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: runtime })

  const evaluate = async (expression) => {
    const r = await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result.value
  }
  return {
    errors,
    evaluate,
    async navigate(url) {
      const loaded = page.waitFor('Page.loadEventFired', 60000)
      await page.send('Page.navigate', { url })
      await loaded
      await evaluate('window.golden.ready')
    },
    // What a reference capture holds still (the design's docs, "What a capture holds still"):
    // fonts and already-present images given the chance to resolve before any virtual timer may
    // fire, SETTLE_MS of virtual time, fonts and images decoded again for anything the mount added,
    // a drain for any mount-time write still gated behind a microtask-then-frame chain (#635),
    // finite animations finished and loops held at their first keyframe, two real frames painted.
    // `stateId` names the state in a drain failure only — it changes nothing about what settles.
    settle: async (stateId) => {
      await evaluate(`(async () => {
        const R = window.__snapRuntime
        // A mount's own rAF-gated write (DwarfMessagePanel's showLatest, scrolling its log to the
        // newest message one virtual frame after the panel is built) can run inside the very first
        // virtual frame, long before a locally-hosted @fontsource face has actually finished
        // loading and reflowed its text. Read then, list.scrollTop = list.scrollHeight measures a
        // scrollHeight smaller than the one the reference was captured under, and nothing reads it
        // again afterwards (#635: organisms/message-panel#conversation and #asking measured 31.7%
        // differing, the log stuck short of the bottom by exactly the font reflow's own growth).
        // Letting fonts and images resolve before the clock is allowed to move at all means the
        // mount's write sees the same final layout the reference was captured under.
        await document.fonts.ready
        await R.images(document.body)
        await R.advance(${Number(capture.SETTLE_MS)})
        // The app's sprites play on a JavaScript frame clock the runtime's freeze cannot reach:
        // the golden page holds them the same way (page.ts, captureFrameClock).
        window.golden?.holdSprites?.()
        await document.fonts.ready
        await R.images(document.body)
        await R.advance(0)
        return true
      })()`)
      await drainMountFrames()
      await evaluate(`(async () => {
        const R = window.__snapRuntime
        R.freeze()
        await R.frame()
        await R.frame()
        R.freeze()
        return true
      })()`)

      // Still a mount can be one microtask-then-frame away from a write it makes only after the
      // panel is actually built. Repeats a cheap probe — one virtual frame of time, then a
      // signature of the mounted stage's markup, scroll positions and scrollable extents — until
      // the signature holds across a pass, so a write is known to have landed and stopped moving,
      // not merely fired once. holdSprites() already ran above, so a sprite's own frame timer
      // cannot be what keeps this looping: spriteClock.dispose() cancelled it (page.ts,
      // captureFrameClock.hold). `pending` (an ordinary component timer such as DwarfMessagePanel's
      // idle-time ticker can leave the runtime's queue permanently non-empty) is read only for the
      // exceeded message, never for the quiescence decision — see settleDrainOutcome.
      async function drainMountFrames() {
        let previousSignature = null
        for (let pass = 1; ; pass++) {
          const probe = await evaluate(`(async () => {
            const R = window.__snapRuntime
            await R.macrotask()
            await R.advance(16)
            const stage = document.querySelector('.kit-stage[data-golden]') || document.body
            let signature = String(stage.innerHTML.length)
            stage.querySelectorAll('*').forEach(function (el) {
              signature += ':' + el.scrollTop + ',' + el.scrollHeight
            })
            return { pending: R.clock().pending, signature: signature }
          })()`)
          const outcome = settleDrainOutcome({
            pass,
            signature: probe.signature,
            previousSignature
          })
          previousSignature = probe.signature
          if (outcome.exceeded) {
            throw new Error(
              'golden: settle for ' +
                (stateId ?? '(unnamed state)') +
                ' did not reach quiescence after ' +
                SETTLE_DRAIN_LIMIT +
                ' drain passes (stage still changing; ' +
                probe.pending +
                ' virtual timer(s) queued) — captured half-drained instead of failing loudly ' +
                'would have hidden a page that never actually settles.'
            )
          }
          if (outcome.done) break
        }
      }
    },
    // The page as a window of this size (#635): a full-screen golden sizes it to the work area.
    resize: (width, height) =>
      page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: capture.DEVICE_SCALE_FACTOR,
        mobile: false
      }),
    // A real input event over the DevTools protocol, as the design's recipes send them.
    mouse: (type, x, y, extra = {}) =>
      page.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        ...extra
      }),
    key: (type, event) => page.send('Input.dispatchKeyEvent', { type, ...event }),
    // What a full-screen reference holds still between two steps (docs/README.md, Full-screen
    // references): SETTLE_MS of virtual time with every finite animation the step started finished.
    settleStep: () => evaluate('window.__snapRuntime.settle(' + Number(capture.SETTLE_MS) + ')'),
    // And before its capture: the step's settle, the sprites held as a kit state holds them, fonts
    // and images decoded, everything frozen, and painted.
    settleScreen: () =>
      evaluate(`(async () => {
        const R = window.__snapRuntime
        await R.settle(${Number(capture.SETTLE_MS)})
        window.golden?.holdSprites?.()
        await document.fonts.ready
        await R.images(document.body)
        await R.advance(0)
        R.freeze()
        await R.frame()
        await R.frame()
        R.freeze()
        await document.fonts.ready
        await R.frame()
        await R.frame()
        return true
      })()`),
    // `beyond` false keeps the viewport as it is (#635): capturing beyond it resizes the page for
    // the shot, and a full App answers a resize (useShellFold) as a window would.
    async shot(box, { beyond = true } = {}) {
      const { data } = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...box, scale: 1 },
        captureBeyondViewport: beyond,
        fromSurface: true
      })
      return Buffer.from(data, 'base64')
    }
  }
}
