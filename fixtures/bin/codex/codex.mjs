#!/usr/bin/env node
/**
 * `StubCodexCli` (testing strategy `17` §1.9, §2.2): the E2E stand-in for the `codex` CLI. It holds no
 * provider code: it answers `--version` and replays a script (default: `codex-rollout-one-turn`) through the
 * shared engine in `../_kit/stubCli.mjs`. `codex.cmd` (Windows) and `codex` (POSIX) start it.
 */
import { runStubCli } from '../_kit/stubCli.mjs'

runStubCli({ name: 'codex', homeEnv: 'CODEX_HOME', defaultScript: 'codex-rollout-one-turn' })
