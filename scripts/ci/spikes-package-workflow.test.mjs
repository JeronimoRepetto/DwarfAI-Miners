// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check of the packaging spike lane (.github/workflows/spikes-package.yml; ISSUE-328; 17 §4). The workflow cannot
 * run here, so its text is read, comments left out so prose never satisfies an assertion.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const code = readFileSync(path.join(repoRoot, '.github', 'workflows', 'spikes-package.yml'), 'utf8')
  .replace(/\r\n/g, '\n')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')

const steps = code
  .slice(code.indexOf('\n    steps:\n'))
  .split(/\n {6}- /)
  .slice(1)

describe('packaging spike lane (ISSUE-328)', () => {
  it('[S-019-2, S-027-3] runs on a manual dispatch only, with contents: read and no secret or environment', () => {
    const triggers = code.slice(code.indexOf('\non:\n'), code.indexOf('\npermissions:\n'))
    expect(triggers).toMatch(/^\non:\n {2}workflow_dispatch:\n/)
    expect(triggers).not.toMatch(
      /\n {2}(push|pull_request|pull_request_target|schedule|workflow_run):/
    )
    expect(code).toContain('\npermissions:\n  contents: read\n')
    expect(code).not.toMatch(/permissions:\n(?: {2,}.*\n)*? {2,}\w[\w-]*: write/)
    expect(code).not.toContain('secrets.')
    expect(code).not.toMatch(/\n {4}environment:/)
  })

  it('[S-019-2] pins every action by commit SHA and installs one exact pnpm version, frozen', () => {
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((match) => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, action).toMatch(/@[0-9a-f]{40}$/)
    expect(code).toMatch(/\n {10}version: \d+\.\d+\.\d+\n/)
    expect(code).toContain('run: pnpm install --frozen-lockfile')
  })

  it('[S-008-1] scans the lockfile for provider binaries in the step right before every packaging step', () => {
    const packaging = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) =>
        /\n\s+(?:run: |)(?:pnpm package|pnpm exec electron-builder)/.test(`\n${step}`)
      )
    expect(packaging.length).toBeGreaterThanOrEqual(3)
    for (const { step, index } of packaging) {
      expect(steps[index - 1], step.split('\n')[0]).toContain(
        'run: node scripts/release/lockfile-provider-scan.mjs'
      )
    }
  })

  it('[S-019-3, SP-03] uploads only the evidence folder, kept at most seven days, and publishes nothing', () => {
    const uploads = steps.filter((step) => step.includes('actions/upload-artifact@'))
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toContain('path: spike-evidence/')
    const days = Number(uploads[0].match(/retention-days: (\d+)/)?.[1])
    expect(days).toBeGreaterThan(0)
    expect(days).toBeLessThanOrEqual(7)
    expect(code).not.toMatch(/--publish (?!never)|gh release|softprops|action-gh-release/)
    for (const step of steps.filter((s) => /electron-builder|pnpm package/.test(s))) {
      expect(step).not.toContain('--publish always')
    }
  })
})
