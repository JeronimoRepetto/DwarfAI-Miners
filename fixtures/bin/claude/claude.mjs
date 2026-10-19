#!/usr/bin/env node
/**
 * `StubClaudeCli` (testing strategy `17` §1.9, §2.2): the E2E stand-in for the `claude` CLI. It holds no
 * provider code: it answers `--version` and replays a script through the shared engine in
 * `../_kit/stubCli.mjs`. `claude.cmd` (Windows) and `claude` (POSIX) start it.
 *
 * Two default scripts, by how it is run: a `-p` (print mode) run or a `--help` probe is the
 * stream-json driver's (`claude-stream-json-simple-turn`, ISSUE-150: the driver's protocol fixture on
 * stdout, the probe fixture for `--help`); any other run writes the observed path's transcript
 * (`claude-session-one-turn`). `DWARFAI_STUB_CLAUDE_SCRIPT` still replaces either.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runStubCli } from '../_kit/stubCli.mjs'

/** The default script for one run of the stub, chosen from its argv. */
export function claudeScriptFor(argv) {
  return argv.includes('-p') || argv.includes('--help')
    ? 'claude-stream-json-simple-turn'
    : 'claude-session-one-turn'
}

const program = process.argv[1]
if (
  program !== undefined &&
  realpathSync(program) === realpathSync(fileURLToPath(import.meta.url))
) {
  runStubCli({
    name: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultScript: claudeScriptFor(process.argv.slice(2))
  })
}
