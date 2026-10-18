import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { homeIn, type IsolatedProfile } from '../_harness/launchApp.ts'

/**
 * The step-4a fixture world of the OpenCode plugin file (ISSUE-235; `17` §1.9): the profile's own OpenCode plugin
 * folder under its `XDG_CONFIG_HOME` (never the developer's), and the Settings rows as the renderer's own `window.api`
 * reads them (A-52 `getOpenCodeSettings`, A-N01's `preferences` section). Read only through the file the Host writes,
 * the renderer's `window.api` and the DOM.
 */

/** The plugin file the Host writes (16 §7.1; `host/main.ts` `openCodePluginPathHere`). */
export function openCodePluginPath(profile: IsolatedProfile): string {
  const configHome = homeIn(profile)['XDG_CONFIG_HOME'] as string
  return path.join(configHome, 'opencode', 'plugin', 'dwarfai-miners-permission.ts')
}

/** The plugin file's text, or null when there is none. */
export function openCodePlugin(profile: IsolatedProfile): string | null {
  const file = openCodePluginPath(profile)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** A UUIDv7 request id, as the renderer mints one per intent (14 §1.6). */
export function uuidV7(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface RendererApi {
  api: {
    getOpenCodeSettings(): Promise<unknown>
    getHostSnapshot(request: unknown): Promise<unknown>
  }
}

/** A-52 as Settings reads it: the Host's `OpenCodeSettingsView`. */
export async function openCodeSettings(
  window: Page
): Promise<{ ok: boolean; value?: { permissions: string; consentOrigin?: string } }> {
  return (await window.evaluate(() =>
    (globalThis as unknown as RendererApi).api.getOpenCodeSettings()
  )) as { ok: boolean; value?: { permissions: string; consentOrigin?: string } }
}

/** One integration's state in the Host's `preferences` snapshot section (A-N01), as Settings follows it. */
export async function integrationState(window: Page, id: string): Promise<string | undefined> {
  return window.evaluate(async (wanted) => {
    type Answer = {
      ok: boolean
      value?: {
        chunks: Array<{
          section: string
          data: { integrations?: Array<{ id: string; state: string }> }
        }>
      }
    }
    const answer = (await (globalThis as unknown as RendererApi).api.getHostSnapshot({
      sections: ['preferences']
    })) as Answer
    const chunk = answer.value?.chunks.find((candidate) => candidate.section === 'preferences')
    return chunk?.data.integrations?.find((setting) => setting.id === wanted)?.state
  }, id)
}
