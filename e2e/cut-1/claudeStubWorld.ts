import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { IsolatedProfile } from '../_harness/launchApp.ts'
import { STUB_BIN } from '../_harness/stubs.ts'

/**
 * The cut-1 fixture world of the L9 observation cases (ISSUE-123; `17` §1.9): one Claude session in one mine, replayed
 * by the claude stub of the ISSUE-313 kit (`fixtures/bin/claude`) into the profile's own `CLAUDE_CONFIG_DIR`, never the
 * developer's. The script is the kit's `claude-session-one-turn` one turn, re-dated to a moment ago and pointed at a
 * mine folder inside the profile, so the cut-1 Host observes it as a present dwarf of a live mine.
 */

/** The session's id, fixed so a case can name it. */
export const STUB_SESSION_ID = '00000000-0000-4000-8000-0000000001a1'

/** The mine folder's name inside the profile. */
export const STUB_MINE_NAME = 'moria'

/** The one turn the session holds, oldest first. */
export const STUB_TURN = {
  person: 'Summarize the sample project.',
  dwarf: 'The sample project is a placeholder.'
} as const

export interface ClaudeStubWorld {
  /** The mine folder the session works in. */
  readonly minePath: string
  /** The script the stub replayed (the app's own claude stub reads the same one if it is ever run). */
  readonly script: string
}

/** Writes the re-dated script into `profile` and runs the claude stub once, so the transcript exists before launch. */
export function seedClaudeStubSession(profile: IsolatedProfile): ClaudeStubWorld {
  const minePath = path.join(profile.root, STUB_MINE_NAME)
  mkdirSync(minePath, { recursive: true })
  const startedAt = Date.now() - 5_000
  const record = (type: 'user' | 'assistant', index: number, message: unknown) => ({
    type,
    uuid: `00000000-0000-4000-8000-00000000020${index}`,
    parentUuid: index === 1 ? null : `00000000-0000-4000-8000-00000000020${index - 1}`,
    sessionId: STUB_SESSION_ID,
    cwd: minePath,
    version: '2.1.14',
    timestamp: new Date(startedAt + index * 1_000).toISOString(),
    message
  })
  const script = path.join(profile.root, 'claude-stub-script.json')
  writeFileSync(
    script,
    JSON.stringify({
      version: '2.1.14 (Claude Code)',
      replay: [
        {
          // Claude Code's own project folder name: the working folder with every other character a dash.
          file: `projects/${minePath.replaceAll(/[^A-Za-z0-9]/g, '-')}/${STUB_SESSION_ID}.jsonl`,
          records: [
            record('user', 1, { role: 'user', content: STUB_TURN.person }),
            record('assistant', 2, {
              id: 'msg_0000000000000000000001a1',
              type: 'message',
              role: 'assistant',
              model: 'sample-model',
              content: [{ type: 'text', text: STUB_TURN.dwarf }],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 12,
                output_tokens: 8,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
              }
            })
          ]
        }
      ],
      exitCode: 0
    })
  )
  execFileSync(process.execPath, [path.join(STUB_BIN, 'claude', 'claude.mjs')], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
      DWARFAI_STUB_CLAUDE_SCRIPT: script
    },
    stdio: 'ignore'
  })
  return { minePath, script }
}

/** A dwarf and its chat as the Host's snapshot reports them (A-N01; 14 §4). */
export interface ObservedDwarf {
  readonly id: string
  readonly providerId: string
  readonly mineName: string | null
  readonly presence: string
  readonly messages: ReadonlyArray<{
    readonly id: string
    readonly role: string
    readonly text: string
  }>
}

interface SnapshotChunk {
  section: string
  data: unknown
}

/** Every dwarf of the Host's snapshot, read through the renderer's own A-N01 (`window.api.getHostSnapshot`). */
export async function observedDwarfs(window: Page): Promise<ObservedDwarf[]> {
  const answer = (await window.evaluate(
    "window.api.getHostSnapshot({ sections: ['mines', 'dwarfs', 'tails'] })"
  )) as { ok: boolean; value?: { chunks: SnapshotChunk[] } }
  if (!answer.ok || answer.value === undefined) return []
  const section = (name: string) =>
    answer.value!.chunks.filter((c) => c.section === name).flatMap((c) => c.data as unknown[])
  const mines = section('mines') as Array<{ id: string; name: string }>
  const tails = section('tails') as Array<{ dwarfId: string; messages: ObservedDwarf['messages'] }>
  const dwarfs = section('dwarfs') as Array<{
    id: string
    mineId: string
    providerId: string
    presence: string
  }>
  return dwarfs.map((dwarf) => ({
    id: dwarf.id,
    providerId: dwarf.providerId,
    mineName: mines.find((mine) => mine.id === dwarf.mineId)?.name ?? null,
    presence: dwarf.presence,
    messages: (tails.find((tail) => tail.dwarfId === dwarf.id)?.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text
    }))
  }))
}
