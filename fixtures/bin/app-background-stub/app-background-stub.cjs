// A stub of the app's `--background` start (ISSUE-115; 17 §1.8: processes under test are stubs,
// never the real app or a provider CLI). The launcher under test starts it exactly as it starts the
// app: `<executable> <appArgs…> --background`, here `node app-background-stub.cjs --background`, with
// no shell. Plain CommonJS with Node built-ins only (process.getBuiltinModule), so it runs with no
// build.
//
// It reads the JSON file named by APP_BACKGROUND_STUB_CONFIG, written by the test before the spawn:
//   { "mode": "attach" | "exit", "exitCode": 3, "endpoint": "<pipe or socket path>",
//     "token": "<ui token>", "report": "<file>", "maxLifeMs": 60000 }
// - writes `report` first: its argv after the script, its parent pid, and whether
//   ELECTRON_RUN_AS_NODE and DWARFAI_HOST_DATA_DIR reached it (names only, never values);
// - `exit`: exits with `exitCode` at once, as an app that fails to start;
// - `attach`: connects to the Host endpoint and sends `hello {role:'notifier'}` in the seam-B frame
//   format (a 4-byte little-endian length, then the JSON; 14 §1.2), as the tray process does
//   (ADR-018 item 5), then stays alive until the Host closes the connection or `maxLifeMs` pass, so
//   a forgotten stub never outlives a run.
// Any load or run error exits 70 with one line on stderr; it never shows anything on screen.
'use strict'

const ERROR_EXIT = 70

function main() {
  const fs = process.getBuiltinModule('node:fs')
  const net = process.getBuiltinModule('node:net')
  const configPath = process.env.APP_BACKGROUND_STUB_CONFIG
  if (configPath === undefined) throw new Error('APP_BACKGROUND_STUB_CONFIG is not set')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  fs.writeFileSync(
    config.report,
    JSON.stringify({
      argv: process.argv.slice(2),
      ppid: process.ppid,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE !== undefined,
      hostDataDir: process.env.DWARFAI_HOST_DATA_DIR !== undefined
    })
  )

  if (config.mode === 'exit') {
    process.exit(config.exitCode)
  }

  const cap = setTimeout(() => process.exit(0), config.maxLifeMs ?? 60_000)
  const socket = net.connect(config.endpoint)
  socket.on('error', () => process.exit(1))
  socket.on('close', () => {
    clearTimeout(cap)
    process.exit(0)
  })
  socket.on('data', () => {}) // hello.ok and later frames: drained, not read
  socket.on('connect', () => {
    const json = Buffer.from(
      JSON.stringify({
        type: 'hello',
        endpointGeneration: 1,
        protocolVersion: config.protocolVersion,
        role: 'notifier',
        token: config.token,
        client: { appVersion: '0.0.0-stub', buildId: 'stub115', pid: process.pid }
      }),
      'utf8'
    )
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(json.length, 0)
    socket.write(Buffer.concat([prefix, json]))
  })
}

try {
  main()
} catch (error) {
  process.stderr.write(
    `app-background-stub: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(ERROR_EXIT)
}
