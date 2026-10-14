// layer: L3
// L3 (17 §1.3) parity (21 §1 item 3; #1285 acceptance): for every `fixtures/claude/hook-keystroke/
// 2.1.x` case, an in-app Allow or Deny on an observed Claude permission ask presses, through the
// whole Host path — the observed-Claude keystroke channel (ISSUE-134) → this bridge →
// conversation's `ConsoleKeystrokeDelivery` — exactly the key the legacy `permissionKeystrokeFor`
// presses, written by each OS's route; and nothing where the legacy re-read would find no open
// permission (a question, a resolved call, a sidechain call, two calls of one tool).
//
// The legacy key map cannot be imported here (R16: only src/legacy-bridge reaches src/main), so it
// is restated from `src/main/textDelivery/permissionKeys.ts` `PERMISSION_KEYSTROKES` (allow
// `{ kind: 'text', text: '1' }`, deny `{ kind: 'escape' }`) and pinned against the Host's kept copy
// (asking keyMap.ts, whose transplanted tests are keyMap.transplanted.test.ts).
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { ObservedClaudeKeystrokeChannel } from '../../modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import {
  permissionKeystrokeFor,
  type PermissionKeystroke
} from '../../modules/asking/adapters/observedClaude/keyMap'
import { PermissionPromptRegistry } from '../../modules/asking/adapters/observedClaude/permissionPromptRegistry'
import { FakeTranscriptTail } from '../../modules/asking/testing/FakeTranscriptTail'
import { ConsoleKeystrokeDelivery } from '../../modules/conversation/adapters/observed-send/ConsoleKeystrokeDelivery'
import {
  powerShellStdinLine,
  tmuxKeyArgs,
  windowsKeyWriteScript
} from '../../modules/conversation/adapters/observed-send/consoleKeys'
import { ScriptedConsoleTools } from '../../modules/conversation/adapters/observed-send/testing/ScriptedConsoleTools'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createKeystrokeRelay } from './keystrokeRelay'

const FIXTURES = fileURLToPath(
  new URL('../../../../fixtures/claude/hook-keystroke/2.1.x/', import.meta.url)
)
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const PATH = 'C:\\Users\\j\\.claude\\projects\\sample\\01a0b000.jsonl'
const PROCESS: ProcessIdentity = {
  pid: 4242,
  processStartTimeMs: 1_790_000_000_000,
  bootId: 'boot'
}

/** `src/main/textDelivery/permissionKeys.ts` `PERMISSION_KEYSTROKES`, as measured on 2.1.261. */
const LEGACY_PERMISSION_KEYSTROKES: Record<'allow' | 'deny', PermissionKeystroke> = {
  allow: { kind: 'text', text: '1' },
  deny: { kind: 'escape' }
}

interface Expected {
  pending: { id: string; toolName: string; kind: 'permission' | 'question' } | null
}

/** Every transcript case with what its re-read finds (the base case's expected file). */
const CASES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.jsonl'))
  .sort()
  .map((name) => {
    const base = name.replace(/(-crlf|-with-extra)?\.jsonl$/, '')
    const expected = JSON.parse(
      readFileSync(`${FIXTURES}${base}.expected.json`, 'utf8')
    ) as Expected
    return { name, text: readFileSync(`${FIXTURES}${name}`, 'utf8'), expected }
  })

async function answer(
  platform: 'win32' | 'linux',
  fixture: (typeof CASES)[number],
  decision: 'allow' | 'deny'
) {
  const tools = new ScriptedConsoleTools((spec) => {
    if (spec.executable === 'ps') return { code: 0, stdout: 'pts/4\n' }
    if (spec.executable === 'tmux' && spec.args[0] === 'list-panes') {
      return { code: 0, stdout: '%7 /dev/pts/4 200\n' }
    }
    return { code: 0 }
  })
  tools.script(PROCESS.pid, { ...PROCESS })
  const crew = inMemoryCrew()
  const dwarfId = crew.commands.arrive({
    mineId: MINE,
    identity: { providerId: 'claude', providerSessionId: SESSION },
    rank: rankForDepth(0),
    status: 'idle'
  })
  const delivery = new ConsoleKeystrokeDelivery({
    processes: tools,
    platform,
    env: { PATH: '/usr/bin' },
    cwd: '/home/j',
    scheduler: new FakeScheduler(new FakeClock(0))
  })
  const relay = createKeystrokeRelay({
    crew: crew.queries,
    observed: { processIdentityOf: (id) => (id === dwarfId ? { ...PROCESS } : null) },
    delivery
  })
  const tail = new FakeTranscriptTail()
  tail.set(PATH, fixture.text)
  const prompts = new PermissionPromptRegistry({ transcripts: tail, redact: (text) => text })
  await prompts.note(
    {
      event: 'PermissionRequest',
      sessionId: SESSION,
      transcriptPath: PATH,
      toolName: fixture.expected.pending?.toolName ?? 'Bash'
    },
    dwarfId
  )
  const channel = new ObservedClaudeKeystrokeChannel({
    prompts,
    transcripts: tail,
    relay,
    log: new RecordingDiagnosticsLog()
  })
  const outcome = await channel.answerPermission(
    { dwarfId },
    fixture.expected.pending?.id ?? 'toolu_01KeystrokeBash',
    decision
  )
  return { outcome, tools }
}

describe('KeystrokeRelay parity with the legacy permissionKeystrokeFor (hook-keystroke 2.1.x)', () => {
  it('[ADR-012] the Host key map is the legacy one: Allow is 1, Deny is Esc', () => {
    for (const decision of ['allow', 'deny'] as const) {
      expect(permissionKeystrokeFor(decision)).toEqual(LEGACY_PERMISSION_KEYSTROKES[decision])
    }
  })

  it('[ADR-012] for every hook-keystroke fixture an in-app Allow or Deny presses exactly what the legacy permissionKeystrokeFor presses, or nothing', async () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15)
    for (const fixture of CASES) {
      const open = fixture.expected.pending?.kind === 'permission'
      for (const decision of ['allow', 'deny'] as const) {
        const legacyKey = LEGACY_PERMISSION_KEYSTROKES[decision]
        const win = await answer('win32', fixture, decision)
        const nix = await answer('linux', fixture, decision)
        const label = `${fixture.name} ${decision}`
        if (!open) {
          expect({ label, outcome: win.outcome }).toEqual({ label, outcome: { kind: 'not-open' } })
          expect({ label, spawns: win.tools.spawns.length + nix.tools.spawns.length }).toEqual({
            label,
            spawns: 0
          })
          continue
        }
        expect({ label, outcome: win.outcome }).toEqual({ label, outcome: { kind: 'accepted' } })
        expect({ label, stdin: [...win.tools.stdinOf.values()] }).toEqual({
          label,
          stdin: [powerShellStdinLine(windowsKeyWriteScript(PROCESS.pid, legacyKey)!)]
        })
        expect({ label, outcome: nix.outcome }).toEqual({ label, outcome: { kind: 'accepted' } })
        expect({ label, sent: nix.tools.spawns.at(-1)?.args }).toEqual({
          label,
          sent: tmuxKeyArgs('%7', legacyKey)
        })
      }
    }
  })
})
