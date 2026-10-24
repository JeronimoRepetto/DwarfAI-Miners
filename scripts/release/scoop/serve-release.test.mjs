// layer: L7
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startReleaseServer } from './serve-release.mjs'

// The Scoop check (scoop-check.ps1) downloads the zip it just built from this loopback server, so nothing comes from
// the internet and Scoop checks the manifest hash against the real file.

let dir
let server
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scoop-serve-'))
  writeFileSync(path.join(dir, 'DwarfAI-Miners-1.2.3-win-x64.zip'), 'zip bytes')
})
afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('Scoop check release server', () => {
  it('[ADR-027] serves a top-level file of the release folder on loopback, byte for byte', async () => {
    server = await startReleaseServer(dir)

    const response = await fetch(`${server.url}DwarfAI-Miners-1.2.3-win-x64.zip`)

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('zip bytes')
  })

  it('[ADR-027] answers 404 for a missing file and for any path outside the folder', async () => {
    server = await startReleaseServer(dir)

    expect((await fetch(`${server.url}absent.zip`)).status).toBe(404)
    expect((await fetch(`${server.url}..%2Fsecret.txt`)).status).toBe(404)
    expect((await fetch(`${server.url}sub%5Cfile.zip`)).status).toBe(404)
  })
})
