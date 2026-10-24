// Spike driver (AMENDMENT-29 validation run, 2026-10-24): runs the Host's OWN observed-subagent route
// against a real Claude Code lead terminal, from a script, not from the app. Windows only; not product
// code. The Host modules are bundled from src/ with the esbuild that vite already depends on, so what
// runs is exactly the adapters the Host composes (WindowsConsoleScreen, ConsoleTextDelivery,
// ClaudeSubagentConsoleSend over the kernel NodeProcessControl).
//
// Usage (the lead is a claude.exe pid; its identity is probed first, as observation records it):
//   node route.mjs screen <pid>                     the visible window as JSON rows, read through CONOUT$
//   node route.mjs keys <pid> <down|up|enter>...    navigation keys, a screen read before each
//   node route.mjs send <pid> <cwd> <agentId> <text>
//       the facts from the throwaway session's own files (its sidecar's description, the other
//       sidecars of its subagents folder as twins, the version of its newest record), then one send
//       through ClaudeSubagentConsoleSend; prints the outcome and every step the route took.
// It never prints a message or a transcript line beyond what it is asked to.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const src = (path) => JSON.stringify(join(ROOT, 'src', path).replaceAll('\\', '/'))

const ENTRY = `
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeProcessControl } from ${src('host/platform/process/NodeProcessControl.ts')}
import { NodeScheduler } from ${src('host/platform/clock/NodeScheduler.ts')}
import { WindowsConsoleScreen } from ${src('host/modules/conversation/adapters/observed-send/WindowsConsoleScreen.ts')}
import { ConsoleTextDelivery } from ${src('host/modules/conversation/adapters/observed-send/ConsoleTextDelivery.ts')}
import { ClaudeSubagentConsoleSend } from ${src('host/modules/conversation/adapters/observed-send/ClaudeSubagentConsoleSend.ts')}
import { readAgentConsole } from ${src('host/modules/conversation/adapters/observed-send/claudeAgentConsole.ts')}
import { descriptionOf, agentIdOfSidecar } from ${src('host/modules/observation/adapters/claude/subagents.ts')}

export async function main(argv) {
  const processes = new NodeProcessControl()
  const scheduler = new NodeScheduler({ onTaskError: (error) => console.error(error) })
  const deps = { processes, platform: process.platform, env: process.env, cwd: homedir(), scheduler }
  const screen = new WindowsConsoleScreen(deps)
  const [mode, pidText, ...rest] = argv
  const probed = await processes.probe(Number(pidText))
  if (typeof probed !== 'object') throw new Error('no such process: ' + probed)
  if (mode === 'screen') {
    const read = await screen.read(probed)
    console.log(JSON.stringify({ read: read.kind, parsed: read.kind === 'screen' ? readAgentConsole(read.lines) : null, rows: read.lines ?? [] }, null, 2))
    return
  }
  if (mode === 'keys') {
    for (const key of rest) console.log(key, await screen.press(probed, key))
    return
  }
  if (mode === 'send') {
    const [cwd, agentId, text] = rest
    const project = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    const sessionId = readdirSync(project).find((name) => /^[0-9a-f-]{36}\.jsonl$/.test(name)).slice(0, -6)
    const folder = join(project, sessionId, 'subagents')
    const description = descriptionOf(readFileSync(join(folder, 'agent-' + agentId + '.meta.json'), 'utf8'))
    let twins = 0
    for (const name of readdirSync(folder)) {
      const other = agentIdOfSidecar(name)
      if (other === null || other === agentId) continue
      if (descriptionOf(readFileSync(join(folder, name), 'utf8')) === description) twins += 1
    }
    const lines = readFileSync(join(folder, 'agent-' + agentId + '.jsonl'), 'utf8').trim().split('\\n')
    const version = JSON.parse(lines.at(-1)).version ?? null
    const steps = []
    const traced = {
      read: async (target) => { const r = await screen.read(target); steps.push('read ' + r.kind); return r },
      press: async (target, key) => { const o = await screen.press(target, key); steps.push('press ' + key + ' ' + o); return o }
    }
    const terminal = new ConsoleTextDelivery(deps)
    const typing = { write: async (target, words) => { const o = await terminal.write(target, words); steps.push('type ' + o); return o } }
    const route = new ClaudeSubagentConsoleSend({
      screen: traced,
      terminal: typing,
      platform: process.platform,
      facts: { subagentSendFactsOf: async () => ({ lead: probed, description, twins, version }) }
    })
    const sentAt = new Date().toISOString()
    const outcome = await route.send('00000000-0000-7000-8000-000000000029', text)
    console.log(JSON.stringify({ sessionId, agentId, description, twins, version, sentAt, outcome, steps }, null, 2))
    return
  }
  throw new Error('mode: screen | keys | send')
}
`

const viteRequire = createRequire(createRequire(import.meta.url).resolve('vite'))
const esbuild = viteRequire('esbuild')
const out = mkdtempSync(join(tmpdir(), 'dwarfai-route-'))
try {
  const bundle = join(out, 'route.bundle.mjs')
  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: bundle,
    alias: { '@dwarfai/contracts': join(ROOT, 'src', 'contracts', 'index.ts') },
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    },
    logLevel: 'error'
  })
  writeFileSync(join(out, 'package.json'), '{"type":"module"}')
  const { main } = await import(pathToFileURL(bundle).href)
  await main(process.argv.slice(2))
} finally {
  rmSync(out, { recursive: true, force: true })
}
process.exit(0)
