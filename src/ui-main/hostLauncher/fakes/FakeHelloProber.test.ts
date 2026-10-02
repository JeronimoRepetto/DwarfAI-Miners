import type { HelloAnswer } from '../ports'
import { runHelloProberContract, type EndpointScript } from '../testing/helloProber.contract'
import { FakeHelloProber } from './FakeHelloProber'
import { FakeLauncherClock } from './FakeLauncherClock'

/** The answer a script stands for: the double answers from its script. */
function answerOf(endpoint: EndpointScript): HelloAnswer {
  switch (endpoint.kind) {
    case 'nothing-listens':
      return { kind: 'unreachable' }
    case 'hello-ok':
      return { kind: 'hello-ok', state: endpoint.state, jobStatus: endpoint.jobStatus }
    case 'error-frame':
      return { kind: 'refused', code: endpoint.code }
    case 'silent':
      return { kind: 'no-answer' }
  }
}

runHelloProberContract('FakeHelloProber', (endpoint) => ({
  probe: new FakeHelloProber(new FakeLauncherClock(), () => answerOf(endpoint)).probe,
  passAnswerBound: () => {}
}))
