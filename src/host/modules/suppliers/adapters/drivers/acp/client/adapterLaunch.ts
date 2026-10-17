// The argv a user-installed executable adapter is started with (ADR-029 row 8; issue #1360). The
// `InstallResolver` port is frozen (16 §4.4) and answers one path: for an npm-installed adapter on
// Windows that path is its `.js` / `.mjs` / `.cjs` entry, which the OS cannot start by itself, and
// R17 forbids `shell: true`. So the ACP adapter layer runs the entry with the person's own `node`,
// found through the same resolver (ADR-009 D5: one resolver, no bundled fallback): program `node`,
// first argument the entry. On macOS and Linux the resolved path is started as it is (an npm bin
// is an executable script with a shebang). No shell anywhere; the spawned root is the process
// whose identity the driver reports (ADR-014).

/** What to spawn: a program and the arguments that come before the driver's own. */
export interface LaunchTarget {
  readonly program: string
  readonly leadingArgs: readonly string[]
}

const SCRIPT_ENTRY = /\.(c|m)?js$/i

/**
 * The launch target of a resolved adapter path, or `null` when it needs `node` and none resolves.
 * `resolveNode` is the driver's install detection asked for `node`.
 */
export async function adapterLaunch(
  resolved: string,
  platform: NodeJS.Platform,
  resolveNode: () => Promise<string | null>
): Promise<LaunchTarget | null> {
  if (platform !== 'win32' || !SCRIPT_ENTRY.test(resolved)) {
    return { program: resolved, leadingArgs: [] }
  }
  const node = await resolveNode()
  return node === null ? null : { program: node, leadingArgs: [resolved] }
}
