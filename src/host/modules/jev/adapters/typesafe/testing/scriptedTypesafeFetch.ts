// A scripted stand-in for TypeSafe's `POST /v1/systemone`, handed to the SDK as its `fetch` (the SDK
// accepts a custom fetch, `TypeSafeClientConfig.fetch`): no network. It answers each question of the
// body it receives in the SDK's documented answer shapes, or plays the failure the script names, and
// records every call so a test can count what left the process and read what was sent. Test-only
// (R14).
import type { JevRouterScript } from '../../../testing/jevRouter.contract'

interface SentQuestion {
  type: 'noul' | 'choice' | 'score'
  criteria?: unknown
}

/** One request the SDK sent: the URL, the headers and the parsed JSON body. */
export interface SentTypesafeRequest {
  url: string
  headers: Record<string, string>
  body: { state?: unknown; model?: string; questions?: Record<string, SentQuestion> }
}

export interface ScriptedTypesafeFetch {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  sent: SentTypesafeRequest[]
}

/** A well-formed answer to every question the body asked (the SDK's `SystemOneResult`). */
export function answerFor(questions: Record<string, SentQuestion>): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      answers[name] = { type: 'noul', noul: 0.8 }
    } else if (question.type === 'choice') {
      const labels = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
      const probabilities = Object.fromEntries(
        labels.map((label, i) => [label, i === 0 ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])
      )
      answers[name] = { type: 'choice', choice: labels[0], confidence: 0.9, probabilities }
    } else {
      const levels = Array.isArray(question.criteria) ? question.criteria.length : 2
      const probabilities = Object.fromEntries(
        Array.from({ length: levels }, (_, i) => [String(i), i === 1 ? 1 : 0])
      )
      const legend = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), null]))
      answers[name] = { type: 'score', score: 1, confidence: 0.9, legend, probabilities }
    }
  }
  return { model: 'jev-latest', answers, usage: { input_tokens: 42, output_tokens: 7 } }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    out[name] = value
  })
  return out
}

export function scriptedTypesafeFetch(script: JevRouterScript): ScriptedTypesafeFetch {
  const sent: SentTypesafeRequest[] = []
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}'
    ) as SentTypesafeRequest['body']
    sent.push({ url: input, headers: headersOf(init), body })
    switch (script.kind) {
      case 'answers':
        return Promise.resolve(json(200, answerFor(body.questions ?? {})))
      case 'status':
        return Promise.resolve(json(script.status, { error: { message: 'scripted failure' } }))
      case 'network-error':
        return Promise.reject(new TypeError('fetch failed'))
      case 'invalid-body':
        return Promise.resolve(
          new Response('<html>not json</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
        )
      case 'hang':
        // Never answers; rejects only when the request is aborted, as the global fetch does.
        return new Promise((_, reject) => {
          const signal = init?.signal
          const abort = (): void => reject(signal?.reason ?? new Error('aborted'))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
    }
  }
  return { fetch, sent }
}
