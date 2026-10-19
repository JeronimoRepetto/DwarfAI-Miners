/**
 * The seeded forbidden values of the log redaction canary (17 §1.7, ADR-026 Verification, 18 C-27,
 * 14 §6.5). Every writer's canary test (Host, UI main, shims) feeds these values through its logging
 * entry points and asserts that none of them reaches a line.
 *
 * Every value is a fake assembled for the canary; none has ever been a real credential, name or path
 * of a real person. Test-only (R14): this file lives under `testing/` and the logging barrel does not
 * export it.
 *
 * `class` says which pure rule can recognise the value inside free text:
 * - `credential`: token-shaped, so `redactSecrets` removes it (ADR-026 item 5);
 * - `home-path`: a home directory, so the home replacement removes the person's name (ADR-026 item 5);
 * - `content`: anything a person or a provider said, a name, a mine path or a free-text secret. No
 *   redaction rule can recognise it. The shaped fields refuse it (pure half, `canary.test.ts`); in
 *   the free-string fields (`msg` sentences, `errCode`, `hostEpoch`, …) each writer keeps it out,
 *   proven by that writer's canary over its real inputs (17 §1.7; ADR-026 item 4).
 */
export type CanaryClass = 'credential' | 'home-path' | 'content'

export interface CanaryValue {
  readonly kind: string
  readonly class: CanaryClass
  readonly value: string
}

const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64)

export const CANARY_CORPUS: readonly CanaryValue[] = [
  { kind: 'custom dwarf name', class: 'content', value: 'Thorin Canarybeard' },
  {
    kind: 'prompt',
    class: 'content',
    value: 'Please refactor the canary billing module and email the report to finance'
  },
  {
    kind: 'message text',
    class: 'content',
    value: 'Here is the canary diff you asked for, with the tests updated'
  },
  { kind: 'OS notification title', class: 'content', value: 'Thorin Canarybeard needs you' },
  {
    kind: 'tool-output tail',
    class: 'content',
    value: 'npm ERR! code ELIFECYCLE\nnpm ERR! canary-app@1.0.0 build: `vite build`'
  },
  {
    kind: 'ask payload',
    class: 'content',
    value: '{"question":"Deploy canary-app to production?","options":["Allow","Deny"]}'
  },
  { kind: 'mine folder path', class: 'content', value: 'D:\\work\\canary-mine' },
  {
    kind: 'provider error text',
    class: 'content',
    value: 'invalid x-api-key for canary-org (provider stderr)'
  },
  { kind: 'OpenCode server password', class: 'content', value: 'canary horse battery staple' },
  {
    kind: 'sk- key',
    class: 'credential',
    value: 'sk-ant-api03-CANARYcanary0123456789CANARYcanary0123456789'
  },
  { kind: 'uiToken', class: 'credential', value: hex64('a1b2c3d4') },
  { kind: 'per-view token', class: 'credential', value: hex64('b2c3d4e5') },
  { kind: 'per-launch MCP credential', class: 'credential', value: hex64('c3d4e5f6') },
  { kind: 'claudeHookToken', class: 'credential', value: hex64('d4e5f6a7') },
  { kind: 'openCodePluginToken', class: 'credential', value: hex64('e5f6a7b8') },
  {
    kind: 'Windows home path',
    class: 'home-path',
    value: 'C:\\Users\\canary.user\\Documents\\notes.txt'
  },
  { kind: 'Linux home path', class: 'home-path', value: '/home/canaryuser/.ssh/id_ed25519' },
  {
    kind: 'macOS home path',
    class: 'home-path',
    value: '/Users/canaryuser/Library/Preferences/x.plist'
  }
]

/** The person-identifying part of each home-path value, which must never reach a line either. */
export const CANARY_HOME_NAMES: readonly string[] = ['canary.user', 'canaryuser']
