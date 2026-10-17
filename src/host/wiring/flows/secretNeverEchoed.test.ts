// layer: L7
// L7 (17 §1.7 "Log redaction canary"; 14 §6.5 "Security"; NFR-SEC-12): a seeded secret value passes
// through B-M10 `settings.secret.set` and B-M11 `settings.secret.clear` on the Host as host/main.ts
// composes it (flows/testing/askingHost.ts: every module wired at boot steps 3 and 4, the real
// Host dispatcher with its diagnostics log, the connection registry, the database), with the
// `FakeSecretStore` double as the OS secret store. The value lives only in that store: it never
// reaches a row of the database, a Host log line, the argv or env of a process the Host spawned,
// the Host's own environment, a domain event, or any answer, frame or snapshot a client received
// (ADR-017 items 3–5; 18 C-22; 06 INV-107). The L6 suite (transport/methods/settingsSecret.contract.test.ts)
// scans the transport's log alone; the UI side's log is its own flow (later: ISSUE-217).
//
// TC-216-04 (with TC-216-01 for the answers and frames).
import { afterEach, describe, expect, it } from 'vitest'
import { toLogLine } from '../../../contracts/logging'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { FakeSecretStore } from '../../modules/preferences/testing/fakeSecretStore'
import { bootHost, cleanUp, world } from './testing/askingHost'

afterEach(cleanUp)

/** A seeded value (14 §6.5 "Security"): anything that carries it out of the store is a leak. */
const SEEDED = 'sk-seeded-216-l7-5c0ffee1d3a'

describe('a secret set and cleared through the Host is never echoed (NFR-SEC-12)', () => {
  it('[NFR-SEC-12] a seeded secret value never reaches the database, a Host log line, a spawned argv or env, or any answer or frame through either member', async () => {
    const w = world()
    const store = new FakeSecretStore()
    const h = await bootHost(w, { scanner: new FsSourceWeightScanner(), secrets: store })
    const { ui, notifier } = await h.clients()
    const set = (requestId: string, extra: Record<string, unknown> = {}) =>
      h.call(ui, 'settings.secret.set', {
        name: 'jev-key',
        value: SEEDED,
        requestId,
        origin: 'settings',
        ...extra
      })

    // Every path through both members: stored, de-duplicated, cleared, refused, unavailable.
    const first = h.rid()
    const stored = await set(first)
    expect(stored).toMatchObject({ ok: true, result: { ok: true, value: { configured: true } } })
    expect(await store.get('jev-key')).toBe(SEEDED)
    await set(first)
    const snapshot = await h.call(ui, 'session.snapshot', { sections: ['meta', 'preferences'] })
    expect(snapshot).toMatchObject({ ok: true })
    expect(
      await h.call(ui, 'settings.secret.clear', { name: 'jev-key', requestId: h.rid() })
    ).toMatchObject({ ok: true, result: { ok: true, value: { configured: false } } })
    expect(await set(h.rid(), { echo: SEEDED })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' }
    })
    expect(
      await h.call(notifier, 'settings.secret.set', {
        name: 'jev-key',
        value: SEEDED,
        requestId: h.rid(),
        origin: 'settings'
      })
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await set(h.rid())
    store.setBackend('unavailable')
    expect(await set(h.rid())).toMatchObject({
      ok: true,
      result: { ok: false, error: 'backend-unavailable' }
    })
    await h.settle(ui, notifier)

    // The calls were logged (method, outcome, code), so the log scan reads real lines.
    expect(
      h.log.entries.filter((entry) => entry.method === 'settings.secret.set')
    ).not.toHaveLength(0)
    const logLines = h.log.entries.map((entry) =>
      toLogLine({
        ts: '2026-01-01T00:00:00.000Z',
        proc: 'host',
        pid: 1,
        appVersion: '0.0.0',
        ...entry
      })
    )
    const tables = w.db
      .all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row['name']))
    expect(tables.length).toBeGreaterThan(0)
    const rows = tables.map((table) => w.db.all(`SELECT * FROM "${table}"`))

    expect(JSON.stringify(rows), 'a database row').not.toContain(SEEDED)
    expect(JSON.stringify([logLines, h.log.entries, h.log.refused]), 'a log line').not.toContain(
      SEEDED
    )
    expect(JSON.stringify(w.processes.spawns), 'a spawned argv or env').not.toContain(SEEDED)
    expect(JSON.stringify([process.argv, process.env]), "the Host's argv or env").not.toContain(
      SEEDED
    )
    expect(JSON.stringify(h.published), 'a domain event').not.toContain(SEEDED)
    expect(JSON.stringify([ui.frames, notifier.frames]), 'an answer or frame').not.toContain(SEEDED)
  })
})
