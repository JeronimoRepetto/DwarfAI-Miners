#!/usr/bin/env node
/**
 * `StubOpenCodeCli` (testing strategy `17` §1.9, §2.2): the E2E stand-in for the `opencode` CLI. It holds no
 * provider code: it answers `--version` and replays a script (default: `opencode-session-one-turn`) through the
 * shared engine in `../_kit/stubCli.mjs`. `opencode.cmd` (Windows) and `opencode` (POSIX) start it.
 */
import { runStubCli } from '../_kit/stubCli.mjs'

runStubCli({
  name: 'opencode',
  homeEnv: 'XDG_DATA_HOME',
  defaultScript: 'opencode-session-one-turn'
})
