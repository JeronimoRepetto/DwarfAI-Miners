/**
 * The "Other…" command of the step-3d L9 case (testing strategy `17` §1.9; ISSUE-186): a program of the person's own
 * that the Host's `HostedCommandDriver` (`15` §4.11) starts with no shell. It holds no provider code and makes no
 * network call. It writes its pid to the file named by its one argument, so a case can name the process the Host
 * started, then keeps running until its stdin ends (the Host closes it when it ends the session) or it is killed.
 */
import { writeFileSync } from 'node:fs'

const pidFile = process.argv[2]
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid))

process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
// Keep the event loop alive even where stdin is closed from the start.
setInterval(() => undefined, 60_000)
