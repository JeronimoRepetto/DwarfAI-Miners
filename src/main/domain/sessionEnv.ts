/**
 * The environment a mine's own child process gets, with `PWD` pinned to the
 * `cwd` this app is about to spawn it in (#640).
 *
 * OpenCode 1.18.32's own `run` takes a NEW session's directory from `PWD`,
 * never from the process's real cwd — measured live: the same `opencode run`
 * landed in `<repo-checkout>` with an inherited `PWD` set to it and in
 * `<mine>` with `PWD` unset, the process cwd identical both times. Whenever
 * this app itself was started from a shell, its own `PWD` survives on every
 * child's inherited environment (`buildRelayEnv` in textDelivery/relay.ts
 * only ever touches PATH), and that stale value silently overrides the mine
 * a session was launched in.
 *
 * Set unconditionally, for every provider and every session-shaped spawn —
 * never gated on `provider === 'opencode'`. A CLI that reads its own real cwd
 * (Claude, Codex, Antigravity) never looks at this key, so it costs nothing
 * there, and one product on three platforms means this one env-shaping rule
 * runs for all of them rather than a per-provider branch reproducing it only
 * where today's evidence happens to show it.
 *
 * A NEW object, never a mutation of `env` — this app's own `process.env`
 * must stay exactly what the OS handed it.
 */
export function withSessionPwd(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  return { ...env, PWD: cwd }
}
