import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

/**
 * Packaged-build check of the window CSP (ADR-019 item 4 and Verification; 18 C-03 and its §6 row; release lane, 17
 * §1.13). It reads the `index.html` the build ships (`out/renderer/index.html`, what electron-builder packs) rather
 * than the source, because the dev-only HMR origin must be absent from exactly that file. The build is the lane's own
 * first step (`pnpm build`); a missing build fails here, never skips.
 */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUILT_INDEX = path.join(APP_DIR, 'out', 'renderer', 'index.html')

test('[ADR-019] the packaged index.html CSP has connect-src self and no ws origin', () => {
  expect(existsSync(BUILT_INDEX), `${BUILT_INDEX} exists (run pnpm build first)`).toBe(true)
  const html = readFileSync(BUILT_INDEX, 'utf8')
  const policies = [
    ...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)
  ].map((match) => match[1] ?? '')
  expect(policies, 'one CSP meta tag').toHaveLength(1)
  const directives = policies[0]!.split(';').map((directive) => directive.trim())
  expect(directives).toContain("connect-src 'self'")
  expect(policies[0]).not.toMatch(/wss?:/)
  expect(policies[0]).not.toContain('localhost')
})
