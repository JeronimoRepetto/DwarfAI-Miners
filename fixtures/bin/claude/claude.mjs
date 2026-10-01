#!/usr/bin/env node
/**
 * `StubClaudeCli` (testing strategy `17` §1.9, §2.2): the E2E stand-in for the `claude` CLI. It holds no
 * provider code: it answers `--version` and replays a script (default: `claude-session-one-turn`) through the
 * shared engine in `../_kit/stubCli.mjs`. `claude.cmd` (Windows) and `claude` (POSIX) start it.
 */
import { runStubCli } from '../_kit/stubCli.mjs'

runStubCli({
  name: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  defaultScript: 'claude-session-one-turn'
})
