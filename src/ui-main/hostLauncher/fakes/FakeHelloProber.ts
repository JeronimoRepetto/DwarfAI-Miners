// The HelloProber double: answers each attempt from a script (or a function of the attempt's
// time) and records when each attempt was made. Never imported by production code (R14).
import type { HelloAnswer, HelloProber, LauncherClock } from '../ports'

export const UNREACHABLE: HelloAnswer = { kind: 'unreachable' }

export function helloOk(
  state: Extract<HelloAnswer, { kind: 'hello-ok' }>['state'] = 'ready'
): HelloAnswer {
  return { kind: 'hello-ok', state, jobStatus: 'none' }
}

export class FakeHelloProber {
  /** The clock time of every attempt, in order. */
  readonly attempts: number[] = []

  /** `answer` gets the attempt's time; the default endpoint has nothing listening. */
  constructor(
    private readonly clock: LauncherClock,
    public answer: (now: number) => HelloAnswer = () => UNREACHABLE
  ) {}

  readonly probe: HelloProber = () => {
    const now = this.clock.now()
    this.attempts.push(now)
    return Promise.resolve(this.answer(now))
  }
}
