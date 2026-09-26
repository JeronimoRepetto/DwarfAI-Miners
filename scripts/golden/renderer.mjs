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
    // SETTLE_MS of virtual time, fonts and images decoded, finite animations finished and loops
    // held at their first keyframe, two real frames painted.
    settle: () =>
      evaluate(`(async () => {
        const R = window.__snapRuntime
        await R.advance(${Number(capture.SETTLE_MS)})
        await document.fonts.ready
        await R.images(document.body)
        await R.advance(0)
        R.freeze()
        await R.frame()
        await R.frame()
        R.freeze()
        return true
      })()`),
    async shot(box) {
      const { data } = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...box, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true
      })
      return Buffer.from(data, 'base64')
    }
  }
}
