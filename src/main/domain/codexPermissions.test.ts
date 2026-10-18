import { describe, expect, it } from 'vitest'
import { parseLaunchPermissionMode } from './codexPermissions'
import { CODEX_PERMISSION_MODES, isCodexPermissionMode } from './types'

/*
 * #635 (PO decision 2026-09-28): the Add panel offers Codex's own permission
 * modes. The renderer carries a mode id and nothing else; whether a launch may
 * name one is decided here, in main. (ISSUE-185: the flags each id meant for
 * today's `codex exec` launch, `codexPermissionArgs`, left with that launch.)
 */
describe('isCodexPermissionMode', () => {
  it('admits the three modes and nothing else', () => {
    expect(CODEX_PERMISSION_MODES).toEqual(['default', 'workspace-write', 'read-only'])
    for (const mode of CODEX_PERMISSION_MODES) expect(isCodexPermissionMode(mode)).toBe(true)
    for (const other of ['danger-full-access', 'never', 'plan', '', 'READ-ONLY', 42, null]) {
      expect(isCodexPermissionMode(other)).toBe(false)
    }
  })
})

describe('parseLaunchPermissionMode', () => {
  it('reads an absent mode as "say nothing", for any provider', () => {
    expect(parseLaunchPermissionMode('codex', {})).toEqual({})
    expect(parseLaunchPermissionMode('claude', {})).toEqual({})
  })

  it("keeps a Codex launch's mode when it is one of Codex's own", () => {
    expect(parseLaunchPermissionMode('codex', { permissionMode: 'read-only' })).toEqual({
      permissionMode: 'read-only'
    })
    expect(parseLaunchPermissionMode('codex', { permissionMode: 'default' })).toEqual({
      permissionMode: 'default'
    })
  })

  it('refuses the whole request for a mode Codex does not have, rather than dropping it', () => {
    for (const mode of ['danger-full-access', 'bypassPermissions', 'plan', '', 7, null]) {
      expect(parseLaunchPermissionMode('codex', { permissionMode: mode })).toBeNull()
    }
  })

  it('refuses a mode on a detached launch of any other provider, which has no such flag wired', () => {
    // A control that looks like it works and silently does nothing is the
    // failure PERMISSION_MODE_PROVIDERS exists to prevent.
    expect(parseLaunchPermissionMode('claude', { permissionMode: 'read-only' })).toBeNull()
    expect(parseLaunchPermissionMode('opencode', { permissionMode: 'default' })).toBeNull()
    expect(parseLaunchPermissionMode('antigravity', { permissionMode: 'read-only' })).toBeNull()
  })
})
