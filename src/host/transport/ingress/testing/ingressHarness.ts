// Test harness of the loopback ingress (ISSUE-133): the Claude hooks route over the real
// `node:http` listener on 127.0.0.1 and an OS-chosen port, the token check over the in-memory hash
// store, and recording doubles for every downstream port. Tokens are drawn at run time, so no token
// value is written into the repository. Never imported by production code (R14).
import { request, type IncomingHttpHeaders } from 'node:http'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import type { IntegrationState } from '../../../kernel/domain/values'
import type { ObservationControl } from '../../../modules/observation'
import { inMemoryChannelTokens } from '../../../modules/preferences/testing/inMemoryChannelTokens'
import { ChannelTokenCheck } from '../../auth/channelTokenCheck'
import type { ClaudeHookEvidence } from '../claudeHookPayload'
import { createClaudeHooksRoute, type ClaudeHookEvidenceSink } from '../claudeHooksRoute'
import { createHttpIngress, INGRESS_HOST, type HttpIngress } from '../httpIngress'
import type { IngressPortRecord } from '../ingressPort'

export const T0 = 1_750_000_000_000

/** `app_meta.ingress_port` in memory. */
export class InMemoryIngressPortRecord implements IngressPortRecord {
  writes: number[] = []
  constructor(public port: number | null = null) {}
  read(): number | null {
    return this.port
  }
  write(port: number): void {
    this.port = port
    this.writes.push(port)
  }
}

/** Every member of the observation driving port, recorded: only `nudge` may ever be called. */
export class RecordingObservationControl implements ObservationControl {
  readonly calls: Array<{ member: keyof ObservationControl; args: unknown[] }> = []
  start(): void {
    this.calls.push({ member: 'start', args: [] })
  }
  nudge(hint: Parameters<ObservationControl['nudge']>[0]): void {
    this.calls.push({ member: 'nudge', args: [hint] })
  }
  catchUp(): Promise<void> {
    this.calls.push({ member: 'catchUp', args: [] })
    return Promise.resolve()
  }
  stop(): void {
    this.calls.push({ member: 'stop', args: [] })
  }
  recordEnded(...args: Parameters<ObservationControl['recordEnded']>): void {
    this.calls.push({ member: 'recordEnded', args })
  }
  nudges(): unknown[] {
    return this.calls.filter((call) => call.member === 'nudge').map((call) => call.args[0])
  }
}

export interface HarnessOptions {
  evidence?: ClaudeHookEvidenceSink
  observation?: Pick<ObservationControl, 'nudge'>
}

export interface Harness {
  port: number
  token: string
  log: RecordingDiagnosticsLog
  clock: FakeClock
  channelTokens: ReturnType<typeof inMemoryChannelTokens>
  observation: RecordingObservationControl
  evidence: ClaudeHookEvidence[]
  setState(state: IntegrationState): void
  ingress: HttpIngress
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const channelTokens = inMemoryChannelTokens()
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(T0)
  const observation = new RecordingObservationControl()
  const evidence: ClaudeHookEvidence[] = []
  let state: IntegrationState = 'on-verified'
  const route = createClaudeHooksRoute({
    tokens: new ChannelTokenCheck({ tokens: channelTokens.store, log }),
    preferences: { integrationState: () => state },
    observation: options.observation ?? observation,
    evidence: options.evidence ?? { accept: (item) => void evidence.push(item) },
    log
  })
  const ingress = createHttpIngress({
    routes: [route],
    clock,
    log,
    portRecord: new InMemoryIngressPortRecord(),
    onPortChanged: () => undefined
  })
  const port = await ingress.start()
  const token = channelTokens.issue('claude-hooks', T0)
  return {
    port,
    token,
    log,
    clock,
    channelTokens,
    observation,
    evidence,
    setState: (next) => {
      state = next
    },
    ingress
  }
}

export interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

export interface PostOptions {
  path?: string
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  /** Leaves the request open after the body: the answer must come without the end. */
  keepOpen?: boolean
  /** Sends the body as many chunks with no Content-Length (chunked transfer). */
  chunked?: boolean
}

/** One request to the ingress on 127.0.0.1, on a fresh connection. */
export function post(port: number, options: PostOptions = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? ''
    const headers: Record<string, string> = { host: `${INGRESS_HOST}:${port}`, ...options.headers }
    if (options.chunked !== true && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    const req = request(
      {
        host: INGRESS_HOST,
        port,
        path: options.path ?? '/hooks/claude/event',
        method: options.method ?? 'POST',
        headers,
        agent: false,
        setHost: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
          req.destroy()
        })
      }
    )
    // A refusal may close the connection while the body is still being sent.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error)
    })
    if (options.chunked === true) {
      const buffer = Buffer.from(body)
      for (let at = 0; at < buffer.length; at += 16 * 1024) {
        req.write(buffer.subarray(at, at + 16 * 1024))
      }
    } else if (body.length > 0) {
      req.write(body)
    }
    if (options.keepOpen !== true) req.end()
  })
}

/** A Claude hook body as Claude Code relays it, with the placeholder user `j` (privacy-guard). */
export function hookBody(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: '/home/j/.claude/projects/-home-j-mine/session-1.jsonl',
    cwd: '/home/j/mine',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
    ...fields
  })
}
