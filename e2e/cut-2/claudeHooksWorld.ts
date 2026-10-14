import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { IsolatedProfile } from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'

/**
 * The cut-2 fixture world of the Claude Code hook entry (ISSUE-141; `17` §1.9): the profile's own `CLAUDE_CONFIG_DIR`
 * (never the developer's), its `settings.json`, a foreign hook entry the person wrote themselves, and the first-run
 * consent step as the Panel draws it (WelcomeStep.vue, AMENDMENT-7). Read only through the file the Host writes, the
 * renderer's own `window.api`, the DOM, and the Host database after its Host exited.
 */

/** Claude Code's settings file in the profile (16 §7.1: `<CLAUDE_CONFIG_DIR>/settings.json`). */
export function claudeSettingsPath(profile: IsolatedProfile): string {
  return path.join(profile.claudeConfigDir, 'settings.json')
}

/** The settings file's text, or null when there is none. */
export function claudeSettings(profile: IsolatedProfile): string | null {
  const file = claudeSettingsPath(profile)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** A hook the person wrote themselves, which DwarfAI never owns (ADR-016 item 6). */
export const FOREIGN_COMMAND = 'node ./scripts/notify-me.mjs --from-claude'

/**
 * The foreign entry, laid out by hand (two-space indent, a trailing newline), so a rewrite of it would show as a byte
 * change: the line holding its command is compared byte for byte.
 */
export function seedForeignEntry(profile: IsolatedProfile): void {
  writeFileSync(
    claudeSettingsPath(profile),
    [
      '{',
      '  "hooks": {',
      '    "Stop": [',
      '      {',
      '        "matcher": "",',
      `        "hooks": [ { "type": "command", "command": "${FOREIGN_COMMAND}" } ]`,
      '      }',
      '    ]',
      '  }',
      '}',
      ''
    ].join('\n')
  )
}

/** The line of `text` that carries the foreign command (it must be there exactly once). */
export function foreignLine(text: string | null): string {
  const lines = (text ?? '').split('\n').filter((line) => line.includes(FOREIGN_COMMAND))
  if (lines.length !== 1) throw new Error(`the foreign hook is on ${lines.length} lines`)
  return lines[0] as string
}

/** The commands of every hook handler in the settings file. */
export function hookCommands(text: string | null): string[] {
  if (text === null) return []
  const parsed = JSON.parse(text) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>
  }
  return Object.values(parsed.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) =>
      (group.hooks ?? []).flatMap((handler) =>
        typeof handler.command === 'string' ? [handler.command] : []
      )
    )
  )
}

/** Whether a command is DwarfAI's own entry: a call to the Host ingress's Claude route (ADR-016 item 1). */
export const isHostEntry = (command: string): boolean => command.includes('/hooks/claude/')

/** Whether a command is the old app's entry: a call to today's loopback route. */
export const isOldAppEntry = (command: string): boolean => command.includes('dwarfai-miners-hook')

/** The first-run consent step's dialog, as the Panel draws it. */
export function welcomeStep(window: Page) {
  const dialog = window.locator('.dm-scrim')
  return {
    dialog,
    options: dialog.locator('.welcome-step__options'),
    toggles: dialog.getByRole('switch'),
    activate: dialog.getByRole('button', { name: 'Activate' })
  }
}

/** The Host's persisted ingress port (`app_meta.ingress_port`), read after its Host exited. */
export function persistedIngressPort(profile: IsolatedProfile): number | null {
  const db = openHostDatabaseReadOnly(profile)
  try {
    const row = db.prepare('SELECT ingress_port FROM app_meta WHERE id = 1').get() as
      { ingress_port: number | null } | undefined
    return row?.ingress_port ?? null
  } finally {
    db.close()
  }
}

/**
 * Waits for the first-run step's options, as a case does before it answers the step. When they never show, the failure
 * names what the Host reported for the step through the window's own A-N01 read (the snapshot's `preferences` section:
 * `welcome.due`, `offered`, `reason`), so a run on another machine says whether the Host found the step not due or the
 * window did not draw it.
 */
export async function expectStepShown(window: Page, timeout = 60_000): Promise<void> {
  try {
    await expect(welcomeStep(window).options, 'the first-run step is shown').toBeVisible({
      timeout
    })
  } catch (error) {
    const reported = await window
      .evaluate(async () => {
        const api = (
          window as unknown as { api: { getHostSnapshot(r: unknown): Promise<unknown> } }
        ).api
        return JSON.stringify(await api.getHostSnapshot({ sections: ['preferences'] }))
      })
      .catch((cause: unknown) => `the snapshot could not be read: ${String(cause)}`)
    throw new Error(`${(error as Error).message}\nThe Host's preferences snapshot: ${reported}`)
  }
}
