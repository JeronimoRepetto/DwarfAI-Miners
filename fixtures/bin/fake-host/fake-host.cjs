// A stub DwarfAI Host for the Host launcher's OS-lane tests (ISSUE-030; 17 §1.8: processes under
// test are stubs). The launcher starts it exactly as it starts the real Host: the app executable
// (Electron) with ELECTRON_RUN_AS_NODE=1, this file as the entry, and DWARFAI_HOST_DATA_DIR. Plain
// CommonJS with Node built-ins only (process.getBuiltinModule), so it runs under Electron-as-Node or
// Node with no build.
//
// It reads `<DWARFAI_HOST_DATA_DIR>/fake-host.json`, written by the test before the spawn:
//   { "endpoint": "<pipe or socket path>", "mode": "ready" | "migrating" | "elevated-refused" |
//     "silent", "migratingMs": 1000, "maxLifeMs": 120000 }
// and then behaves as the Host does at the seam the launcher sees (ADR-002 D3, D6; ADR-003 item 5):
// - `elevated-refused`: exits ELEVATED_REFUSED (65) at once;
// - binds the endpoint; the bind is the mutex: when the endpoint is in use it sends a `hello` to
//   the Host there and exits ALREADY_RUNNING (64) if that Host answers, 1 if nothing answers (a
//   stale POSIX socket file is removed and the bind tried again, once);
// - writes `<dataDir>/run/ui.token` after the bind, and answers each connection's first frame:
//   `hello.ok` for a hello with that token (state `ready`, or `migrating` for `migratingMs` first),
//   AUTH_FAILED otherwise; `silent` answers nothing;
// - writes `<dataDir>/fake-host-<pid>.json` with what the test checks: pid, epoch, whether
//   ELECTRON_RUN_AS_NODE and DWARFAI_HOST_DATA_DIR arrived, its working folder, the names (never
//   the values) of its environment, and the executable it runs on (ISSUE-031: the versioned copy);
// - exits on its own after `maxLifeMs` (default 120 s) so a forgotten stub never outlives a run.
// Exit codes match src/host/wiring/exitCodes.ts. Any load or run error exits 70 with a line on
// stderr; it never shows anything on screen.
'use strict'

const EXIT = { ALREADY_RUNNING: 64, ELEVATED_REFUSED: 65, NO_DATA_DIR: 66, FAILED: 1, ERROR: 70 }

function fail(error) {
  try {
    process.stderr.write(`fake-host: ${error && error.stack ? error.stack : String(error)}\n`)
  } finally {
    process.exit(EXIT.ERROR)
  }
}

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

try {
  main()
} catch (error) {
  fail(error)
}

function main() {
  // Started as a full Electron app (ELECTRON_RUN_AS_NODE lost): leave before any window can exist.
  if (process.type === 'browser') process.exit(71)

  const crypto = process.getBuiltinModule('node:crypto')
  const fs = process.getBuiltinModule('node:fs')
  const net = process.getBuiltinModule('node:net')
  const path = process.getBuiltinModule('node:path')

  const dataDir = process.env.DWARFAI_HOST_DATA_DIR
  if (!dataDir) process.exit(EXIT.NO_DATA_DIR)
  const control = JSON.parse(fs.readFileSync(path.join(dataDir, 'fake-host.json'), 'utf8'))
  const mode = control.mode || 'ready'
  setTimeout(() => process.exit(0), control.maxLifeMs || 120_000)
  if (mode === 'elevated-refused') process.exit(EXIT.ELEVATED_REFUSED)

  const runDir = path.join(dataDir, 'run')
  const tokenFile = path.join(runDir, 'ui.token')
  const startedAt = Date.now()
  const epoch = crypto.randomUUID()
  let token = null

  const frame = (message) => {
    const json = Buffer.from(JSON.stringify(message), 'utf8')
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(json.length, 0)
    return Buffer.concat([prefix, json])
  }

  /** Calls `onFrame` with the first complete frame read from `socket`. */
  const firstFrame = (socket, onFrame) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const length = buffered.readUInt32LE(0)
      if (buffered.length < 4 + length) return
      socket.off('data', onData)
      let message = null
      try {
        message = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'))
      } catch {
        message = null
      }
      onFrame(message)
    }
    socket.on('data', onData)
  }

  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    if (mode === 'silent') return
    firstFrame(socket, (message) => {
      if (!message || message.type !== 'hello' || message.token !== token) {
        socket.end(frame({ type: 'error', code: 'AUTH_FAILED' }))
        return
      }
      const migrating = mode === 'migrating' && Date.now() - startedAt < (control.migratingMs || 0)
      socket.write(
        frame({
          type: 'hello.ok',
          hostVersion: '0.0.0',
          buildId: 'fakehost',
          protocolVersion: message.protocolVersion,
          endpointGeneration: 1,
          epoch,
          state: migrating ? 'migrating' : 'ready',
          jobStatus: process.platform === 'win32' ? 'none' : 'n/a',
          capabilities: [],
          clientId: crypto.randomUUID()
        })
      )
    })
  })

  const onBound = () => {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    token = crypto.randomBytes(32).toString('hex')
    fs.rmSync(tokenFile, { force: true })
    fs.writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' })
    const report = {
      pid: process.pid,
      epoch,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
      dataDirArrived: process.env.DWARFAI_HOST_DATA_DIR === dataDir,
      cwd: process.cwd(),
      envNames: Object.keys(process.env).sort(),
      execPath: process.execPath
    }
    fs.writeFileSync(path.join(dataDir, `fake-host-${process.pid}.json`), JSON.stringify(report))
  }

  /** ADR-002 D3: is a Host answering `hello` on the endpoint in use? */
  const probeExisting = (onAnswer) => {
    const socket = net.connect(control.endpoint)
    const done = (answer) => {
      clearTimeout(timer)
      socket.destroy()
      onAnswer(answer)
    }
    const timer = setTimeout(() => done('no-hello'), 5_000)
    socket.on('error', (error) => done(error.code === 'ECONNREFUSED' ? 'stale' : 'no-hello'))
    socket.on('connect', () => {
      let existing = ''
      try {
        existing = fs.readFileSync(tokenFile, 'utf8').trim()
      } catch {
        existing = ''
      }
      firstFrame(socket, (message) => {
        const answered = message && (message.type === 'hello.ok' || message.type === 'error')
        done(answered ? 'answers-hello' : 'no-hello')
      })
      socket.write(
        frame({
          type: 'hello',
          endpointGeneration: 1,
          protocolVersion: 1,
          role: 'notifier',
          token: existing,
          client: { appVersion: '0.0.0', buildId: 'fakehost', pid: process.pid }
        })
      )
    })
  }

  let retried = false
  const bind = () => {
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.dirname(control.endpoint), { recursive: true, mode: 0o700 })
    }
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') fail(error)
      probeExisting((answer) => {
        if (answer === 'answers-hello') process.exit(EXIT.ALREADY_RUNNING)
        if (answer === 'stale' && process.platform !== 'win32' && !retried) {
          retried = true
          fs.rmSync(control.endpoint, { force: true })
          bind()
          return
        }
        process.exit(EXIT.FAILED)
      })
    })
    server.listen(control.endpoint, onBound)
  }
  bind()
}
