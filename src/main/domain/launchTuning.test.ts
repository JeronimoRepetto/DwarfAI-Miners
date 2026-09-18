import { describe, expect, it } from 'vitest'
import {
  PROVIDER_EFFORT_LEVELS,
  codexTuningArgs,
  parseLaunchTuning,
  resumeTuning
} from './launchTuning'

describe('PROVIDER_EFFORT_LEVELS', () => {
  /*
   * Verified live on 2026-09-07, and the two providers are verified from
   * different kinds of evidence, which is the reason the list is per provider
   * rather than one union.
   *
   * Claude Code 2.1.263 documents the levels in `claude --help` itself:
   * `--effort <level>  Effort level for the current session (low, medium,
   * high, xhigh, max)`. The Agent SDK agrees — `EffortLevel` is exactly those
   * five — so two independent sources say the same thing.
   */
  it("carries Claude's five documented levels, in the CLI's own order", () => {
    expect(PROVIDER_EFFORT_LEVELS.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  /*
   * Codex documents none in help at all — `codex --help` and `codex exec
   * --help` on codex-cli 0.153.4 mention no reasoning-effort levels, only the
   * `-c key=value` override that carries one. What DOES state them is the
   * model catalogue the CLI keeps under its own home, whose per-model
   * `supported_reasoning_levels` union across the eight models it listed on
   * this machine is these six. So Codex has one more level than Claude, and
   * folding the two lists together would refuse a level Codex accepts.
   */
  it("carries Codex's six, which are not Claude's five", () => {
    expect(PROVIDER_EFFORT_LEVELS.codex).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  /*
   * AMENDED for #282 (was: 'gives Antigravity none, because no launch can
   * reach it', asserting `[]` — Antigravity was absent from
   * LAUNCHABLE_PROVIDERS at #239's time. #237 gave it a launch path and #282
   * gives it a live model list; `agy --help` on CLI 1.1.26 documents its own
   * three levels, verified read-only on 2026-09-07.
   */
  it("carries Antigravity's own three documented levels, not borrowed from either neighbour", () => {
    expect(PROVIDER_EFFORT_LEVELS.antigravity).toEqual(['low', 'medium', 'high'])
  })

  /*
   * Issue #444. OpenCode is not in LAUNCHABLE_PROVIDERS, so no launch can ever
   * reach it — the same reasoning that gave Antigravity `[]` before #282, and
   * the same empty answer for the same reason.
   */
  it('gives OpenCode no effort levels, because no launch can reach it', () => {
    expect(PROVIDER_EFFORT_LEVELS.opencode).toEqual([])
  })
})

describe('parseLaunchTuning', () => {
  /*
   * The asymmetry `config-layering` states, applied to a launch request: an
   * ABSENT field is not an instruction, so it degrades to "leave it to the
   * CLI"; a PRESENT one that cannot be carried out is a legible instruction
   * that would be silently disobeyed, so it takes the whole request down.
   *
   * Which matters here more than in the config file, because the disobedience
   * is invisible: a launch that quietly dropped `effort: 'max'` starts a real
   * session at the CLI's own default and reports success, and nothing on
   * screen would ever say otherwise.
   */
  it('answers an empty request with no tuning at all, so the CLI keeps its defaults', () => {
    expect(parseLaunchTuning('claude', {})).toEqual({})
  })

  it('leaves both fields out when they are absent rather than defaulting them', () => {
    const tuning = parseLaunchTuning('claude', { mineId: 'mine-1', prompt: 'dig' })
    expect(tuning).not.toBeNull()
    expect(Object.keys(tuning!)).toEqual([])
  })

  it('carries a level the provider documents', () => {
    expect(parseLaunchTuning('claude', { effort: 'xhigh' })).toEqual({ effort: 'xhigh' })
  })

  it("carries a level of Codex's that Claude does not have", () => {
    expect(parseLaunchTuning('codex', { effort: 'ultra' })).toEqual({ effort: 'ultra' })
  })

  it('refuses the whole request for a level the chosen provider does not have', () => {
    // 'ultra' is real, and real for the OTHER provider. Checking against the
    // provider being launched is the whole point of a per-provider list.
    expect(parseLaunchTuning('claude', { effort: 'ultra' })).toBeNull()
  })

  it('refuses an invented level rather than dropping it', () => {
    expect(parseLaunchTuning('claude', { effort: 'maximum' })).toBeNull()
    expect(parseLaunchTuning('codex', { effort: 'ludicrous' })).toBeNull()
  })

  /*
   * AMENDED for #282 (was: 'refuses any effort for a provider that has
   * none', asserting `parseLaunchTuning('antigravity', { effort: 'high' })`
   * was null — Antigravity had no launch path at #239's time, so
   * PROVIDER_EFFORT_LEVELS.antigravity was `[]` and every effort refused.
   * #282 gives it its own three documented levels; this now asserts the
   * level it accepts, and the next test the levels it still does not.
   */
  it('carries a level Antigravity documents, now that #282 gives it a list', () => {
    expect(parseLaunchTuning('antigravity', { effort: 'high' })).toEqual({ effort: 'high' })
  })

  it('refuses a level Antigravity does not have, even though a neighbour does', () => {
    // 'xhigh' is real for Claude and Codex; Antigravity's own three stop at
    // 'high'. Checking against the provider being launched is the point of a
    // per-provider list.
    expect(parseLaunchTuning('antigravity', { effort: 'xhigh' })).toBeNull()
    expect(parseLaunchTuning('antigravity', { effort: 'ultra' })).toBeNull()
  })

  it('refuses a level that is not a string, whatever it looks like', () => {
    expect(parseLaunchTuning('claude', { effort: 3 })).toBeNull()
    expect(parseLaunchTuning('claude', { effort: ['high'] })).toBeNull()
    expect(parseLaunchTuning('claude', { effort: null })).toBeNull()
  })

  it('is case-sensitive, because the CLIs’ own enums are', () => {
    expect(parseLaunchTuning('claude', { effort: 'High' })).toBeNull()
  })

  it('trims a level, because a text box collects whitespace', () => {
    expect(parseLaunchTuning('claude', { effort: '  high  ' })).toEqual({ effort: 'high' })
  })

  /*
   * The model half is deliberately NOT closed here. No list of model names
   * lives in this repository — the guideline that model names come from the
   * provider live, never from source — so what a bare boundary can check is
   * the shape: a trimmed, non-empty string. Whether the name exists is the
   * question the catalogue answers, and it is asked where the catalogue is.
   *
   * Passed through unchanged, and never echoed back as a claim: nothing in the
   * launch verdict says which model started, because this side cannot know.
   */
  it('passes a model name through, trimmed', () => {
    expect(parseLaunchTuning('claude', { model: '  sonnet ' })).toEqual({ model: 'sonnet' })
  })

  it('passes a full wire id through unchanged, alias or not', () => {
    expect(parseLaunchTuning('claude', { model: 'claude-fable-5-1[1m]' })).toEqual({
      model: 'claude-fable-5-1[1m]'
    })
  })

  it('refuses a model that is present and empty, which is an instruction nobody can carry out', () => {
    expect(parseLaunchTuning('claude', { model: '   ' })).toBeNull()
    expect(parseLaunchTuning('claude', { model: '' })).toBeNull()
  })

  it('refuses a model that is not a string', () => {
    expect(parseLaunchTuning('claude', { model: { value: 'sonnet' } })).toBeNull()
  })

  it('carries both together when both are good', () => {
    expect(parseLaunchTuning('codex', { model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high'
    })
  })

  it('refuses the pair when only one half is wrong, rather than keeping the good half', () => {
    // Half a tuning is a launch nobody asked for: the model would be honoured
    // and the effort silently dropped, at a cost the user cannot see.
    expect(parseLaunchTuning('codex', { model: 'gpt-5.6-sol', effort: 'nope' })).toBeNull()
  })
})

describe('codexTuningArgs', () => {
  /*
   * Issue #462. One argv fragment, shared by the launch (`buildCodexLaunchArgs`)
   * and the resume (`buildCodexResumeArgs`), so the key can only be spelled in
   * one place. `-c model_reasoning_effort=<level>` is Codex's own config key
   * (`launch.ts:156-159`) — there is no `--effort` flag to fall back on, so a
   * typo here would silently be TOML nobody reads rather than a compile error.
   */
  it('carries nothing when neither field was asked for', () => {
    expect(codexTuningArgs({})).toEqual([])
  })

  it('carries the model as its own flag pair', () => {
    expect(codexTuningArgs({ model: 'gpt-5.6-sol' })).toEqual(['-m', 'gpt-5.6-sol'])
  })

  it('carries the effort as a config override, spelled exactly as Codex documents the key', () => {
    // The literal string is asserted, not just the tuple shape: a rename of
    // this key would fail here even though a `toEqual` on the pair alone
    // would happily pass a differently-spelled TOML key.
    expect(codexTuningArgs({ effort: 'high' })).toEqual(['-c', 'model_reasoning_effort=high'])
    expect(codexTuningArgs({ effort: 'high' })[1]).toContain('model_reasoning_effort=')
  })

  it('puts the model pair before the effort pair when both are present', () => {
    // The measured clap trap (`codexResume.test.ts:49-53`): Codex reads
    // options left to right, so the ORDER here is load-bearing, not cosmetic.
    expect(codexTuningArgs({ model: 'gpt-5.6-sol', effort: 'high' })).toEqual([
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high'
    ])
  })
})

describe('resumeTuning', () => {
  /*
   * Issue #462, D3b. Per-field precedence: what the launch explicitly asked
   * for wins; the thread's own observed settings fill in only the field the
   * launch left absent. A launch value already passed `parseLaunchTuning` at
   * the IPC boundary (`runtime.ts:3545-3548`), so it is trusted here without
   * re-checking it against `PROVIDER_EFFORT_LEVELS` — only the OBSERVED half
   * is validated, because it is Codex's own record rather than the person's
   * instruction, and unusable evidence is dropped rather than refused.
   */
  it('answers nothing when neither source names anything', () => {
    const tuning = resumeTuning(undefined, undefined)
    expect(tuning).toEqual({})
    expect(Object.keys(tuning)).toEqual([])
  })

  it('takes the launch pair whole when the launch named both', () => {
    expect(
      resumeTuning(
        { model: 'gpt-5.6-sol', effort: 'high' },
        { model: 'gpt-5.6-luna', effort: 'medium' }
      )
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
  })

  it('fills only the field the launch left absent, from the observed pair', () => {
    expect(
      resumeTuning({ model: 'gpt-5.6-sol' }, { model: 'gpt-5.6-luna', effort: 'medium' })
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
  })

  it('falls back to the observed pair entirely when the launch named nothing', () => {
    expect(resumeTuning(undefined, { model: 'gpt-5.6-luna', effort: 'medium' })).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'medium'
    })
  })

  it('drops an observed effort outside the codex list rather than refusing the whole pair', () => {
    expect(resumeTuning(undefined, { model: 'gpt-5.6-luna', effort: 'ludicrous' })).toEqual({
      model: 'gpt-5.6-luna'
    })
  })

  it('drops a blank or whitespace-only observed model', () => {
    expect(resumeTuning(undefined, { model: '   ', effort: 'medium' })).toEqual({
      effort: 'medium'
    })
    expect(resumeTuning(undefined, { model: '', effort: 'medium' })).toEqual({ effort: 'medium' })
  })

  it('passes a launch effort through unvalidated, because parseLaunchTuning already refused it at the boundary', () => {
    // 'ludicrous' would never survive parseLaunchTuning's own check, so a
    // launch tuning carrying it here can only mean the boundary already
    // accepted it for a provider this table has yet to grow for — resumeTuning
    // is not the second gate.
    expect(resumeTuning({ effort: 'ludicrous' }, undefined)).toEqual({ effort: 'ludicrous' })
  })
})
